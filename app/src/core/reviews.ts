import { Effect, Ref } from 'effect'
import { CoreError } from '@shared/contract'
import type { ReviewLaunch, ReviewStream } from '@shared/review'
import type { HarnessId } from '@shared/readiness'
import { createReviewAdapter, type ReviewAdapter } from './harness/codex-review'

export interface OpenReviewInput {
  reviewId: string
  harness: HarnessId
  launch: ReviewLaunch
}

export interface IngestReviewInput {
  reviewId: string
  chunk: string
}

/**
 * The review Adapters currently open, one per Review.
 *
 * Reviews are kept apart from Conversations on purpose: a Review appends
 * nothing to one and belongs to no Run, so it has no business inside the
 * module that owns Conversation state. Main owns the process; this owns the
 * protocol, exactly as it does for a Run.
 */
export interface ReviewEffects {
  open(input: OpenReviewInput): Effect.Effect<ReviewStream, CoreError>
  ingest(input: IngestReviewInput): Effect.Effect<ReviewStream, CoreError>
  /** Whatever the end of the stream implies, and the Adapter forgotten. */
  close(reviewId: string): Effect.Effect<ReviewStream, CoreError>
}

export function createReviewEffects(): ReviewEffects {
  const adapters = Effect.runSync(Ref.make<ReadonlyMap<string, ReviewAdapter>>(new Map()))

  const forget = (reviewId: string): Effect.Effect<void> =>
    Ref.update(adapters, (current) => {
      const next = new Map(current)
      next.delete(reviewId)
      return next
    })

  return {
    open: (input) =>
      Effect.gen(function* () {
        const adapter = createReviewAdapter(input.harness, input.launch)
        // A Harness with no review capability is refused out loud rather than
        // answered with an empty review: nothing found and nothing asked are
        // very different things to tell somebody.
        if (!adapter) {
          return yield* Effect.fail(
            new CoreError('INVALID_INPUT', `${input.harness} cannot review a Session's changes`)
          )
        }
        yield* Ref.update(adapters, (current) => new Map(current).set(input.reviewId, adapter))
        return { events: [], outgoing: adapter.takeOutgoing() }
      }),
    ingest: (input) =>
      Effect.gen(function* () {
        const adapter = (yield* Ref.get(adapters)).get(input.reviewId)
        if (!adapter) return { events: [], outgoing: [] }
        const events = adapter.ingest(input.chunk)
        return { events, outgoing: adapter.takeOutgoing() }
      }),
    close: (reviewId) =>
      Effect.gen(function* () {
        const adapter = (yield* Ref.get(adapters)).get(reviewId)
        if (!adapter) return { events: [], outgoing: [] }
        const events = adapter.flush()
        yield* forget(reviewId)
        return { events, outgoing: [] }
      })
  }
}
