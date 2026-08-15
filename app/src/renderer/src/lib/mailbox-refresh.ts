import type { ConversationStreamEvent } from '@shared/conversation'

const MAILBOX_REFRESH_DELAY_MS = 150

/**
 * The coalesced Conversation lane for anything read back when a Run starts or
 * ends: the mailbox's rows, and the New Session composer's Checkout default.
 * It owns the timer so the same policy the Renderer runs is what query-count
 * tests exercise.
 */
export class ConversationMailboxRefresh {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly refresh: () => void) {}

  handle(streamed: ConversationStreamEvent): void {
    if (streamed.invalidation !== 'mailbox') return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.refresh()
    }, MAILBOX_REFRESH_DELAY_MS)
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}
