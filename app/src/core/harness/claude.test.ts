import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { harnessEventSchema, type HarnessEvent } from '@shared/conversation'
import { createClaudeAdapter } from './claude'

async function replay(fixture: string, chunkSize = 64): Promise<HarnessEvent[]> {
  const raw = await readFile(join(__dirname, 'fixtures', fixture), 'utf8')
  const adapter = createClaudeAdapter()
  const events: HarnessEvent[] = []
  for (let index = 0; index < raw.length; index += chunkSize) {
    events.push(...adapter.ingest(raw.slice(index, index + chunkSize)))
  }
  events.push(...adapter.flush())
  return events
}

describe('Claude harness Adapter', () => {
  it('normalizes a Wayfinder turn identically regardless of chunk boundaries', async () => {
    expect(await replay('claude-wayfinder.jsonl', 1)).toEqual(
      await replay('claude-wayfinder.jsonl', 1_000_000)
    )
  })

  it('streams one message, reports the session and keeps transport completion separate', async () => {
    const events = await replay('claude-wayfinder.jsonl')
    expect(events).toContainEqual({
      type: 'session-ready',
      provider: 'claude',
      sessionId: 'session-claude-1',
      model: 'claude-sonnet-4-5'
    })
    expect(events.filter((event) => event.type === 'assistant-message')).toEqual([
      {
        type: 'assistant-message',
        id: 'msg_1',
        text: 'Which decision ',
        complete: false
      },
      {
        type: 'assistant-message',
        id: 'msg_1',
        text: 'Which decision should we resolve first?',
        complete: false
      },
      {
        type: 'assistant-message',
        id: 'msg_1',
        text: 'Which decision should we resolve first?',
        complete: true
      }
    ])
    expect(events).toContainEqual({ type: 'completed' })
    expect(events.some((event) => event.type === 'workflow-completion-suggested')).toBe(false)
  })

  it('normalizes retry, tool, and final provider usage without exposing arguments', async () => {
    const events = await replay('claude-wayfinder.jsonl')
    expect(events).toContainEqual({
      type: 'retrying',
      attempt: 1,
      delayMs: 250,
      category: 'rate-limit'
    })
    expect(events).toContainEqual({
      type: 'tool',
      name: 'planning.write_planning_file',
      summary: 'Called planning tool write_planning_file'
    })
    expect(events).toContainEqual({
      type: 'usage',
      usage: {
        inputTokens: 120,
        outputTokens: 11,
        totalTokens: 131,
        contextWindow: null,
        contextUsed: null
      }
    })
  })

  it('accepts Claude status and rate-limit telemetry without treating it as protocol drift', async () => {
    const events = await replay('claude-wayfinder.jsonl')
    expect(
      events.some(
        (event) =>
          event.type === 'failed' && event.summary.includes('Unsupported Claude protocol event')
      )
    ).toBe(false)
  })

  it('accepts validated thinking-token telemetry without exposing hidden reasoning', () => {
    const adapter = createClaudeAdapter()
    expect(
      adapter.ingest(
        '{"type":"system","subtype":"thinking_tokens","estimated_tokens":103,"estimated_tokens_delta":53}\n'
      )
    ).toEqual([])
    expect(
      adapter.ingest('{"type":"system","subtype":"thinking_tokens","estimated_tokens":"unknown"}\n')
    ).toEqual([
      {
        type: 'failed',
        category: 'protocol',
        summary: 'Invalid Claude thinking_tokens event'
      }
    ])
  })

  it('fails visibly on unknown correctness-critical system and result events', async () => {
    const events = await replay('claude-failures.jsonl')
    expect(events).toContainEqual({
      type: 'failed',
      category: 'protocol',
      summary: 'Unsupported Claude system event: future_correctness_event'
    })
    expect(events).toContainEqual({
      type: 'failed',
      category: 'protocol',
      summary: 'Unsupported Claude result event: future_result'
    })
  })

  it('runtime-validates hook protocol events', () => {
    const adapter = createClaudeAdapter()
    expect(
      adapter.ingest('{"type":"system","subtype":"hook_started","hook_id":"hook-1"}\n')
    ).toEqual([
      {
        type: 'failed',
        category: 'protocol',
        summary: 'Invalid Claude hook_started event'
      }
    ])
  })

  it('categorizes provider failures and redacts credentials', async () => {
    const events = await replay('claude-failures.jsonl')
    expect(events.filter((event) => event.type === 'failed').slice(0, 2)).toEqual([
      {
        type: 'failed',
        category: 'authentication',
        summary: 'Authentication failed: token=[REDACTED: credential]'
      },
      {
        type: 'failed',
        category: 'context-exhausted',
        summary: 'Maximum context window exceeded'
      }
    ])
  })

  it('emits only runtime-valid shared events', async () => {
    for (const event of [
      ...(await replay('claude-wayfinder.jsonl')),
      ...(await replay('claude-failures.jsonl'))
    ]) {
      expect(() => harnessEventSchema.parse(event)).not.toThrow()
    }
  })
})
