import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationEvent } from '@shared/conversation'
import { ConversationMailboxRefresh } from '../renderer/src/lib/mailbox-refresh'

describe('renderer mailbox refreshes', () => {
  afterEach(() => vi.useRealTimers())

  it('does not query the mailbox for streamed Conversation content', () => {
    vi.useFakeTimers()
    const streamed: ConversationEvent[] = [
      { type: 'assistant-message', id: 'message', text: 'One', complete: false },
      { type: 'assistant-message', id: 'message', text: 'One two', complete: true },
      { type: 'reasoning', summary: 'Considering the next step' },
      {
        type: 'command',
        id: 'command',
        command: 'pnpm test',
        output: 'Running',
        failed: false,
        running: true,
        exitCode: null,
        durationMs: null
      },
      {
        type: 'file-change',
        path: '/project/src/index.ts',
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }]
      }
    ]

    const queryMailbox = vi.fn()
    const refresh = new ConversationMailboxRefresh(queryMailbox)
    for (const event of streamed) refresh.handle(event)
    vi.runAllTimers()

    expect(queryMailbox).not.toHaveBeenCalled()
  })

  it.each<{ boundary: string; event: ConversationEvent }>([
    {
      boundary: 'Run start',
      event: { type: 'started' }
    },
    { boundary: 'Run completion', event: { type: 'completed' } },
    {
      boundary: 'Run failure',
      event: { type: 'failed', category: 'process-crash', summary: 'The Harness exited' }
    },
    {
      boundary: 'Run stop',
      event: { type: 'stopped' }
    },
    {
      boundary: 'approval request',
      event: {
        type: 'approval-request',
        id: 'approval',
        tool: 'shell',
        summary: 'Run pnpm test',
        detail: 'pnpm test',
        proposedRule: null
      }
    },
    {
      boundary: 'approval resolution',
      event: {
        type: 'approval-resolved',
        id: 'approval',
        decision: 'allowed',
        message: '',
        remembered: false
      }
    },
    {
      boundary: 'question',
      event: {
        type: 'choices',
        question: 'Which approach?',
        options: [{ id: 'first', label: 'First', value: 'Use the first approach' }]
      }
    }
  ])('queries once for the $boundary boundary', ({ event }) => {
    vi.useFakeTimers()
    const queryMailbox = vi.fn()
    const refresh = new ConversationMailboxRefresh(queryMailbox)

    refresh.handle(event)
    vi.advanceTimersByTime(149)
    expect(queryMailbox).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(queryMailbox).toHaveBeenCalledOnce()
  })
})
