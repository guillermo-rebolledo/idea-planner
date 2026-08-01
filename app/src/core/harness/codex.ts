import { z } from 'zod'
import {
  redactCredentials,
  suggestedResponseSchema,
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
 * Frames Codex emits that the app understands but has nothing to show for.
 * Listing them explicitly keeps genuinely unknown protocol distinguishable
 * from protocol we chose to ignore.
 */
const IGNORED_FRAMES = new Set([
  'session_configured',
  'task_started',
  'agent_reasoning_delta',
  'agent_reasoning_section_break',
  'exec_command_output_delta',
  'exec_command_end',
  'mcp_tool_call_end',
  'turn_aborted'
])

const invocationSchema = z.object({
  server: z.string().default('planning'),
  tool: z.string().min(1),
  arguments: z.record(z.unknown()).default({})
})

const choiceArgumentsSchema = z.object({
  question: z.string().max(2_000).default(''),
  options: z
    .array(
      z.union([
        z
          .string()
          .min(1)
          .max(2_000)
          .transform((value) => ({ label: value, value })),
        z.object({ label: z.string().min(1).max(200), value: z.string().min(1).max(2_000) })
      ])
    )
    .min(1)
    .max(12)
})

const UNREADABLE: HarnessEvent = { type: 'unsupported', detail: 'unreadable protocol line' }

const usageSchema = z.object({
  total_token_usage: z.object({
    input_tokens: z.number().int().nonnegative().default(0),
    output_tokens: z.number().int().nonnegative().default(0),
    total_tokens: z.number().int().nonnegative().default(0)
  }),
  model_context_window: z.number().int().positive().nullish()
})

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
    // Codex wraps events in a submission envelope; tolerate a bare frame too.
    const envelope = record as { msg?: unknown }
    const frame = (
      typeof envelope.msg === 'object' && envelope.msg !== null ? envelope.msg : record
    ) as Record<string, unknown>
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
    case 'agent_message_delta': {
      const text = typeof frame['delta'] === 'string' ? frame['delta'] : ''
      return text ? [{ type: 'assistant-delta', text }] : []
    }
    case 'agent_message':
      return [{ type: 'assistant-message', text: asText(frame['message']) }]
    case 'agent_reasoning': {
      // Only provider-supplied summaries. Hidden chain-of-thought is never
      // requested, and reasoning deltas are not a summary.
      const summary = redactCredentials(asText(frame['text'])).trim()
      return summary ? [{ type: 'reasoning', summary: summary.slice(0, 2_000) }] : []
    }
    case 'mcp_tool_call_begin':
      return describeToolCall(frame['invocation'])
    case 'exec_command_begin':
      return [{ type: 'tool', name: 'shell', summary: 'Requested a shell command' }]
    case 'token_count':
      return describeUsage(frame['info'])
    case 'task_complete':
      return [{ type: 'completed' }]
    case 'error':
    case 'stream_error': {
      const summary = redactCredentials(asText(frame['message'])).trim()
      return [
        {
          type: 'failed',
          category: categorize(summary),
          summary: (summary || 'The provider reported an error').slice(0, 2_000)
        }
      ]
    }
    default:
      return IGNORED_FRAMES.has(type) ? [] : [{ type: 'unsupported', detail: type.slice(0, 200) }]
  }
}

function describeToolCall(raw: unknown): HarnessEvent[] {
  const parsed = invocationSchema.safeParse(raw)
  if (!parsed.success) return [{ type: 'unsupported', detail: 'mcp_tool_call_begin' }]
  const invocation = parsed.data
  if (invocation.tool === 'offer_response_options') {
    const choices = choiceArgumentsSchema.safeParse(invocation.arguments)
    if (!choices.success) {
      // Malformed choices are not a menu the app can trust; the person keeps
      // answering by typing.
      return [{ type: 'unsupported', detail: 'offer_response_options arguments' }]
    }
    return [
      {
        type: 'choices',
        question: redactCredentials(choices.data.question),
        options: choices.data.options.map((option, index) =>
          suggestedResponseSchema.parse({
            id: `option-${index + 1}`,
            label: redactCredentials(option.label),
            value: redactCredentials(option.value)
          })
        )
      }
    ]
  }
  return [
    {
      type: 'tool',
      name: `${invocation.server}.${invocation.tool}`,
      summary: summarizeTool(invocation.tool, invocation.arguments)
    }
  ]
}

function summarizeTool(tool: string, args: Record<string, unknown>): string {
  const path = redactCredentials(asText(args['path'] ?? args['from'] ?? '.')).slice(0, 200)
  switch (tool) {
    case 'read_file':
      return `Read file ${path}`
    case 'list_directory':
      return `List directory ${path}`
    case 'search_text':
      return `Search for text in ${path}`
    case 'write_planning_file':
      return `Write planning file ${path}`
    case 'rename_planning_file':
      return `Rename planning file ${path}`
    case 'delete_planning_file':
      return `Delete planning file ${path}`
    default:
      return `Called ${tool.slice(0, 100)}`
  }
}

function describeUsage(raw: unknown): HarnessEvent[] {
  const parsed = usageSchema.safeParse(raw)
  if (!parsed.success) return [{ type: 'unsupported', detail: 'token_count' }]
  const total = parsed.data.total_token_usage
  return [
    {
      type: 'usage',
      usage: {
        inputTokens: total.input_tokens,
        outputTokens: total.output_tokens,
        totalTokens: total.total_tokens,
        contextWindow: parsed.data.model_context_window ?? null,
        // Codex reports consumption, not remaining allowance: what the app
        // shows is exactly what the provider said.
        contextUsed: total.total_tokens
      }
    }
  ]
}

function categorize(summary: string): HarnessFailureCategory {
  if (/\b401\b|unauthori[sz]ed|not logged in|authenticat/i.test(summary)) return 'authentication'
  if (/\b429\b|rate.?limit|too many requests|quota/i.test(summary)) return 'rate-limit'
  if (/context (?:length|window)|maximum context|too many tokens/i.test(summary)) {
    return 'context-exhausted'
  }
  return 'unknown'
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
