import { createServer, type Server, type Socket } from 'node:net'
import { z } from 'zod'
import { APPROVAL_TOOL_NAME } from '@shared/run'

/** One tool call the agent is asking to be allowed, in Ask mode. */
export interface ApprovalRequest {
  /** The Harness's own tool-use id, which the answer is addressed to. */
  id: string
  tool: string
  input: Record<string, unknown>
}

/**
 * The answer, in the shape the Harness expects back
 * (`.scratch/research/claude-code-permissions-and-protocol.md`): an allow
 * carries the input the tool should run with, a deny carries what the agent
 * is told instead.
 */
export type ApprovalAnswer =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

interface ToolHostCallbacks {
  onActivity(kind: 'allowed' | 'blocked' | 'output', summary: string): void | Promise<void>
  onStop(summary: string): void
  /** Structured answers the Harness offered for the current question. */
  onChoices(question: string, options: { label: string; value: string }[]): void
  /**
   * A request to be shown to the person. It is answered later through
   * `resolveApproval`, however long that takes: a Run blocked on an Approval
   * Request is blocked precisely until somebody decides.
   */
  onApproval(request: ApprovalRequest): void | Promise<void>
}

/**
 * What one tool call decided, and how the Run's activity records it. There is
 * exactly one tool, so this is a description of its outcome, not a policy.
 */
interface ToolOutcome {
  decision: 'allow' | 'block' | 'stop'
  activity: { kind: 'allowed' | 'blocked'; summary: string }
}

interface RpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: unknown
}

const callSchema = z.object({
  name: z.enum(['offer_response_options', APPROVAL_TOOL_NAME]),
  arguments: z.record(z.unknown()).default({})
})

/** The exact `tools/call` arguments Claude Code sends when it asks. */
const approvalArgumentsSchema = z.object({
  tool_name: z.string().min(1).max(200),
  input: z.record(z.unknown()).default({}),
  tool_use_id: z.string().min(1).max(200).optional()
})

const choiceArgumentsSchema = z.object({
  question: z.string().max(2_000).default(''),
  options: z
    .array(z.object({ label: z.string().min(1).max(200), value: z.string().min(1).max(2_000) }))
    .min(1)
    .max(12)
})

/** What the host advertises with no Approval Requests to serve. */
const BASE_TOOLS = [
  tool(
    'offer_response_options',
    'Offer the person structured answers to the current question. They may always write their own instead.',
    {
      question: { type: 'string' },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, value: { type: 'string' } },
          required: ['label', 'value']
        }
      }
    },
    ['question', 'options']
  )
]

/**
 * The tool Ask is served on. It is advertised only for a Run that asks: in Full
 * access nothing routes permission through it, so a model that called it would
 * block its own Run behind a request nobody was expecting.
 */
const APPROVAL_TOOL = tool(
  APPROVAL_TOOL_NAME,
  'Answers an Approval Request in Ask mode. The Harness calls this itself before a tool it needs consent for; never call it directly.',
  {
    tool_name: { type: 'string' },
    input: { type: 'object' },
    tool_use_id: { type: 'string' }
  },
  ['tool_name', 'input']
)

/**
 * Main-owned, capability-socket MCP host. It adds the tool no Harness offers
 * natively — structured response options — alongside the Harness's own tools,
 * and, for a Run in Ask, serves the Approval Requests that mode produces. It
 * mediates nothing else.
 */
export class ToolHost {
  private server: Server | undefined
  private stopping = false
  private unreadableChoices = 0
  private operationQueue: Promise<void> = Promise.resolve()
  /** Requests waiting on a person, by the id the answer is addressed to. */
  private readonly approvals = new Map<string, (answer: ApprovalAnswer) => void>()
  private readonly sockets = new Set<Socket>()
  private unidentifiedApprovals = 0

  constructor(
    private readonly options: {
      socketPath: string
      capabilityToken: string
      /** True for a Run in Ask, which is the only Run that has any to serve. */
      servesApprovals: boolean
      callbacks: ToolHostCallbacks
      operationLimitMs?: number
      beforeOperation?: () => Promise<void>
    }
  ) {}

  async start(): Promise<void> {
    this.server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(this.options.socketPath, () => resolve())
    })
  }

  /**
   * Answers one outstanding request, and reports whether there was one. A
   * second answer to the same request changes nothing: the agent has already
   * been told.
   */
  resolveApproval(id: string, answer: ApprovalAnswer): boolean {
    const pending = this.approvals.get(id)
    if (!pending) return false
    this.approvals.delete(id)
    pending(answer)
    return true
  }

  /** Whether anything is still waiting on a person, which is what blocks a Run. */
  hasOutstandingApprovals(): boolean {
    return this.approvals.size > 0
  }

  /** Whether this particular request is still waiting to be answered. */
  hasOutstandingApproval(id: string): boolean {
    return this.approvals.has(id)
  }

  async close(): Promise<void> {
    // Whatever is still outstanding is declined rather than left hanging: the
    // Harness is blocked in a tool call, and a socket closing under it is not
    // an answer it can act on.
    for (const [id] of this.approvals) {
      this.resolveApproval(id, {
        behavior: 'deny',
        message: 'This Run ended before the request was answered'
      })
    }
    if (!this.server) return
    // One turn of the loop, so those refusals are actually written before the
    // connection carrying them is dropped.
    await new Promise<void>((resolve) => setImmediate(resolve))
    // The server only finishes closing once nothing is connected to it, so a
    // Harness still holding the socket would otherwise hold up the whole Run's
    // cleanup. Its work is over by now either way.
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve, reject) =>
      this.server?.close((error) => (error ? reject(error) : resolve()))
    )
    this.server = undefined
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    socket.setEncoding('utf8')
    let pending = ''
    let authenticated = false
    socket.on('data', (chunk: string) => {
      pending += chunk
      for (;;) {
        const boundary = pending.indexOf('\n')
        if (boundary < 0) break
        const line = pending.slice(0, boundary)
        pending = pending.slice(boundary + 1)
        if (!line.trim()) continue
        if (!authenticated) {
          authenticated = this.isAuthenticated(line)
          if (!authenticated) socket.destroy()
          continue
        }
        this.operationQueue = this.operationQueue
          .then(() => this.handleLine(socket, line))
          .catch(() => undefined)
      }
    })
  }

  private isAuthenticated(line: string): boolean {
    try {
      return (
        z.object({ appCapability: z.string() }).parse(JSON.parse(line)).appCapability ===
        this.options.capabilityToken
      )
    } catch {
      return false
    }
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let request: RpcRequest
    try {
      request = z
        .object({
          jsonrpc: z.literal('2.0'),
          id: z.union([z.string(), z.number()]).optional(),
          method: z.string(),
          params: z.unknown().optional()
        })
        .parse(JSON.parse(line))
    } catch {
      this.respond(socket, null, undefined, { code: -32700, message: 'Invalid request' })
      return
    }
    if (request.id === undefined) return
    if (request.method === 'initialize') {
      this.respond(socket, request.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'app-tools', version: '1.0.0' }
      })
      return
    }
    if (request.method === 'tools/list') {
      this.respond(socket, request.id, {
        tools: this.options.servesApprovals ? [...BASE_TOOLS, APPROVAL_TOOL] : BASE_TOOLS
      })
      return
    }
    if (request.method !== 'tools/call') {
      this.respond(socket, request.id, undefined, { code: -32601, message: 'Method not found' })
      return
    }
    const parsed = callSchema.safeParse(request.params)
    if (!parsed.success) {
      const summary = 'Blocked an unsupported tool call'
      await this.options.callbacks.onActivity('blocked', summary)
      if (!this.stopping) {
        this.stopping = true
        this.options.callbacks.onStop(summary)
      }
      this.respond(socket, request.id, toolError('Invalid tool input'))
      return
    }
    if (parsed.data.name === APPROVAL_TOOL_NAME) {
      if (!this.options.servesApprovals) {
        // Nothing routes permission through this host in Full access, so a
        // call here can only be the model reaching for a tool it was not
        // offered. Answering it would block a Run nobody asked to block.
        const summary = 'Blocked an approval this Run does not use'
        await this.options.callbacks.onActivity('blocked', summary)
        this.respond(socket, request.id, toolError(summary))
        return
      }
      // Deliberately off the serial queue and outside the wall limit: this call
      // is waiting on a person, and the sixty seconds that bound a tool call
      // are not how long somebody is allowed to think.
      void this.approve(socket, request.id, parsed.data.arguments)
      return
    }
    await this.options.callbacks.onActivity('output', `Tool call started: ${parsed.data.name}`)
    try {
      const outcome = await this.withDeadline((signal) => this.call(parsed.data.arguments, signal))
      await this.options.callbacks.onActivity(outcome.activity.kind, outcome.activity.summary)
      if (outcome.decision === 'stop' && !this.stopping) {
        this.stopping = true
        this.options.callbacks.onStop(outcome.activity.summary)
      }
      this.respond(
        socket,
        request.id,
        outcome.decision === 'allow' ? toolText('offered') : toolError(outcome.activity.summary)
      )
    } catch (error) {
      const summary =
        error instanceof OperationTimeoutError
          ? 'The tool call exceeded the 60-second wall limit'
          : 'The tool call failed safely'
      await this.options.callbacks.onActivity('blocked', summary)
      if (!this.stopping) {
        this.stopping = true
        this.options.callbacks.onStop(summary)
      }
      this.respond(socket, request.id, toolError(summary))
    }
  }

  /**
   * One Approval Request, from the agent asking to the person answering.
   * The reply is the Harness's own decision shape, carried as tool text.
   */
  private async approve(
    socket: Socket,
    id: string | number,
    args: Record<string, unknown>
  ): Promise<void> {
    const parsed = approvalArgumentsSchema.safeParse(args)
    if (!parsed.success) {
      // A request the app cannot read is one it cannot put to anybody, so it
      // is declined rather than approved by default.
      const summary = 'Declined an unreadable approval request'
      await this.options.callbacks.onActivity('blocked', summary)
      this.respond(socket, id, toolText(JSON.stringify({ behavior: 'deny', message: summary })))
      return
    }
    // The Harness sends its tool-use id; without one the request still needs
    // an identity for the answer to be addressed to.
    const approvalId = parsed.data.tool_use_id ?? `approval-${String(++this.unidentifiedApprovals)}`
    const answer = await new Promise<ApprovalAnswer>((resolve) => {
      this.approvals.set(approvalId, resolve)
      void Promise.resolve(
        this.options.callbacks.onApproval({
          id: approvalId,
          tool: parsed.data.tool_name,
          input: parsed.data.input
        })
      ).catch(() => {
        // The request could not be shown, so nobody can answer it. Declining
        // beats a Run that waits forever on a prompt that never appeared.
        this.resolveApproval(approvalId, {
          behavior: 'deny',
          message: 'The app could not show this request, so it was not approved'
        })
      })
    })
    this.respond(
      socket,
      id,
      toolText(
        JSON.stringify(
          answer.behavior === 'allow'
            ? { behavior: 'allow', updatedInput: answer.updatedInput ?? parsed.data.input }
            : answer
        )
      )
    )
  }

  private async call(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
    await this.options.beforeOperation?.()
    signal.throwIfAborted()
    // Offering answers touches nothing: no path, no process, no new authority.
    // This host is the only place that sees the arguments, so it is what tells
    // the Conversation about them.
    const offered = choiceArgumentsSchema.safeParse(args)
    if (!offered.success) {
      // Options the app cannot read are not a menu it can trust; the person
      // keeps answering by typing. A Harness that keeps offering unreadable
      // menus is not going to start making sense, so the third one ends the Run.
      this.unreadableChoices += 1
      return {
        decision: this.unreadableChoices >= 3 ? 'stop' : 'block',
        activity: { kind: 'blocked', summary: 'Blocked unreadable Suggested Responses' }
      }
    }
    this.options.callbacks.onChoices(offered.data.question, offered.data.options)
    return {
      decision: 'allow',
      activity: { kind: 'allowed', summary: 'Offered Suggested Responses' }
    }
  }

  private withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
        reject(new OperationTimeoutError())
      }, this.options.operationLimitMs ?? 60_000)
      void operation(controller.signal).then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error('The tool call failed'))
        }
      )
    })
  }

  private respond(
    socket: Socket,
    id: string | number | null,
    result?: unknown,
    error?: { code: number; message: string }
  ): void {
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) })}\n`)
  }
}

class OperationTimeoutError extends Error {}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return { name, description, inputSchema: { type: 'object', properties, required } }
}

function toolText(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }] }
}

function toolError(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true }
}
