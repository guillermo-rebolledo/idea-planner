import type { ConversationEvent } from '@shared/conversation'

const MAILBOX_REFRESH_DELAY_MS = 150

/**
 * Conversation events that can change the lifecycle or waiting state shown
 * on a Session row. Everything else is content for the open Conversation and
 * must not turn one streamed response into repeated mailbox-wide queries.
 */
function conversationEventChangesMailbox(event: ConversationEvent): boolean {
  switch (event.type) {
    case 'started':
    case 'stopped':
    case 'choices':
    case 'approval-request':
    case 'approval-resolved':
    case 'completed':
    case 'failed':
      return true
    case 'assistant-message':
    case 'reasoning':
    case 'file-change':
    case 'tool':
    case 'command':
    case 'usage':
    case 'retrying':
    case 'unsupported':
    case 'thread-ready':
      return false
  }
}

/**
 * The mailbox's coalesced Conversation lane. It owns the timer so the same
 * policy the Renderer runs is what query-count tests exercise.
 */
export class ConversationMailboxRefresh {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly refresh: () => void) {}

  handle(event: ConversationEvent): void {
    if (!conversationEventChangesMailbox(event)) return
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
