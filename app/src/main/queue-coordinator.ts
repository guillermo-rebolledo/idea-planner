import { queuedSubmissionEntrySchema, type QueuedSubmission } from '@shared/conversation'
import type { CoreCommand } from '@shared/contract'
import type { RunSnapshot } from '@shared/run'

interface QueueCoordinatorDeps {
  core: { send(command: CoreCommand): Promise<unknown> }
  start(
    sessionId: string,
    item: QueuedSubmission
  ): Promise<Pick<RunSnapshot, 'status'> & { recovered: boolean }>
  pause(sessionId: string): Promise<unknown>
}

/**
 * Main's per-Session launch gate for Queued Submissions. Core owns durable
 * ordering and claims; this class owns the one native side effect Core cannot:
 * contacting a Harness. A promise chain per Session prevents two callers from
 * crossing the claim/start boundary together.
 */
export class QueueCoordinator {
  private readonly sessions = new Map<string, Promise<void>>()

  constructor(private readonly deps: QueueCoordinatorDeps) {}

  drain(sessionId: string): Promise<void> {
    const previous = this.sessions.get(sessionId) ?? Promise.resolve()
    const next = previous.then(
      () => this.drainOne(sessionId),
      () => this.drainOne(sessionId)
    )
    this.sessions.set(sessionId, next)
    void next.finally(() => {
      if (this.sessions.get(sessionId) === next) this.sessions.delete(sessionId)
    })
    return next
  }

  private async drainOne(sessionId: string): Promise<void> {
    const raw = await this.deps.core.send({ type: 'conversation/queue-claim', sessionId })
    const parsed = queuedSubmissionEntrySchema.nullable().safeParse(raw)
    if (!parsed.success || !parsed.data) return
    try {
      const run = await this.deps.start(sessionId, parsed.data)
      if (run.recovered || run.status === 'running' || run.status === 'waiting') {
        await this.deps.core.send({
          type: 'conversation/queue-sent',
          input: { sessionId, submissionId: parsed.data.submissionId }
        })
        if (run.recovered) await this.drainOne(sessionId)
      } else {
        await this.release(sessionId, parsed.data.submissionId)
        await this.deps.pause(sessionId)
      }
    } catch {
      await this.release(sessionId, parsed.data.submissionId)
      await this.deps.pause(sessionId)
    }
  }

  private async release(sessionId: string, submissionId: string): Promise<void> {
    await this.deps.core.send({
      type: 'conversation/queue-release',
      input: { sessionId, submissionId }
    })
  }
}
