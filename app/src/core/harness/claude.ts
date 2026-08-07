import { z } from 'zod'
import {
  diffHunkSchema,
  redactCredentials,
  type HarnessEvent,
  type HarnessFailureCategory,
  type SubagentStatus
} from '@shared/conversation'
import { interruptWorking, subagentEvent, type Dispatch } from './subagent'
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from '@shared/run'
import type { HarnessAdapter } from './codex'

const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative().default(0)
})

const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), thinking: z.string().optional() }),
  z.object({ type: z.literal('redacted_thinking'), data: z.string().optional() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string().default('tool'),
    name: z.string().min(1),
    input: z.unknown().optional()
  })
])

/**
 * The payload Claude puts beside a tool result when it changed a file. It is
 * undocumented, so it is parsed strictly and pinned by a recorded fixture: a
 * shape change should be visible, not silently drop the diff.
 */
const fileChangeSchema = z.object({
  filePath: z.string().min(1),
  structuredPatch: z.array(diffHunkSchema).min(1)
})

const assistantSchema = z.object({
  id: z.string().min(1).max(200),
  content: z.array(contentBlockSchema),
  usage: usageSchema.optional()
})

const taskStartedSchema = z.object({
  tool_use_id: z.string().min(1).max(200)
})

/** What the tool call that dispatches a subagent carries. */
const agentDispatchSchema = z.object({
  description: z.string().min(1).max(200),
  subagent_type: z.string().min(1).max(100).optional(),
  prompt: z.string().optional()
})

/**
 * A subagent's first frame. It repeats everything the dispatching tool call
 * said, which is what lets a subagent be followed even when the Adapter joined
 * the stream after the call — and `task_id` is the only name the later
 * `task_updated` frames know it by.
 */
const subagentStartedSchema = agentDispatchSchema.extend({
  task_id: z.string().min(1).max(200),
  tool_use_id: z.string().min(1).max(200),
  /** `local_agent` for a subagent, `local_bash` for a command. */
  task_type: z.string().min(1).max(100).optional()
})

/** How much a subagent has done, as Claude counts it. */
const subagentUsageSchema = z.object({
  tool_uses: z.number().int().nonnegative().optional(),
  duration_ms: z.number().int().nonnegative().optional()
})

const subagentProgressSchema = z.object({
  tool_use_id: z.string().min(1).max(200),
  /** Prose: "Running Count lines and bytes in notes.txt". */
  description: z.string().min(1).max(500).optional(),
  usage: subagentUsageSchema.optional()
})

/** The only subagent frame keyed by task id rather than by tool-use id. */
const subagentUpdatedSchema = z.object({
  task_id: z.string().min(1).max(200),
  patch: z.object({ status: z.string().min(1).max(100).optional() })
})

const subagentFinishedSchema = z.object({
  tool_use_id: z.string().min(1).max(200),
  status: z.string().min(1).max(100).optional(),
  summary: z.string().optional(),
  usage: subagentUsageSchema.optional()
})

/** What the app calls each status Claude reports for a subagent. */
const SUBAGENT_STATUS: Record<string, SubagentStatus> = {
  completed: 'done',
  success: 'done',
  failed: 'failed',
  error: 'failed',
  cancelled: 'interrupted',
  interrupted: 'interrupted'
}

const KNOWN_SYSTEM_EVENTS = new Set([
  'init',
  'status',
  'task_started',
  'task_progress',
  'task_updated',
  'task_notification',
  'thinking_tokens',
  'api_retry',
  'hook_started',
  'hook_response'
])
const hookEventSchema = z.object({
  hook_id: z.string().min(1).max(200),
  hook_name: z.string().min(1).max(200),
  hook_event: z.string().min(1).max(200)
})
/** What a Bash tool result carries: what the command printed. */
const commandResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string()
})

const toolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1).max(200),
  is_error: z.boolean().optional()
})

const thinkingTokensSchema = z.object({
  estimated_tokens: z.number().int().nonnegative(),
  estimated_tokens_delta: z.number().int().nonnegative()
})

/** Translates Claude Code's documented `--output-format stream-json` protocol. */
export function createClaudeAdapter(): HarnessAdapter {
  let pending = ''
  let streamingMessageId = 'message'
  let streamedText = ''
  // Commands the Harness has started, by its own call id, so a result can be
  // paired with the command that produced it rather than with whatever came
  // last. Cleared as each result arrives.
  const pendingCommands = new Map<string, string>()
  // Subagents this Run dispatched, by the tool-use id every frame names them
  // by, and the task ids that only `task_updated` uses.
  const subagents = new Map<string, Dispatch>()
  const taskIds = new Map<string, string>()

  /** The subagent as it stands now, which is the whole of what an event says. */
  function report(dispatch: Dispatch): HarnessEvent[] {
    subagents.set(dispatch.id, dispatch)
    return [subagentEvent(dispatch)]
  }

  function consumeLine(line: string): HarnessEvent[] {
    if (!line.trim()) return []
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return [protocolFailure('Unreadable Claude protocol line')]
    }
    if (typeof raw !== 'object' || raw === null)
      return [protocolFailure('Unreadable Claude protocol line')]
    const frame = raw as Record<string, unknown>
    // A frame naming a parent tool call is a subagent's own work — its
    // commands, its reads, its prose. It belongs to that subagent, and a Run
    // that claimed it would be claiming work it did not do. What the subagent
    // is up to reaches the app through the `task_*` frames instead, which are
    // the ones Claude addresses to the Run.
    if (text(frame['parent_tool_use_id'])) return []
    const type = text(frame['type'])
    switch (type) {
      case 'system': {
        const subtype = text(frame['subtype'])
        if (subtype === 'task_started') {
          // The same frame announces both a command starting and a subagent
          // starting; which one it is, is what it carries.
          const dispatched = describeSubagentStarted(frame)
          if (dispatched !== null) return dispatched
          return describeCommandStarted(frame, pendingCommands)
        }
        if (subtype === 'task_progress') return describeSubagentProgress(frame)
        if (subtype === 'task_updated') return describeSubagentUpdated(frame)
        if (subtype === 'task_notification') return describeSubagentFinished(frame)
        return describeSystem(frame)
      }
      case 'stream_event': {
        const event = object(frame['event'])
        const eventType = text(event['type'])
        if (eventType === 'message_start') {
          const message = object(event['message'])
          streamingMessageId = text(message['id']) || 'message'
          streamedText = ''
          return []
        }
        if (eventType === 'content_block_delta') {
          const delta = object(event['delta'])
          if (text(delta['type']) !== 'text_delta') return []
          streamedText += text(delta['text'])
          return [
            {
              type: 'assistant-message',
              id: streamingMessageId,
              text: redactCredentials(streamedText),
              complete: false
            }
          ]
        }
        if (
          ['content_block_start', 'content_block_stop', 'message_delta', 'message_stop'].includes(
            eventType
          )
        )
          return []
        return [protocolFailure(`Unsupported Claude stream event: ${eventType || 'unknown'}`)]
      }
      case 'assistant':
        return describeAssistant(frame['message'], pendingCommands, dispatchSubagent)
      case 'result':
        return describeResult(frame)
      case 'user':
        return [
          ...describeCommandResult(frame, pendingCommands),
          ...describeFileChange(frame['tool_use_result'])
        ]
      case 'rate_limit_event':
        return []
      default:
        return [protocolFailure(`Unsupported Claude protocol event: ${type || 'unknown'}`)]
    }
  }

  /** The tool call that dispatched it: the first anything is known about it. */
  function dispatchSubagent(
    id: string,
    input: z.infer<typeof agentDispatchSchema>
  ): HarnessEvent[] {
    return report({
      ...(subagents.get(id) ?? { status: 'working' as const, steps: null, durationMs: null }),
      id,
      name: input.description,
      ...(input.subagent_type !== undefined ? { role: input.subagent_type } : {}),
      ...(input.prompt !== undefined ? { brief: input.prompt } : {})
    })
  }

  /**
   * A subagent starting. Null when the frame is a command starting instead:
   * Claude announces both with `task_started`, and only what it carries tells
   * them apart.
   */
  function describeSubagentStarted(frame: Record<string, unknown>): HarnessEvent[] | null {
    const parsed = subagentStartedSchema.safeParse(frame)
    if (!parsed.success) return null
    if (parsed.data.task_type !== 'local_agent' && parsed.data.subagent_type === undefined)
      return null
    taskIds.set(parsed.data.task_id, parsed.data.tool_use_id)
    return dispatchSubagent(parsed.data.tool_use_id, parsed.data)
  }

  /** What it is on now, and how much it has done to get there. */
  function describeSubagentProgress(frame: Record<string, unknown>): HarnessEvent[] {
    const parsed = subagentProgressSchema.safeParse(frame)
    if (!parsed.success) return [protocolFailure('Invalid Claude task_progress event')]
    const dispatch = subagents.get(parsed.data.tool_use_id)
    // Progress for a subagent this Adapter never saw dispatched says nothing
    // it could draw: there is no name to put on it.
    if (dispatch === undefined) return []
    return report({
      ...dispatch,
      ...(parsed.data.description !== undefined ? { activity: parsed.data.description } : {}),
      steps: parsed.data.usage?.tool_uses ?? dispatch.steps,
      durationMs: parsed.data.usage?.duration_ms ?? dispatch.durationMs
    })
  }

  /** The one frame that names a subagent by its task id rather than its call. */
  function describeSubagentUpdated(frame: Record<string, unknown>): HarnessEvent[] {
    const parsed = subagentUpdatedSchema.safeParse(frame)
    if (!parsed.success) return [protocolFailure('Invalid Claude task_updated event')]
    const toolUseId = taskIds.get(parsed.data.task_id)
    const dispatch = toolUseId === undefined ? undefined : subagents.get(toolUseId)
    if (dispatch === undefined) return []
    const status = SUBAGENT_STATUS[parsed.data.patch.status ?? '']
    // A patch that changed something else — a title, a timestamp — leaves the
    // subagent exactly as it was rather than resetting it to working.
    if (status === undefined || status === dispatch.status) return []
    return report({ ...dispatch, status })
  }

  /** What it reported back, which is the last thing it says. */
  function describeSubagentFinished(frame: Record<string, unknown>): HarnessEvent[] {
    const parsed = subagentFinishedSchema.safeParse(frame)
    if (!parsed.success) return [protocolFailure('Invalid Claude task_notification event')]
    const dispatch = subagents.get(parsed.data.tool_use_id)
    if (dispatch === undefined) return []
    return report({
      ...dispatch,
      status: SUBAGENT_STATUS[parsed.data.status ?? ''] ?? dispatch.status,
      // The summary is the report itself. An ended subagent with none said
      // nothing back, and an empty section is honest about that.
      ...(parsed.data.summary !== undefined ? { result: parsed.data.summary } : {}),
      steps: parsed.data.usage?.tool_uses ?? dispatch.steps,
      durationMs: parsed.data.usage?.duration_ms ?? dispatch.durationMs
    })
  }

  return {
    harness: 'claude',
    // Claude broadcasts: it is read, never answered. Its approvals arrive on
    // the app's own MCP socket instead, and are answered there.
    takeOutgoing: () => [],
    answerApproval: () => false,
    interrupt: () => undefined,
    ingest(chunk) {
      pending += chunk
      const events: HarnessEvent[] = []
      for (;;) {
        const boundary = pending.indexOf('\n')
        if (boundary < 0) break
        events.push(...consumeLine(pending.slice(0, boundary)))
        pending = pending.slice(boundary + 1)
      }
      return events
    },
    flush() {
      const rest = pending
      pending = ''
      const events = consumeLine(rest)
      // A Run stopped mid-command would otherwise say nothing about what it
      // was running, which is exactly what the person wants to know. Marked
      // interrupted rather than finished: the result never arrived, so a
      // clean exit-less success is not something this can claim.
      for (const [id, command] of pendingCommands) {
        events.push({
          type: 'command',
          id,
          command: redactCredentials(command),
          output: '',
          failed: false,
          running: false,
          interrupted: true,
          exitCode: null,
          durationMs: null
        })
      }
      pendingCommands.clear()
      events.push(...interruptWorking(subagents.values()))
      return events
    }
  }
}

function describeSystem(frame: Record<string, unknown>): HarnessEvent[] {
  const subtype = text(frame['subtype'])
  if (!KNOWN_SYSTEM_EVENTS.has(subtype)) {
    return [protocolFailure(`Unsupported Claude system event: ${subtype || 'unknown'}`)]
  }
  if (subtype === 'init') {
    // Claude names its continuity record a session; the app calls it a
    // Harness Thread.
    const threadId = text(frame['session_id'])
    const model = text(frame['model'])
    // Reported rather than assumed: managed settings can override the mode the
    // app asked for, and a Run in a different mode than the person chose is
    // something they need told.
    const permissionMode = text(frame['permissionMode'])
    return threadId && model
      ? [
          {
            type: 'thread-ready',
            harness: 'claude',
            threadId,
            model,
            ...(permissionMode ? { permissionMode } : {})
          }
        ]
      : [protocolFailure('Invalid Claude init event')]
  }
  if (subtype === 'api_retry') {
    return [
      {
        type: 'retrying',
        attempt: positiveInteger(frame['attempt']),
        delayMs: nonnegativeInteger(frame['retry_delay_ms']),
        category: /rate.?limit/i.test(text(frame['error'])) ? 'rate-limit' : 'harness'
      }
    ]
  }
  if (subtype === 'thinking_tokens') {
    return thinkingTokensSchema.safeParse(frame).success
      ? []
      : [protocolFailure('Invalid Claude thinking_tokens event')]
  }
  if (subtype === 'hook_started' || subtype === 'hook_response') {
    return hookEventSchema.safeParse(frame).success
      ? []
      : [protocolFailure(`Invalid Claude ${subtype} event`)]
  }
  return []
}

/**
 * The tool Claude dispatches a subagent with, as claude 2.1.224 names it. A
 * dispatch under any other name still reaches this Adapter through the
 * `task_started` frame, which says outright that it started an agent.
 */
const SUBAGENT_TOOL = 'Agent'

function describeAssistant(
  raw: unknown,
  pendingCommands: Map<string, string>,
  onDispatch: (id: string, input: z.infer<typeof agentDispatchSchema>) => HarnessEvent[]
): HarnessEvent[] {
  const parsed = assistantSchema.safeParse(raw)
  if (!parsed.success) return [protocolFailure('Invalid Claude assistant event')]
  const events: HarnessEvent[] = []
  const assistantText = parsed.data.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
  if (assistantText) {
    events.push({
      type: 'assistant-message',
      id: parsed.data.id,
      text: redactCredentials(assistantText),
      complete: true
    })
  }
  for (const block of parsed.data.content) {
    if (block.type !== 'tool_use') continue
    // Dispatching a subagent is not a tool call worth a line of its own: the
    // subagent it started is the thing, and it says everything this call would.
    if (block.name === SUBAGENT_TOOL) {
      const dispatch = agentDispatchSchema.safeParse(block.input)
      if (dispatch.success) {
        events.push(...onDispatch(block.id, dispatch.data))
        continue
      }
    }
    // A command is held until its result arrives, so the Conversation can
    // report what it printed rather than only that it was called.
    const command = commandOf(block.name, block.input)
    if (command !== null) {
      pendingCommands.set(block.id, command)
      continue
    }
    const read = readPathOf(block.name, block.input)
    events.push({
      type: 'tool',
      name: normalizeToolName(block.name),
      summary: describeTool(block.name),
      ...(read !== null ? { path: redactCredentials(read) } : {})
    })
  }
  return events
}

/**
 * A command the moment it begins. The Harness carries no partial output, so
 * this is the earliest there is to say: without it a person watching a test
 * suite sees nothing at all until it finishes.
 */
function describeCommandStarted(
  frame: Record<string, unknown>,
  pendingCommands: Map<string, string>
): HarnessEvent[] {
  const parsed = taskStartedSchema.safeParse(frame)
  if (!parsed.success) return []
  const command = pendingCommands.get(parsed.data.tool_use_id)
  if (command === undefined) return []
  return [
    {
      type: 'command',
      id: parsed.data.tool_use_id,
      command: redactCredentials(command),
      output: '',
      failed: false,
      running: true,
      exitCode: null,
      durationMs: null
    }
  ]
}

/** The shell command a tool call is running, if it is running one. */
function commandOf(name: string, input: unknown): string | null {
  if (name !== 'Bash') return null
  const parsed = z.object({ command: z.string().min(1) }).safeParse(input)
  return parsed.success ? parsed.data.command : null
}

/** The file a tool call is reading, if it is reading one. */
function readPathOf(name: string, input: unknown): string | null {
  if (name !== 'Read') return null
  const parsed = z.object({ file_path: z.string().min(1) }).safeParse(input)
  return parsed.success ? parsed.data.file_path : null
}

/**
 * What a command printed, paired to the call that produced it by the id the
 * Harness gave it. Output is what the person was usually waiting for, so it
 * belongs in the Conversation rather than only in the activity stream.
 */
function describeCommandResult(
  frame: Record<string, unknown>,
  pendingCommands: Map<string, string>
): HarnessEvent[] {
  const message = object(frame['message'])
  const blocks = Array.isArray(message['content']) ? message['content'] : []
  const events: HarnessEvent[] = []
  for (const raw of blocks) {
    const block = toolResultBlockSchema.safeParse(raw)
    if (!block.success) continue
    const command = pendingCommands.get(block.data.tool_use_id)
    if (command === undefined) continue
    pendingCommands.delete(block.data.tool_use_id)
    // Which stream said what matters when a command fails, and a payload in
    // an unfamiliar shape still has the tool result's own text to fall back on.
    const result = commandResultSchema.safeParse(frame['tool_use_result'])
    const output = result.success
      ? [result.data.stdout, result.data.stderr && `stderr: ${result.data.stderr}`]
          .filter(Boolean)
          .join('\n')
      : typeof (raw as { content?: unknown }).content === 'string'
        ? (raw as { content: string }).content
        : ''
    events.push({
      type: 'command',
      id: block.data.tool_use_id,
      command: redactCredentials(command),
      output: redactCredentials(output),
      failed: block.data.is_error ?? false,
      running: false,
      // Claude reports only whether it errored; the Conversation measures the
      // duration between the start it saw and this result.
      exitCode: null,
      durationMs: null
    })
  }
  return events
}

/**
 * A file the Harness changed. The edit is already on disk when this arrives —
 * edits land in the Checkout in place (ADR 0004) — so this reports what
 * happened rather than proposing it.
 *
 * A tool result that carries no patch is not a failure: most tools do not
 * change files.
 */
function describeFileChange(raw: unknown): HarnessEvent[] {
  if (raw === null || typeof raw !== 'object') return []
  // Most tool results change no file at all, so a payload with neither of
  // these is simply not a change. One that edits a file but has lost the
  // patch is the shape change this fixture exists to catch, and it is said
  // out loud rather than quietly producing no diff.
  const edited = 'oldString' in raw || 'newString' in raw
  if (!('structuredPatch' in raw)) {
    return edited ? [protocolFailure('Claude reported an edit with no diff')] : []
  }
  const parsed = fileChangeSchema.safeParse(raw)
  if (!parsed.success) {
    return [protocolFailure('Unsupported Claude file-change payload')]
  }
  return [{ type: 'file-change', path: parsed.data.filePath, hunks: parsed.data.structuredPatch }]
}

function describeResult(frame: Record<string, unknown>): HarnessEvent[] {
  const subtype = text(frame['subtype'])
  if (subtype === 'success' && frame['is_error'] === false) {
    const usage = usageSchema.safeParse(frame['usage'])
    return [...(usage.success ? [usageEvent(usage.data)] : []), { type: 'completed' as const }]
  }
  if (
    ![
      'error_during_execution',
      'error_max_turns',
      'error_max_budget_usd',
      'error_max_structured_output_retries'
    ].includes(subtype)
  ) {
    return [protocolFailure(`Unsupported Claude result event: ${subtype || 'unknown'}`)]
  }
  const summary = redactCredentials(text(frame['result'])).trim() || 'Claude reported an error'
  return [{ type: 'failed', category: categorize(summary), summary: summary.slice(0, 2_000) }]
}

function usageEvent(usage: z.infer<typeof usageSchema>): HarnessEvent {
  return {
    type: 'usage',
    usage: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens,
      contextWindow: null,
      contextUsed: null
    }
  }
}

function protocolFailure(summary: string): HarnessEvent {
  return { type: 'failed', category: 'protocol', summary }
}

function categorize(summary: string): HarnessFailureCategory {
  if (/unauthori[sz]ed|authenticat|sign in|\btoken\b/i.test(summary)) return 'authentication'
  if (/rate.?limit|too many requests|quota|usage limit/i.test(summary)) return 'rate-limit'
  if (/context (?:length|window)|maximum context|too many tokens/i.test(summary))
    return 'context-exhausted'
  return 'unknown'
}

function normalizeToolName(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX)
    ? `${MCP_SERVER_NAME}.${name.slice(MCP_TOOL_PREFIX.length)}`
    : name
}

function describeTool(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX)
    ? `Called app tool ${name.slice(MCP_TOOL_PREFIX.length)}`
    : `Called Claude tool ${name}`
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}
