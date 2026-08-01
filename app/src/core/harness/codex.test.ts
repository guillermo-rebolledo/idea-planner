import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { harnessEventSchema, type HarnessEvent } from '@shared/conversation'
import { createCodexAdapter } from './codex'

/**
 * The Codex contract suite. It replays recorded, safe protocol fixtures and
 * asserts the normalized events the rest of the app is allowed to see. It
 * deliberately says nothing about raw frames beyond what the Adapter exposes.
 */

async function replay(fixture: string, chunkSize = 64): Promise<HarnessEvent[]> {
  const raw = await readFile(join(__dirname, 'fixtures', fixture), 'utf8')
  const adapter = createCodexAdapter()
  const events: HarnessEvent[] = []
  // Feed the stream in small chunks so the Adapter must survive split lines.
  for (let index = 0; index < raw.length; index += chunkSize) {
    events.push(...adapter.ingest(raw.slice(index, index + chunkSize)))
  }
  events.push(...adapter.flush())
  return events
}

describe('Codex harness Adapter', () => {
  it('normalizes a Grill Me turn identically regardless of chunk boundaries', async () => {
    const [byteAtATime, wholeFile] = await Promise.all([
      replay('codex-grilling.jsonl', 1),
      replay('codex-grilling.jsonl', 1_000_000)
    ])
    expect(byteAtATime).toEqual(wholeFile)
  })

  it('streams assistant text, then confirms the complete message', async () => {
    const events = await replay('codex-grilling.jsonl')
    expect(events.filter((event) => event.type === 'assistant-delta')).toEqual([
      { type: 'assistant-delta', text: 'Who ' },
      { type: 'assistant-delta', text: 'is this for, ' },
      { type: 'assistant-delta', text: 'exactly?' }
    ])
    expect(events).toContainEqual({
      type: 'assistant-message',
      text: 'Who is this for, exactly?'
    })
  })

  it('keeps reasoning to provider-supplied summaries and reports tools by name', async () => {
    const events = await replay('codex-grilling.jsonl')
    expect(events).toContainEqual({
      type: 'reasoning',
      summary: 'Reading the Idea before asking the first question.'
    })
    // Reasoning deltas are not summaries and must not be surfaced piecemeal.
    expect(events).not.toContainEqual({ type: 'reasoning', summary: 'Reading the Idea' })
    expect(events).toContainEqual({
      type: 'tool',
      name: 'planning.read_file',
      summary: 'Read file idea.md'
    })
  })

  it('reads provider-native structured choices as Suggested Responses', async () => {
    const events = await replay('codex-grilling.jsonl')
    const choices = events.filter((event) => event.type === 'choices')
    expect(choices).toHaveLength(1)
    expect(choices[0]).toEqual({
      type: 'choices',
      question: 'Who is this for, exactly?',
      options: [
        {
          id: 'option-1',
          label: 'Solo freelancers',
          value: 'Solo freelancers who invoice a handful of clients.'
        },
        {
          id: 'option-2',
          label: 'Small agencies',
          value: 'Small agencies with a shared finance inbox.'
        }
      ]
    })
  })

  it('reports provider usage and context window without inventing quota', async () => {
    const events = await replay('codex-grilling.jsonl')
    expect(events).toContainEqual({
      type: 'usage',
      usage: {
        inputTokens: 1840,
        outputTokens: 320,
        totalTokens: 2160,
        contextWindow: 272_000,
        contextUsed: 2160
      }
    })
  })

  it('ends the turn as completed and never fails on unknown protocol', async () => {
    const events = await replay('codex-grilling.jsonl')
    expect(events.at(-1)).toEqual({ type: 'completed' })
    expect(events).toContainEqual({
      type: 'unsupported',
      detail: 'unrecognised_future_event'
    })
    expect(events.some((event) => event.type === 'failed')).toBe(false)
  })

  it('categorizes the failures a person has to recover from', async () => {
    const events = await replay('codex-failures.jsonl')
    expect(events.filter((event) => event.type === 'failed')).toEqual([
      {
        type: 'failed',
        category: 'rate-limit',
        summary: 'stream error: 429 Too Many Requests; retrying'
      },
      {
        type: 'failed',
        category: 'authentication',
        summary: '401 Unauthorized: please run codex login'
      },
      {
        type: 'failed',
        category: 'context-exhausted',
        summary: 'maximum context length exceeded for this model'
      },
      { type: 'failed', category: 'unknown', summary: 'the sky fell on the request' }
    ])
  })

  it('treats unreadable output as unsupported rather than a Run failure', async () => {
    const events = await replay('codex-failures.jsonl')
    expect(events).toContainEqual({ type: 'unsupported', detail: 'unreadable protocol line' })
  })

  it('emits only events the shared contract accepts', async () => {
    const events = [
      ...(await replay('codex-grilling.jsonl')),
      ...(await replay('codex-failures.jsonl'))
    ]
    for (const event of events) {
      expect(() => harnessEventSchema.parse(event)).not.toThrow()
    }
  })

  it('sanitizes credential-shaped text out of tool and failure summaries', () => {
    const adapter = createCodexAdapter()
    const events = adapter.ingest(
      `${JSON.stringify({
        msg: { type: 'error', message: 'request failed with api_key: sk-live-424242424242' }
      })}\n`
    )
    expect(events).toEqual([
      {
        type: 'failed',
        category: 'unknown',
        summary: 'request failed with api_key=[REDACTED: credential]'
      }
    ])
  })
})
