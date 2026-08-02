import { z } from 'zod'
import {
  diffHunkSchema,
  redactCredentials,
  type HarnessEvent,
  type HarnessFailureCategory
} from '@shared/conversation'
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

const KNOWN_SYSTEM_EVENTS = new Set([
  'init',
  'status',
  'task_started',
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
    const type = text(frame['type'])
    switch (type) {
      case 'system':
        if (text(frame['subtype']) === 'task_started') {
          return describeCommandStarted(frame, pendingCommands)
        }
        return describeSystem(frame)
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
        return describeAssistant(frame['message'], pendingCommands)
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
      // was running, which is exactly what the person wants to know.
      for (const [id, command] of pendingCommands) {
        events.push({
          type: 'command',
          id,
          command: redactCredentials(command),
          output: '',
          failed: false,
          running: false
        })
      }
      pendingCommands.clear()
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

function describeAssistant(raw: unknown, pendingCommands: Map<string, string>): HarnessEvent[] {
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
    // A command is held until its result arrives, so the Conversation can
    // report what it printed rather than only that it was called.
    const command = commandOf(block.name, block.input)
    if (command !== null) {
      pendingCommands.set(block.id, command)
      continue
    }
    events.push({
      type: 'tool',
      name: normalizeToolName(block.name),
      summary: describeTool(block.name)
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
      running: true
    }
  ]
}

/** The shell command a tool call is running, if it is running one. */
function commandOf(name: string, input: unknown): string | null {
  if (name !== 'Bash') return null
  const parsed = z.object({ command: z.string().min(1) }).safeParse(input)
  return parsed.success ? parsed.data.command : null
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
      running: false
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
