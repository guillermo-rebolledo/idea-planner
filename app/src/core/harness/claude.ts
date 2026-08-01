import { z } from 'zod'
import {
  redactCredentials,
  type HarnessEvent,
  type HarnessFailureCategory
} from '@shared/conversation'
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

const assistantSchema = z.object({
  id: z.string().min(1).max(200),
  content: z.array(contentBlockSchema),
  usage: usageSchema.optional()
})

const KNOWN_SYSTEM_EVENTS = new Set([
  'init',
  'status',
  'api_retry',
  'hook_started',
  'hook_response'
])
const hookEventSchema = z.object({
  hook_id: z.string().min(1).max(200),
  hook_name: z.string().min(1).max(200),
  hook_event: z.string().min(1).max(200)
})

/** Translates Claude Code's documented `--output-format stream-json` protocol. */
export function createClaudeAdapter(): HarnessAdapter {
  let pending = ''
  let streamingMessageId = 'message'
  let streamedText = ''

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
        return describeAssistant(frame['message'])
      case 'result':
        return describeResult(frame)
      case 'user':
      case 'rate_limit_event':
        return []
      default:
        return [protocolFailure(`Unsupported Claude protocol event: ${type || 'unknown'}`)]
    }
  }

  return {
    provider: 'claude',
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
      return consumeLine(rest)
    }
  }
}

function describeSystem(frame: Record<string, unknown>): HarnessEvent[] {
  const subtype = text(frame['subtype'])
  if (!KNOWN_SYSTEM_EVENTS.has(subtype)) {
    return [protocolFailure(`Unsupported Claude system event: ${subtype || 'unknown'}`)]
  }
  if (subtype === 'init') {
    const sessionId = text(frame['session_id'])
    const model = text(frame['model'])
    return sessionId && model
      ? [{ type: 'session-ready', provider: 'claude', sessionId, model }]
      : [protocolFailure('Invalid Claude init event')]
  }
  if (subtype === 'api_retry') {
    return [
      {
        type: 'retrying',
        attempt: positiveInteger(frame['attempt']),
        delayMs: nonnegativeInteger(frame['retry_delay_ms']),
        category: /rate.?limit/i.test(text(frame['error'])) ? 'rate-limit' : 'provider'
      }
    ]
  }
  if (subtype === 'hook_started' || subtype === 'hook_response') {
    return hookEventSchema.safeParse(frame).success
      ? []
      : [protocolFailure(`Invalid Claude ${subtype} event`)]
  }
  return []
}

function describeAssistant(raw: unknown): HarnessEvent[] {
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
    events.push({
      type: 'tool',
      name: normalizeToolName(block.name),
      summary: describeTool(block.name)
    })
  }
  return events
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
  return name.replace(/^mcp__planning__/, 'planning.')
}

function describeTool(name: string): string {
  const tool = name.replace(/^mcp__planning__/, '')
  return name.startsWith('mcp__planning__')
    ? `Called planning tool ${tool}`
    : `Called Claude tool ${tool}`
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
