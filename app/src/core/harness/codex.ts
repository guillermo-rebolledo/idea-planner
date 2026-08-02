import { z } from 'zod'
import {
  redactCredentials,
  type HarnessEvent,
  type HarnessFailureCategory
} from '@shared/conversation'
import type { StandingApprovalKind } from '@shared/approval'
import type { CodexLaunch } from '@shared/conversation'
import type { HarnessId } from '@shared/readiness'
import { parseCodexPatch } from './diff'
import type { AskForApproval } from './codex-protocol/v2/AskForApproval'
import type { SandboxMode } from './codex-protocol/v2/SandboxMode'
import type { ThreadResumeParams } from './codex-protocol/v2/ThreadResumeParams'
import type { ThreadStartParams } from './codex-protocol/v2/ThreadStartParams'
import type { TurnStartParams } from './codex-protocol/v2/TurnStartParams'

/**
 * Harness Adapters translate one Harness's protocol into normalized events.
 * Everything downstream — persistence, presentation, recovery — reads only the
 * normalized contract, so a Harness protocol change stays inside its Adapter.
 *
 * Codex is answered as well as read: its protocol is an exchange rather than a
 * broadcast, so an Adapter also produces frames to send back. Claude's produces
 * none, and says so by handing back nothing.
 */
export interface HarnessAdapter {
  readonly harness: HarnessId
  /** Consumes a raw stdout chunk and returns the events it completed. */
  ingest(chunk: string): HarnessEvent[]
  /** Reports whatever a truncated final line implies at end of stream. */
  flush(): HarnessEvent[]
  /**
   * Frames the Harness is owed, produced by opening the Adapter or by
   * ingesting. Draining hands each over exactly once; writing them is Main's
   * job, because Main is the only part of the app that speaks to a process.
   */
  takeOutgoing(): string[]
  /**
   * Answers one Approval Request the Harness raised in-band, and reports
   * whether there was one to answer. Claude raises none here — its approvals
   * arrive on the app's own MCP socket — so its Adapter always says no.
   */
  answerApproval(approvalId: string, answer: ApprovalAnswer): boolean
  /** Asks the Harness to end the turn it is running, if it can be asked. */
  interrupt(): void
}

/**
 * What the person decided, in the app's terms. Each Adapter turns it into
 * whatever its own Harness accepts.
 */
export interface ApprovalAnswer {
  allow: boolean
  /** Grant the rule the request proposed, so it stops being asked. */
  remember: boolean
}

/**
 * The contract is generated from the installed binary, so this is where a
 * protocol change becomes a compile error rather than a silent rejection at
 * runtime: the values the app sends must still be ones the Harness declares.
 */
type PolicyHolds = CodexLaunch['approvalPolicy'] extends AskForApproval ? true : never
type SandboxHolds = CodexLaunch['sandbox'] extends SandboxMode ? true : never
const GENERATED_CONTRACT_HOLDS: [PolicyHolds, SandboxHolds] = [true, true]
void GENERATED_CONTRACT_HOLDS

/** The JSON-RPC ids this Adapter uses, in the order it sends them. */
const INITIALIZE_ID = 1
const THREAD_ID = 2
const TURN_ID = 3
const INTERRUPT_ID = 4

const responseSchema = z.object({
  id: z.number(),
  result: z.record(z.unknown()).optional(),
  error: z.object({ message: z.string().default('') }).optional()
})

const notificationSchema = z.object({
  method: z.string().min(1),
  params: z.record(z.unknown()).default({})
})

/** One file Codex changed, with the patch it computed for it. */
const changeSchema = z.object({
  path: z.string().min(1),
  diff: z.string().default('')
})

const itemSchema = z.object({
  type: z.string().default(''),
  id: z.string().min(1).max(200).default('item'),
  text: z.string().optional(),
  command: z.string().optional(),
  aggregatedOutput: z.string().nullable().optional(),
  exitCode: z.number().nullable().optional(),
  changes: z.array(changeSchema).optional(),
  summary: z.array(z.string()).optional()
})

const tokenUsageSchema = z.object({
  total: z.object({
    totalTokens: z.number().int().nonnegative().default(0),
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0)
  }),
  modelContextWindow: z.number().int().positive().nullable().default(null)
})

const threadSchema = z.object({ id: z.string().min(1).max(200) })

/** Something Codex is asking the app for, and waiting on an answer to. */
const requestSchema = z.object({
  id: z.union([z.number(), z.string()]),
  method: z.string().min(1),
  params: z.record(z.unknown()).default({})
})

/**
 * An Approval Request, as Codex raises it. The command form carries the prefix
 * Codex computed for a Standing Approval, so the app never guesses one.
 */
const approvalParamsSchema = z.object({
  itemId: z.string().min(1).max(200).default('item'),
  command: z.string().optional(),
  cwd: z.string().optional(),
  reason: z.string().nullable().optional(),
  proposedExecpolicyAmendment: z.array(z.string().min(1)).nullable().optional()
})

/** The two requests this app answers; anything else is refused out loud. */
const APPROVAL_METHODS: Record<string, StandingApprovalKind> = {
  'item/commandExecution/requestApproval': 'command',
  'item/fileChange/requestApproval': 'edit'
}

/**
 * Protocol this Adapter understands and deliberately shows nothing for, so
 * genuinely unknown protocol stays distinguishable from what was skipped.
 * `turn/diff/updated` is the whole turn's diff, which the Conversation already
 * holds file by file.
 */
const IGNORED_METHODS = new Set([
  'thread/started',
  'thread/status/changed',
  'turn/started',
  'turn/diff/updated',
  'turn/plan/updated',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/commandExecution/outputDelta',
  'item/plan/delta',
  'hook/started',
  'hook/completed',
  'mcpServer/startupStatus/updated',
  'account/rateLimits/updated',
  'account/updated',
  'remoteControl/status/changed',
  'model/rerouted',
  'configWarning',
  'deprecationNotice'
])

/** Items worth showing the moment they begin rather than when they end. */
const STARTED_ITEMS = new Set(['commandExecution'])

const UNREADABLE: HarnessEvent = { type: 'unsupported', detail: 'unreadable protocol line' }

/**
 * `codex app-server` speaks newline-delimited JSON-RPC 2.0 over stdio. The
 * exchange is fixed: initialize, then start or resume a Harness Thread, then
 * start one turn, then read what that turn produces.
 *
 * It replaced `codex exec --json`, which could carry neither approvals nor
 * diffs and so could support neither Ask mode nor an inline change — both
 * verified against the installed binary and recorded in
 * `.scratch/research/codex-permissions-and-protocol.md`.
 */
export function createCodexAdapter(launch?: CodexLaunch): HarnessAdapter {
  let pending = ''
  const outgoing: string[] = []
  /** Assistant text so far, by item, because deltas arrive in pieces. */
  const messages = new Map<string, string>()
  /** Requests Codex is blocked on, by the id its answer is addressed to. */
  const pendingApprovals = new Map<string, StandingApprovalKind>()
  /** The prefix Codex proposed for each, so its own amendment can be sent back. */
  const proposedPrefixes = new Map<string, string[]>()
  let thread: string | null = null
  let turn: string | null = null

  const send = (message: Record<string, unknown>): void => {
    outgoing.push(JSON.stringify({ jsonrpc: '2.0', ...message }))
  }

  // Codex says nothing until it is spoken to, so the opening frame is produced
  // when the Adapter is made rather than in answer to anything.
  if (launch) {
    send({
      id: INITIALIZE_ID,
      method: 'initialize',
      params: { clientInfo: { name: 'argos', title: 'Argos', version: '0.1.0' } }
    })
  }

  function startThread(): void {
    if (!launch) return
    send({ method: 'initialized', params: {} })
    const params: ThreadStartParams = {
      cwd: launch.cwd,
      approvalPolicy: launch.approvalPolicy,
      sandbox: launch.sandbox,
      // The Skill for this Run, and nothing written into the person's own
      // instruction files.
      developerInstructions: launch.developerInstructions,
      config: { model_reasoning_effort: launch.effort },
      threadSource: 'argos',
      ...(launch.model ? { model: launch.model } : {})
    }
    if (launch.resumeThreadId) {
      // Resume declares its own parameters: the thread's source is fixed when
      // it is started and is not among them.
      const { threadSource: _source, ...shared } = params
      const resume: ThreadResumeParams = { ...shared, threadId: launch.resumeThreadId }
      send({ id: THREAD_ID, method: 'thread/resume', params: resume })
      return
    }
    send({ id: THREAD_ID, method: 'thread/start', params })
  }

  function startTurn(threadId: string): void {
    if (!launch) return
    const params: TurnStartParams = {
      threadId,
      // `text_elements` marks spans a UI drew in the text. There are none: the
      // message is what the person typed. The generated contract requires the
      // field, so it is sent empty rather than omitted.
      input: [{ type: 'text', text: launch.prompt, text_elements: [] }]
    }
    send({ id: TURN_ID, method: 'turn/start', params })
  }

  /**
   * A request Codex is blocked on. An Approval Request becomes one the person
   * answers; anything else is refused out loud, because Codex waits on a
   * server request until it is replied to and silence is a Run that hangs
   * rather than one that says what it could not do.
   */
  function consumeRequest(raw: z.infer<typeof requestSchema>): HarnessEvent[] {
    const kind = APPROVAL_METHODS[raw.method]
    if (!kind) {
      send({ id: raw.id, error: { code: -32601, message: `Argos cannot answer ${raw.method}` } })
      return [
        { type: 'unsupported', detail: `Unanswerable Codex request: ${raw.method}`.slice(0, 200) }
      ]
    }
    const params = approvalParamsSchema.safeParse(raw.params)
    if (!params.success) {
      send({ id: raw.id, error: { code: -32602, message: 'Argos could not read this request' } })
      return [protocolFailure('Unreadable Codex approval request')]
    }
    const approvalId = String(raw.id)
    pendingApprovals.set(approvalId, kind)
    // The prefix Codex computed for a Standing Approval, kept as it was sent.
    // Ticket 08 synthesises one for Claude only because Claude offers none.
    const proposed = params.data.proposedExecpolicyAmendment
    if (proposed?.length) proposedPrefixes.set(approvalId, proposed)
    const summary =
      params.data.command ??
      params.data.reason ??
      (kind === 'edit' ? `Change files in ${params.data.cwd ?? 'this Project'}` : 'Run a command')
    return [
      {
        type: 'approval-request',
        id: approvalId,
        tool: kind === 'command' ? 'Command' : 'File change',
        summary: redactCredentials(summary).slice(0, 2_000),
        detail: redactCredentials(JSON.stringify(raw.params, null, 2)),
        proposedRule:
          kind === 'command' && proposed?.length
            ? { harness: 'codex', kind, pattern: proposed }
            : null
      }
    ]
  }

  function consumeResponse(raw: z.infer<typeof responseSchema>): HarnessEvent[] {
    if (raw.error) {
      return [
        {
          type: 'failed',
          category: categorize(raw.error.message),
          summary: summarize(raw.error.message)
        }
      ]
    }
    if (raw.id === INITIALIZE_ID) {
      startThread()
      return []
    }
    if (raw.id === THREAD_ID) {
      const started = threadSchema.safeParse(raw.result?.['thread'])
      if (!started.success) return [protocolFailure('Codex started no Harness Thread')]
      thread = started.data.id
      startTurn(started.data.id)
      return [
        {
          type: 'thread-ready',
          harness: 'codex',
          threadId: started.data.id,
          model: launch?.model ?? 'default'
        }
      ]
    }
    if (raw.id === TURN_ID) {
      // Kept only so the turn can be interrupted by name when the person stops.
      const acknowledged = z.object({ id: z.string().min(1) }).safeParse(raw.result?.['turn'])
      if (acknowledged.success) turn = acknowledged.data.id
    }
    return []
  }

  function consumeNotification(raw: z.infer<typeof notificationSchema>): HarnessEvent[] {
    const { method, params } = raw
    if (method === 'item/agentMessage/delta') {
      const itemId = text(params['itemId']) || 'message'
      const grown = (messages.get(itemId) ?? '') + text(params['delta'])
      messages.set(itemId, grown)
      return [
        { type: 'assistant-message', id: itemId, text: redactCredentials(grown), complete: false }
      ]
    }
    if (method === 'item/completed' || method === 'item/started') {
      const item = itemSchema.safeParse(params['item'])
      if (!item.success) return [protocolFailure('Unreadable Codex item')]
      const started = method === 'item/started'
      if (started && !STARTED_ITEMS.has(item.data.type)) return []
      return describeItem(item.data, started)
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = tokenUsageSchema.safeParse(params['tokenUsage'])
      if (!usage.success) return []
      return [
        {
          type: 'usage',
          usage: {
            inputTokens: usage.data.total.inputTokens,
            outputTokens: usage.data.total.outputTokens,
            totalTokens: usage.data.total.totalTokens,
            contextWindow: usage.data.modelContextWindow,
            contextUsed: usage.data.total.totalTokens
          }
        }
      ]
    }
    if (method === 'serverRequest/resolved') {
      // Codex has stopped waiting on this one — answered, or cleared by the
      // turn ending. Either way the request is no longer live, and a card that
      // stayed would be one nobody could answer.
      const requestId = params['requestId']
      const approvalId = String(typeof requestId === 'number' ? requestId : text(requestId))
      if (!pendingApprovals.delete(approvalId)) return []
      return [
        {
          type: 'approval-resolved',
          id: approvalId,
          decision: 'abandoned',
          message: '',
          remembered: false
        }
      ]
    }
    if (method === 'turn/completed') return [{ type: 'completed' }]
    if (method === 'turn/failed' || method === 'error') {
      const summary = text(object(params['error'])['message']) || text(params['message'])
      return [{ type: 'failed', category: categorize(summary), summary: summarize(summary) }]
    }
    if (IGNORED_METHODS.has(method)) return []
    return [{ type: 'unsupported', detail: `Unsupported Codex method: ${method}`.slice(0, 200) }]
  }

  function describeItem(item: z.infer<typeof itemSchema>, started: boolean): HarnessEvent[] {
    switch (item.type) {
      case 'agentMessage': {
        const body = item.text ?? messages.get(item.id) ?? ''
        if (!body) return []
        messages.set(item.id, body)
        return [
          { type: 'assistant-message', id: item.id, text: redactCredentials(body), complete: true }
        ]
      }
      case 'reasoning': {
        const summary = (item.summary ?? []).join(' ').trim()
        return summary
          ? [{ type: 'reasoning', summary: redactCredentials(summary).slice(0, 2_000) }]
          : []
      }
      case 'commandExecution': {
        const command = item.command ?? ''
        if (!command) return []
        return [
          {
            type: 'command',
            id: item.id,
            command: redactCredentials(command),
            output: redactCredentials(item.aggregatedOutput ?? ''),
            failed: !started && (item.exitCode ?? 0) !== 0,
            running: started
          }
        ]
      }
      case 'fileChange':
        // Reported when it is done, as Claude's changes are: it is on disk by
        // then, so this is a record rather than an offer (ADR 0004).
        return (item.changes ?? []).map((change) => ({
          type: 'file-change' as const,
          path: change.path,
          hunks: parseCodexPatch(change.diff)
        }))
      case 'userMessage':
      case 'plan':
      case 'todoList':
      case 'webSearch':
        return []
      default:
        return [
          { type: 'unsupported', detail: `Unsupported Codex item: ${item.type || 'unknown'}` }
        ]
    }
  }

  function consumeLine(line: string): HarnessEvent[] {
    if (!line.trim()) return []
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      return [UNREADABLE]
    }
    // A frame carrying a method is something Codex is saying; one carrying
    // only an id is an answer to something the app said. A server-initiated
    // request carries both, so the method has to be read first or a request
    // is mistaken for an answer and quietly dropped — with Codex waiting on
    // a reply that never comes.
    const notification = notificationSchema.safeParse(record)
    if (notification.success) {
      const request = requestSchema.safeParse(record)
      return request.success ? consumeRequest(request.data) : consumeNotification(notification.data)
    }
    const response = responseSchema.safeParse(record)
    if (response.success) return consumeResponse(response.data)
    return [UNREADABLE]
  }

  return {
    harness: 'codex',
    ingest(chunk) {
      pending += chunk
      const events: HarnessEvent[] = []
      for (;;) {
        const boundary = pending.indexOf('\n')
        if (boundary < 0) break
        const line = pending.slice(0, boundary)
        pending = pending.slice(boundary + 1)
        events.push(...consumeLine(line))
      }
      return events
    },
    flush() {
      const trailing = pending
      pending = ''
      return trailing.trim() ? [UNREADABLE] : []
    },
    takeOutgoing() {
      return outgoing.splice(0)
    },
    answerApproval(approvalId, answer) {
      const kind = pendingApprovals.get(approvalId)
      if (kind === undefined) return false
      pendingApprovals.delete(approvalId)
      // `acceptWithExecpolicyAmendment` is how Codex is told to keep the rule
      // it proposed. Only a command approval has one; a file change is
      // answered plainly, because there is no reliable rule for edits and
      // `grantRoot` is marked unstable in its own schema.
      const decision =
        answer.allow && answer.remember && kind === 'command' && proposedPrefixes.has(approvalId)
          ? {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: proposedPrefixes.get(approvalId) ?? []
              }
            }
          : answer.allow
            ? 'accept'
            : 'decline'
      // The id is answered in the shape it arrived in: Codex routes on it.
      const numeric = Number(approvalId)
      send({ id: Number.isNaN(numeric) ? approvalId : numeric, result: { decision } })
      proposedPrefixes.delete(approvalId)
      return true
    },
    interrupt() {
      if (!thread || !turn) return
      send({
        id: INTERRUPT_ID,
        method: 'turn/interrupt',
        params: { threadId: thread, turnId: turn }
      })
    }
  }
}

function protocolFailure(summary: string): HarnessEvent {
  return { type: 'failed', category: 'protocol', summary }
}

function summarize(message: string): string {
  return redactCredentials(message).trim().slice(0, 2_000) || 'Codex reported an error'
}

function categorize(summary: string): HarnessFailureCategory {
  if (/unauthori[sz]ed|authenticat|sign in|login/i.test(summary)) return 'authentication'
  if (/rate.?limit|too many requests|quota|usage limit/i.test(summary)) return 'rate-limit'
  if (/context (?:window|length)|too many tokens/i.test(summary)) return 'context-exhausted'
  return 'unknown'
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
