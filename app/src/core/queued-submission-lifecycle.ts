import * as Effect from 'effect/Effect'
import { CoreError } from '@shared/contract'
import type {
  ConversationSnapshot,
  QueuedSubmission,
  QueuedSubmissionChange,
  QueuedSubmissionLaunchObservation,
  QueuedSubmissionLaunchPlan,
  QueuedSubmissionLaunchResult
} from '@shared/conversation'
import { PROJECT_SKILL_TRUST_FAILURE, type RunSnapshot } from '@shared/run'
import type { ConversationEffects } from './conversation'

const MAX_ATTEMPTS = 20

interface QueuedSubmissionLifecycleDeps {
  conversation: ConversationEffects
  runs(sessionId: string): Effect.Effect<RunSnapshot[], CoreError>
}

/**
 * Core's complete Queued Submission seam. The Conversation is its durable
 * journal adapter; callers express lifecycle intent and cannot sequence the
 * editability, ordering, claim, retry, recovery, or disposition primitives.
 */
export interface QueuedSubmissionLifecycle {
  change(change: QueuedSubmissionChange): Effect.Effect<ConversationSnapshot, CoreError>
  next(sessionId: string): Effect.Effect<QueuedSubmissionLaunchPlan | null, CoreError>
  observeLaunch(
    input: QueuedSubmissionLaunchObservation
  ): Effect.Effect<QueuedSubmissionLaunchResult, CoreError>
}

function promptFor(item: QueuedSubmission): string {
  return item.reviewAttachments.length === 0
    ? item.text
    : `${item.text}\n\nReview attachments:\n${item.reviewAttachments
        .map((attachment) => `- ${attachment.path}`)
        .join('\n')}`
}

function attemptsFor(item: QueuedSubmission, runs: RunSnapshot[]): RunSnapshot[] {
  return runs.filter(
    (run) =>
      run.submissionId === item.submissionId ||
      run.submissionId.startsWith(`${item.submissionId}:attempt-`)
  )
}

function matches(item: QueuedSubmission, prompt: string, run: RunSnapshot): boolean {
  return (
    run.prompt === prompt &&
    run.configuration.harness === item.harness &&
    run.configuration.model === item.model &&
    run.configuration.effort === item.effort &&
    run.configuration.permissionMode === item.permissionMode &&
    (run.configuration.skill?.name ?? null) === item.skill
  )
}

function nextAttemptIdentity(item: QueuedSubmission, attempts: RunSnapshot[]): string | null {
  if (attempts.length === 0) return item.submissionId
  const used = new Set(attempts.map((run) => run.submissionId))
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
    const candidate = `${item.submissionId}:attempt-${String(attempt)}`
    if (!used.has(candidate)) return candidate
  }
  return null
}

export function createQueuedSubmissionLifecycle(
  deps: QueuedSubmissionLifecycleDeps
): QueuedSubmissionLifecycle {
  const next = (sessionId: string): Effect.Effect<QueuedSubmissionLaunchPlan | null, CoreError> =>
    Effect.gen(function* () {
      const item = yield* deps.conversation.claimQueued(sessionId)
      if (!item) return null
      const prompt = promptFor(item)
      const attempts = attemptsFor(item, yield* deps.runs(sessionId))
      const newest = attempts[0]
      const stoppedBeforeHarness = newest?.activity.some(
        (activity) => activity.summary === PROJECT_SKILL_TRUST_FAILURE
      )
      if (newest && matches(item, prompt, newest) && !stoppedBeforeHarness) {
        yield* deps.conversation.observeQueuedLaunch({
          sessionId,
          submissionId: item.submissionId,
          outcome: 'reconciled'
        })
        return yield* next(sessionId)
      }
      const runSubmissionId = nextAttemptIdentity(item, attempts)
      if (!runSubmissionId) {
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', 'No Run attempt identity is available')
        )
      }
      return { sessionId, item, runSubmissionId, prompt }
    })

  return {
    change: (change) => {
      switch (change.type) {
        case 'enqueue':
          return deps.conversation.enqueue(change.input)
        case 'edit':
          return deps.conversation.editQueued(change.input)
        case 'move':
          return deps.conversation.moveQueued(change.input)
        case 'cancel':
          return deps.conversation.cancelQueued(change.input)
        case 'pause':
          return deps.conversation.setQueuePaused({ sessionId: change.sessionId, paused: true })
        case 'resume':
          return deps.conversation.setQueuePaused({ sessionId: change.sessionId, paused: false })
        case 'send-now':
          return deps.conversation.prioritizeQueued(change.input)
      }
    },
    next,
    observeLaunch: (input) => deps.conversation.observeQueuedLaunch(input)
  }
}
