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

  it('streams one message, reports the Harness Thread and keeps transport completion separate', async () => {
    const events = await replay('claude-wayfinder.jsonl')
    expect(events).toContainEqual({
      type: 'thread-ready',
      harness: 'claude',
      threadId: 'session-claude-1',
      model: 'claude-sonnet-4-5',
      permissionMode: 'dontAsk'
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
  })

  it('normalizes retry, tool, and final Harness usage without exposing arguments', async () => {
    const events = await replay('claude-wayfinder.jsonl')
    expect(events).toContainEqual({
      type: 'retrying',
      attempt: 1,
      delayMs: 250,
      category: 'rate-limit'
    })
    expect(events).toContainEqual({
      type: 'tool',
      name: 'app.offer_response_options',
      summary: 'Called app tool offer_response_options'
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

  it('categorizes Harness failures and redacts credentials', async () => {
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

describe('file changes', () => {
  it('reports an edit as a change with the hunks the Harness computed', async () => {
    // Recorded from claude 2.1.220 against a throwaway repository. The payload
    // that carries the diff is undocumented, so this fixture is the contract:
    // if the Harness stops sending it in this shape, this test says so rather
    // than the diffs quietly disappearing from the Conversation.
    const events = await replay('claude-edit.jsonl')

    expect(events.filter((event) => event.type === 'file-change')).toEqual([
      {
        type: 'file-change',
        path: '/tmp/a-project/greeting.ts',
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              '-export const greeting = "hello world"',
              '+export const greeting = "goodbye world"'
            ]
          }
        ]
      }
    ])
  })

  it('normalizes a file change identically regardless of chunk boundaries', async () => {
    expect(await replay('claude-edit.jsonl', 1)).toEqual(
      await replay('claude-edit.jsonl', 1_000_000)
    )
  })

  it('emits only events the shared contract accepts', async () => {
    for (const event of await replay('claude-edit.jsonl')) {
      expect(harnessEventSchema.safeParse(event).success).toBe(true)
    }
  })
})

describe('commands', () => {
  it('reports the command the Harness ran and what it printed', async () => {
    // Recorded from claude 2.1.220. Reporting only that a tool was called
    // leaves a Run that compiles or tests saying nothing about the result.
    const events = await replay('claude-command.jsonl')

    expect(events.filter((event) => event.type === 'command')).toEqual([
      {
        type: 'command',
        id: 'toolu_015hHJHQrm7DjbErN5tdKwW6',
        command: 'wc -l lines.txt',
        output: '       3 lines.txt',
        failed: false
      }
    ])
  })

  it('does not report a command as a bare tool call as well', async () => {
    const events = await replay('claude-command.jsonl')
    expect(events.filter((event) => event.type === 'tool')).toEqual([])
  })

  it('normalizes a command identically regardless of chunk boundaries', async () => {
    expect(await replay('claude-command.jsonl', 1)).toEqual(
      await replay('claude-command.jsonl', 1_000_000)
    )
  })

  it('emits only events the shared contract accepts', async () => {
    for (const event of await replay('claude-command.jsonl')) {
      expect(harnessEventSchema.safeParse(event).success).toBe(true)
    }
  })
})

describe('the mode a Run is actually running under', () => {
  it('reports the effective permission mode from the init event', async () => {
    // Managed settings outrank command-line arguments, so what the app asked
    // for is not necessarily what is running. The Harness says which.
    const events = await replay('claude-command.jsonl')
    expect(events).toContainEqual({
      type: 'thread-ready',
      harness: 'claude',
      threadId: 'thread-fixture',
      model: 'claude-opus-5[1m]',
      permissionMode: 'bypassPermissions'
    })
  })
})
