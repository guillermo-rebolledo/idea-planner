import { createServer, type Server, type Socket } from 'node:net'
import { z } from 'zod'

interface ToolHostCallbacks {
  onActivity(kind: 'allowed' | 'blocked' | 'output', summary: string): void | Promise<void>
  onStop(summary: string): void
  /** Structured answers the Harness offered for the current question. */
  onChoices(question: string, options: { label: string; value: string }[]): void
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
  name: z.enum(['offer_response_options']),
  arguments: z.record(z.unknown()).default({})
})

const choiceArgumentsSchema = z.object({
  question: z.string().max(2_000).default(''),
  options: z
    .array(z.object({ label: z.string().min(1).max(200), value: z.string().min(1).max(2_000) }))
    .min(1)
    .max(12)
})

const TOOL_DEFINITIONS = [
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
 * Main-owned, capability-socket MCP host. It adds the one tool no Harness
 * offers natively — structured response options — alongside the Harness's own
 * tools. It mediates nothing else.
 */
export class ToolHost {
  private server: Server | undefined
  private stopping = false
  private unreadableChoices = 0
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: {
      socketPath: string
      capabilityToken: string
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

  async close(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve, reject) =>
      this.server?.close((error) => (error ? reject(error) : resolve()))
    )
    this.server = undefined
  }

  private accept(socket: Socket): void {
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
      this.respond(socket, request.id, { tools: TOOL_DEFINITIONS })
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
