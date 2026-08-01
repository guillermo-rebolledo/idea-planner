import { z } from 'zod'
import {
  redactCredentials,
  type HarnessEvent,
  type HarnessFailureCategory
} from '@shared/conversation'
import type { ProviderId } from '@shared/readiness'

/**
 * Harness Adapters translate one provider's protocol into normalized events.
 * Everything downstream — persistence, presentation, recovery — reads only the
 * normalized contract, so a provider protocol change stays inside its Adapter.
 */
export interface HarnessAdapter {
  readonly provider: ProviderId
  /** Consumes a raw stdout chunk and returns the events it completed. */
  ingest(chunk: string): HarnessEvent[]
  /** Reports whatever a truncated final line implies at end of stream. */
  flush(): HarnessEvent[]
}

/**
 * `codex exec --json` reports a thread of turns made of items. Items arrive
 * started → updated → completed and each payload carries the item's whole
 * value so far, so this Adapter forwards the current state and lets Core
 * supersede rather than trying to reconstruct deltas.
 */
const itemSchema = z.object({
  id: z.string().min(1).max(200).default('item'),
  type: z.string().default(''),
  text: z.string().optional(),
  message: z.string().optional(),
  command: z.string().optional(),
  server: z.string().optional(),
  tool: z.string().optional(),
  query: z.string().optional()
})

const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative().default(0)
})

const UNREADABLE: HarnessEvent = { type: 'unsupported', detail: 'unreadable protocol line' }

/**
 * Protocol this Adapter understands but has nothing to show for. Listing it
 * keeps genuinely unknown protocol distinguishable from what we chose to skip.
 */
const IGNORED_EVENTS = new Set(['thread.started', 'turn.started', 'item.added'])
const IGNORED_ITEMS = new Set(['todo_list'])

export function createCodexAdapter(): HarnessAdapter {
  let pending = ''

  function consumeLine(line: string): HarnessEvent[] {
    if (!line.trim()) return []
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      return [UNREADABLE]
    }
    if (typeof record !== 'object' || record === null) return [UNREADABLE]
    const frame = record as Record<string, unknown>
    const type = typeof frame['type'] === 'string' ? frame['type'] : ''
    if (!type) return [UNREADABLE]
    return translate(type, frame)
  }

  return {
    provider: 'codex',
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
      const rest = pending
      pending = ''
      return consumeLine(rest)
    }
  }
}

function translate(type: string, frame: Record<string, unknown>): HarnessEvent[] {
  switch (type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return describeItem(frame['item'], type === 'item.completed')
    case 'turn.completed':
      return [...describeUsage(frame['usage']), { type: 'completed' }]
    case 'turn.failed':
      return [describeFailure(nestedMessage(frame['error']))]
    case 'thread.error':
    case 'error':
      return [describeFailure(asText(frame['message']))]
    default:
      return IGNORED_EVENTS.has(type) ? [] : [{ type: 'unsupported', detail: type.slice(0, 200) }]
  }
}

function describeItem(raw: unknown, completed: boolean): HarnessEvent[] {
  const parsed = itemSchema.safeParse(raw)
  if (!parsed.success) return [{ type: 'unsupported', detail: 'item payload' }]
  const item = parsed.data
  switch (item.type) {
    case 'agent_message':
      return [
        {
          type: 'assistant-message',
          id: item.id,
          text: redactCredentials(item.text ?? ''),
          complete: completed
        }
      ]
    case 'reasoning': {
      // Only the provider's own finished summary. Hidden chain-of-thought is
      // never requested, and a half-written summary is not a summary.
      if (!completed) return []
      const summary = redactCredentials(item.text ?? '').trim()
      return summary ? [{ type: 'reasoning', summary: summary.slice(0, 2_000) }] : []
    }
    // Tool items report once, when they start: the activity row is about what
    // the provider asked for, not about how it turned out.
    case 'command_execution':
      return completed
        ? []
        : [
            {
              type: 'tool',
              name: 'shell',
              summary: `Ran command: ${redactCredentials(item.command ?? '').slice(0, 300)}`
            }
          ]
    case 'mcp_tool_call':
      return completed
        ? []
        : [
            {
              type: 'tool',
              name: `${item.server ?? 'mcp'}.${item.tool ?? 'unknown'}`,
              summary: `Called planning tool ${item.tool ?? 'unknown'}`
            }
          ]
    case 'file_change':
      return completed
        ? []
        : [{ type: 'tool', name: 'file_change', summary: 'Proposed a file change' }]
    case 'web_search':
      return completed
        ? []
        : [
            {
              type: 'tool',
              name: 'web_search',
              summary: `Searched the web: ${redactCredentials(item.query ?? '').slice(0, 200)}`
            }
          ]
    case 'error':
      return [describeFailure(asText(item.message ?? item.text))]
    default:
      return IGNORED_ITEMS.has(item.type)
        ? []
        : [{ type: 'unsupported', detail: `item:${item.type.slice(0, 100)}` }]
  }
}

function describeUsage(raw: unknown): HarnessEvent[] {
  const parsed = usageSchema.safeParse(raw)
  if (!parsed.success) return []
  return [
    {
      type: 'usage',
      usage: {
        inputTokens: parsed.data.input_tokens,
        outputTokens: parsed.data.output_tokens,
        totalTokens: parsed.data.input_tokens + parsed.data.output_tokens,
        // This protocol reports consumption only. The app never invents a
        // window, a quota, or a remaining allowance the provider did not give.
        contextWindow: null,
        contextUsed: null
      }
    }
  ]
}

function describeFailure(message: string): HarnessEvent {
  const summary = redactCredentials(message).trim() || 'The provider reported an error'
  return { type: 'failed', category: categorize(summary), summary: summary.slice(0, 2_000) }
}

/** Codex nests a turn failure as `{ error: { message } }`; a bare string also occurs. */
function nestedMessage(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object' && raw !== null && 'message' in raw) {
    return asText(raw.message)
  }
  return ''
}

function categorize(summary: string): HarnessFailureCategory {
  if (/\b401\b|unauthori[sz]ed|not logged in|authenticat|sign in/i.test(summary)) {
    return 'authentication'
  }
  if (/\b429\b|rate.?limit|too many requests|quota|usage limit/i.test(summary)) return 'rate-limit'
  if (/context (?:length|window)|maximum context|too many tokens/i.test(summary)) {
    return 'context-exhausted'
  }
  return 'unknown'
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
