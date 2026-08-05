import type { ConversationSnapshot, RunSnapshot } from '@shared/contract'

export interface SelectedConversationSnapshot {
  conversation: ConversationSnapshot
  runs: RunSnapshot[]
}

/** Suppresses state published by the owner of a previously selected Session. */
export function conversationSelectedFor(
  sessionId: string | null,
  selected: SelectedConversationSnapshot | null
): SelectedConversationSnapshot | null {
  return selected?.conversation.sessionId === sessionId ? selected : null
}

interface ConversationRefreshDependencies {
  readConversation: () => Promise<ConversationSnapshot>
  readRuns: () => Promise<RunSnapshot[]>
  publish: (snapshot: SelectedConversationSnapshot) => void
  fail?: () => void
}

const RUN_HISTORY_NOT_READ = Symbol('run-history-not-read')

/**
 * The selected Session's durable read lane. Every renderer consumer asks this
 * owner for freshness; concurrent asks collapse into one in-flight read and,
 * at most, one trailing read. An action adoption advances the revision so a
 * response that began before it can never replace the action's newer state.
 */
export class ConversationRefresh {
  private latest: SelectedConversationSnapshot | null = null
  private runsForActiveRun: string | null | typeof RUN_HISTORY_NOT_READ = RUN_HISTORY_NOT_READ
  private revision = 0
  private requested = 0
  private completed = 0
  private active: Promise<void> | null = null

  constructor(
    private readonly sessionId: string,
    private readonly dependencies: ConversationRefreshDependencies
  ) {}

  request(): Promise<void> {
    this.requested += 1
    this.active ??= this.drain().finally(() => {
      this.active = null
    })
    return this.active
  }

  /** Takes a snapshot returned by a write without waiting for a reread. */
  adopt(conversation: ConversationSnapshot): void {
    if (conversation.sessionId !== this.sessionId) return
    this.revision += 1
    this.latest = { conversation, runs: this.latest?.runs ?? [] }
    this.dependencies.publish(this.latest)
  }

  private async drain(): Promise<void> {
    while (this.completed < this.requested) {
      const requestedThrough = this.requested
      const revision = this.revision
      try {
        const conversation = await this.dependencies.readConversation()
        if (revision !== this.revision) {
          this.completed = requestedThrough
          continue
        }

        let runs = this.latest?.runs ?? []
        if (
          this.runsForActiveRun === RUN_HISTORY_NOT_READ ||
          this.runsForActiveRun !== conversation.activeRunId
        ) {
          runs = await this.dependencies.readRuns()
          if (revision !== this.revision) {
            this.completed = requestedThrough
            continue
          }
          this.runsForActiveRun = conversation.activeRunId
        }

        this.latest = { conversation, runs }
        this.dependencies.publish(this.latest)
      } catch {
        if (revision === this.revision) this.dependencies.fail?.()
      }
      this.completed = requestedThrough
    }
  }
}
