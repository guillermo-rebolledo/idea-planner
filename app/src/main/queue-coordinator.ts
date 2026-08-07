import { Context, Data, Effect, Layer, Ref } from 'effect'
import {
  queuedSubmissionLaunchPlanSchema,
  queuedSubmissionLaunchResultSchema,
  type QueuedSubmissionLaunchPlan
} from '@shared/conversation'
import type { RunSnapshot } from '@shared/run'

interface QueueCoordinatorNativeServices {
  next(sessionId: string): Effect.Effect<unknown, QueueCoordinatorError>
  observeLaunch(input: {
    sessionId: string
    submissionId: string
    outcome: 'started' | 'not-started'
  }): Effect.Effect<unknown, QueueCoordinatorError>
  launch(
    plan: QueuedSubmissionLaunchPlan
  ): Effect.Effect<Pick<RunSnapshot, 'status'>, QueueCoordinatorError>
}

class QueueCoordinatorNative extends Context.Tag('main/QueueCoordinatorNative')<
  QueueCoordinatorNative,
  QueueCoordinatorNativeServices
>() {}

class QueueCoordinatorError extends Data.TaggedError('QueueCoordinatorError')<{
  operation: 'core' | 'launch' | 'protocol'
  cause: unknown
}> {}

interface QueueCoordinatorDeps {
  queue: {
    next(sessionId: string): Promise<unknown>
    observeLaunch(input: {
      sessionId: string
      submissionId: string
      outcome: 'started' | 'not-started'
    }): Promise<unknown>
  }
  start(plan: QueuedSubmissionLaunchPlan): Promise<Pick<RunSnapshot, 'status'>>
  runEffect?: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
}

/**
 * Main's per-Session native launch gate. Core returns the complete launch plan
 * and decides the queue transition after Main reports the native result.
 */
export class QueueCoordinator {
  private readonly sessions = Effect.runSync(
    Ref.make<ReadonlyMap<string, Effect.Semaphore>>(new Map())
  )
  private readonly native: Layer.Layer<QueueCoordinatorNative>

  constructor(private readonly deps: QueueCoordinatorDeps) {
    this.native = Layer.succeed(QueueCoordinatorNative, {
      next: (sessionId) =>
        Effect.tryPromise({
          try: () => deps.queue.next(sessionId),
          catch: (cause) => new QueueCoordinatorError({ operation: 'core', cause })
        }),
      observeLaunch: (input) =>
        Effect.tryPromise({
          try: () => deps.queue.observeLaunch(input),
          catch: (cause) => new QueueCoordinatorError({ operation: 'core', cause })
        }),
      launch: (plan) =>
        Effect.tryPromise({
          try: () => deps.start(plan),
          catch: (cause) => new QueueCoordinatorError({ operation: 'launch', cause })
        })
    })
  }

  drain(sessionId: string): Promise<void> {
    const program = Effect.gen(this, function* () {
      const semaphore = yield* this.sessionSemaphore(sessionId)
      yield* semaphore.withPermits(1)(this.drainAvailable(sessionId))
    }).pipe(Effect.provide(this.native))
    return this.deps.runEffect ? this.deps.runEffect(program) : Effect.runPromise(program)
  }

  private sessionSemaphore(sessionId: string): Effect.Effect<Effect.Semaphore> {
    return Effect.gen(this, function* () {
      const known = (yield* Ref.get(this.sessions)).get(sessionId)
      if (known) return known
      const created = yield* Effect.makeSemaphore(1)
      return yield* Ref.modify(this.sessions, (current) => {
        const existing = current.get(sessionId)
        return existing ? [existing, current] : [created, new Map(current).set(sessionId, created)]
      })
    })
  }

  private drainAvailable(
    sessionId: string
  ): Effect.Effect<void, QueueCoordinatorError, QueueCoordinatorNative> {
    return Effect.gen(this, function* () {
      const native = yield* QueueCoordinatorNative
      const raw = yield* native.next(sessionId)
      const parsed = queuedSubmissionLaunchPlanSchema.nullable().safeParse(raw)
      if (!parsed.success) {
        return yield* new QueueCoordinatorError({ operation: 'protocol', cause: parsed.error })
      }
      if (!parsed.data) return
      const plan = parsed.data
      const outcome = yield* native.launch(plan).pipe(
        Effect.map((run) =>
          run.status === 'running' || run.status === 'waiting'
            ? ('started' as const)
            : ('not-started' as const)
        ),
        Effect.catchTag('QueueCoordinatorError', (error) =>
          error.operation === 'launch' ? Effect.succeed('not-started' as const) : Effect.fail(error)
        )
      )
      const observed = yield* native.observeLaunch({
        sessionId,
        submissionId: plan.item.submissionId,
        outcome
      })
      const result = queuedSubmissionLaunchResultSchema.safeParse(observed)
      if (!result.success) {
        return yield* new QueueCoordinatorError({ operation: 'protocol', cause: result.error })
      }
      if (result.data.continueDraining) yield* this.drainAvailable(sessionId)
    })
  }
}
