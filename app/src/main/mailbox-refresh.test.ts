import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationStreamEvent } from '@shared/conversation'
import { ConversationMailboxRefresh } from '../renderer/src/lib/mailbox-refresh'

describe('renderer mailbox refreshes', () => {
  afterEach(() => vi.useRealTimers())

  it('does not query the mailbox without lifecycle invalidation', () => {
    vi.useFakeTimers()
    const streamed: ConversationStreamEvent = {
      sessionId: 'session',
      runId: 'run',
      invalidation: 'none',
      event: { type: 'assistant-message', id: 'message', text: 'One', complete: false }
    }

    const queryMailbox = vi.fn()
    const refresh = new ConversationMailboxRefresh(queryMailbox)
    refresh.handle(streamed)
    vi.runAllTimers()

    expect(queryMailbox).not.toHaveBeenCalled()
  })

  it('queries once for explicit lifecycle invalidation', () => {
    vi.useFakeTimers()
    const queryMailbox = vi.fn()
    const refresh = new ConversationMailboxRefresh(queryMailbox)

    refresh.handle({
      sessionId: 'session',
      runId: 'run',
      invalidation: 'mailbox',
      event: { type: 'started' }
    })
    vi.advanceTimersByTime(149)
    expect(queryMailbox).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(queryMailbox).toHaveBeenCalledOnce()
  })
})
