import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { harnessEventSchema, type HarnessEvent } from '@shared/conversation'
import { createCodexAdapter } from './codex'

/**
 * The Codex contract suite. The fixtures are recorded from `codex exec --json`
 * (codex-cli 0.146.0), which reports a thread of turns made of items. The
 * suite asserts the normalized events the rest of the app is allowed to see
 * and says nothing about raw frames beyond what the Adapter exposes.
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

  it('reports an assistant message as it grows and marks it complete once', async () => {
    const events = await replay('codex-grilling.jsonl')
    expect(events.filter((event) => event.type === 'assistant-message')).toEqual([
      { type: 'assistant-message', id: 'item_2', text: 'Who is this', complete: false },
      { type: 'assistant-message', id: 'item_2', text: 'Who is this for, exactly?', complete: true }
    ])
  })

  it('keeps reasoning to the provider’s finished summary and names the tools used', async () => {
    const events = await replay('codex-grilling.jsonl')
    expect(events).toContainEqual({
      type: 'reasoning',
      summary: 'Reading the Idea before asking the first question.'
    })
    // One activity row per tool, raised when the provider asks for it.
    expect(events.filter((event) => event.type === 'tool')).toEqual([
      {
        type: 'tool',
        name: 'planning.read_file',
        summary: 'Called planning tool read_file'
      }
    ])
  })

  it('reports provider usage without inventing a window or a quota', async () => {
    const events = await replay('codex-grilling.jsonl')
    expect(events).toContainEqual({
      type: 'usage',
      usage: {
        inputTokens: 16_506,
        outputTokens: 29,
        totalTokens: 16_535,
        contextWindow: null,
        contextUsed: null
      }
    })
  })

  it('ends the turn as completed and never fails on unknown protocol', async () => {
    const events = await replay('codex-grilling.jsonl')
    expect(events.at(-1)).toEqual({ type: 'completed' })
    expect(events).toContainEqual({ type: 'unsupported', detail: 'item:future_item_kind' })
    expect(events.some((event) => event.type === 'failed')).toBe(false)
  })

  it('surfaces the provider’s own words when a turn fails', async () => {
    const events = await replay('codex-failures.jsonl')
    const failures = events.filter((event) => event.type === 'failed')
    expect(failures.at(-1)).toEqual({
      type: 'failed',
      category: 'unknown',
      summary: "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account."
    })
    expect(failures).toHaveLength(3)
    expect(events).toContainEqual({ type: 'unsupported', detail: 'unreadable protocol line' })
  })

  it('categorizes the failures a person has to recover from', async () => {
    const events = await replay('codex-recoverable-failures.jsonl')
    expect(events.map((event) => (event.type === 'failed' ? event.category : event.type))).toEqual([
      'authentication',
      'rate-limit',
      'context-exhausted'
    ])
  })

  it('emits only events the shared contract accepts', async () => {
    const events = [
      ...(await replay('codex-grilling.jsonl')),
      ...(await replay('codex-failures.jsonl')),
      ...(await replay('codex-recoverable-failures.jsonl'))
    ]
    for (const event of events) {
      expect(() => harnessEventSchema.parse(event)).not.toThrow()
    }
  })

  it('sanitizes credential-shaped text out of assistant and failure content', () => {
    const adapter = createCodexAdapter()
    expect(
      adapter.ingest(
        `${JSON.stringify({
          type: 'error',
          message: 'request failed with api_key: sk-live-424242424242'
        })}\n`
      )
    ).toEqual([
      {
        type: 'failed',
        category: 'unknown',
        summary: 'request failed with api_key=[REDACTED: credential]'
      }
    ])
  })
})
