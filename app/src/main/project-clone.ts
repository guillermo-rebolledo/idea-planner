import { basename, dirname, isAbsolute } from 'node:path'
import type {
  ChooseProjectResult,
  ProjectCloneEvent,
  ProjectCloneInput,
  ProjectCloneStarted
} from '@shared/contract'
import { isSupportedGitRemote } from '@shared/project'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Ref from 'effect/Ref'
import { safeGitHubDetail } from './github'
import {
  NativeProjectClone,
  ProjectCloneProcessError,
  type ProjectCloneLaunch
} from './project-clone-native'
import type { MainEffectRuntime } from './run-process-broker'

const MAX_PROGRESS_DETAIL = 500

type ProjectRootResolution =
  { status: 'resolved'; root: string } | { status: 'not-a-repository' | 'git-unavailable' }

interface ProjectCloneServiceOptions {
  runtime: MainEffectRuntime
  hooksDirectory: string
  emit: (event: ProjectCloneEvent) => void
  resolveRoot: (path: string) => Promise<ProjectRootResolution>
  acceptProject: (root: string) => Promise<ChooseProjectResult>
}

interface ActiveClone {
  fiber: Fiber.RuntimeFiber<unknown>
  gate: Deferred.Deferred<undefined>
}

function errorCode(error: unknown): string | number | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  const code = error.code
  return typeof code === 'string' || typeof code === 'number' ? code : null
}

function errorDetail(error: unknown): string {
  if (error instanceof ProjectCloneProcessError && error.stderr.trim()) {
    return safeGitHubDetail(error.stderr)
  }
  return safeGitHubDetail(error)
}

function phaseFor(detail: string): Extract<ProjectCloneEvent, { type: 'progress' }>['phase'] {
  const text = detail.toLowerCase()
  if (text.includes('receiving') || text.includes('counting') || text.includes('compressing'))
    return 'receiving'
  if (text.includes('resolving')) return 'resolving'
  if (text.includes('checking out') || text.includes('updating files')) return 'checking-out'
  return 'starting'
}

function cloneFailure(
  error: unknown,
  source: ProjectCloneInput['source']
): {
  reason: Extract<ProjectCloneEvent, { type: 'failed' }>['reason']
  detail: string
} {
  const detail = errorDetail(error)
  const lower = detail.toLowerCase()
  const code = errorCode(error)
  if (error instanceof ProjectCloneProcessError && error.timedOut) {
    return { reason: 'timed-out', detail: 'The clone stopped after ten minutes without progress.' }
  }
  if (code === 'ENOENT') {
    return source === 'github'
      ? { reason: 'github-unavailable', detail: 'Install the GitHub CLI, then try again.' }
      : { reason: 'git-unavailable', detail: 'Install Git, then try again.' }
  }
  if (
    lower.includes('gh auth login') ||
    lower.includes('not logged in') ||
    lower.includes('no oauth token')
  ) {
    return {
      reason: 'github-unauthenticated',
      detail: 'Sign in with the GitHub CLI, then try again.'
    }
  }
  if (
    lower.includes('authentication failed') ||
    lower.includes('permission denied') ||
    lower.includes('publickey')
  ) {
    return { reason: 'authentication', detail: 'Authentication failed for this repository.' }
  }
  if (
    lower.includes('repository not found') ||
    lower.includes('could not read from remote repository')
  ) {
    return { reason: 'not-found', detail: 'The repository was not found or is not accessible.' }
  }
  if (
    lower.includes('could not resolve host') ||
    lower.includes('connection timed out') ||
    lower.includes('connection refused') ||
    lower.includes('network is unreachable') ||
    code === 'ETIMEDOUT'
  ) {
    return { reason: 'network', detail: 'The repository could not be reached.' }
  }
  return { reason: 'unknown', detail: detail || 'The repository could not be cloned.' }
}

/** Main-owned clone operations. Active fibers live in Main's one Effect runtime. */
export class ProjectCloneService {
  private readonly active: Promise<Ref.Ref<Map<string, ActiveClone>>>

  constructor(private readonly options: ProjectCloneServiceOptions) {
    this.active = options.runtime.runPromise(Ref.make(new Map<string, ActiveClone>()))
  }

  start(input: ProjectCloneInput): Promise<ProjectCloneStarted> {
    return this.options.runtime.runPromise(
      Effect.gen(this, function* () {
        const native = yield* NativeProjectClone
        const operationId = native.operationId()
        const gate = yield* Deferred.make<undefined>()
        const active = yield* Effect.promise(() => this.active)
        const operation = this.execute(operationId, input).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() =>
              this.options.emit({
                type: 'cancelled',
                operationId,
                destination: input.destination
              })
            )
          ),
          Effect.ensuring(
            Ref.update(active, (current) => {
              const next = new Map(current)
              next.delete(operationId)
              return next
            })
          )
        )
        const fiber = yield* Effect.forkDaemon(Deferred.await(gate).pipe(Effect.andThen(operation)))
        yield* Ref.update(active, (current) => new Map(current).set(operationId, { fiber, gate }))
        return { operationId }
      })
    )
  }

  begin(operationId: string): Promise<void> {
    return this.options.runtime.runPromise(
      Effect.gen(this, function* () {
        const active = yield* Effect.promise(() => this.active)
        const operation = (yield* Ref.get(active)).get(operationId)
        if (operation) yield* Deferred.succeed(operation.gate, undefined)
      })
    )
  }

  cancel(operationId: string): Promise<void> {
    return this.options.runtime.runPromise(
      Effect.gen(this, function* () {
        const active = yield* Effect.promise(() => this.active)
        const operation = (yield* Ref.get(active)).get(operationId)
        if (operation) yield* Fiber.interrupt(operation.fiber)
      })
    )
  }

  cancelAll(): Promise<void> {
    return this.options.runtime.runPromise(
      Effect.gen(this, function* () {
        const active = yield* Effect.promise(() => this.active)
        const operations = [...(yield* Ref.get(active)).values()]
        yield* Fiber.interruptAll(operations.map(({ fiber }) => fiber))
      })
    )
  }

  private execute(
    operationId: string,
    input: ProjectCloneInput
  ): Effect.Effect<unknown, never, NativeProjectClone> {
    const destination = input.destination
    const fail = (
      reason: Extract<ProjectCloneEvent, { type: 'failed' }>['reason'],
      detail: string
    ): void => this.options.emit({ type: 'failed', operationId, reason, detail, destination })
    const progress = (detail: string): void =>
      this.options.emit({
        type: 'progress',
        operationId,
        phase: phaseFor(detail),
        detail: safeGitHubDetail(detail).slice(0, MAX_PROGRESS_DETAIL)
      })

    return Effect.gen(this, function* () {
      const native = yield* NativeProjectClone
      if (!isAbsolute(destination) || basename(destination) === '') {
        fail('invalid-source', 'Choose a valid destination folder.')
        return
      }
      if (input.source === 'git-url' && !isSupportedGitRemote(input.url)) {
        fail('invalid-source', 'Enter an HTTPS or SSH Git URL.')
        return
      }
      if (
        input.source === 'github' &&
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository)
      ) {
        fail('invalid-source', 'Choose a valid GitHub repository.')
        return
      }

      const parent = dirname(destination)
      const parentAvailable = yield* Effect.tryPromise({
        try: () => native.isDirectory(parent),
        catch: () => false
      })
      if (!parentAvailable) {
        fail('destination-unavailable', 'The destination’s parent folder is not available.')
        return
      }
      const reserved = yield* Effect.tryPromise({
        try: () => native.reserveDestination(destination, this.options.hooksDirectory),
        catch: (error) => error
      }).pipe(Effect.either)
      if (reserved._tag === 'Left') {
        fail(
          errorCode(reserved.left) === 'EEXIST' ? 'destination-exists' : 'destination-unavailable',
          errorCode(reserved.left) === 'EEXIST'
            ? 'That destination already exists.'
            : 'The destination could not be reserved.'
        )
        return
      }

      yield* Effect.acquireUseRelease(
        Effect.succeed(reserved.right),
        () =>
          Effect.gen(this, function* () {
            progress('Starting clone…')
            const launch: ProjectCloneLaunch = {
              command: input.source === 'github' ? 'gh' : 'git',
              args:
                input.source === 'github'
                  ? [
                      'repo',
                      'clone',
                      input.repository,
                      destination,
                      '--no-upstream',
                      '--',
                      '--progress',
                      '--config',
                      `core.hooksPath=${reserved.right.hooksDirectory}`,
                      '--config',
                      'protocol.allow=never',
                      '--config',
                      'protocol.https.allow=always',
                      '--config',
                      'protocol.ssh.allow=always'
                    ]
                  : [
                      '-c',
                      `core.hooksPath=${reserved.right.hooksDirectory}`,
                      '-c',
                      'protocol.allow=never',
                      '-c',
                      'protocol.https.allow=always',
                      '-c',
                      'protocol.ssh.allow=always',
                      'clone',
                      '--progress',
                      '--',
                      input.url,
                      destination
                    ],
              cwd: parent,
              onProgress: progress
            }
            yield* native.execute(launch)
            this.options.emit({
              type: 'progress',
              operationId,
              phase: 'verifying',
              detail: 'Verifying Project…'
            })
            const resolutionResult = yield* Effect.tryPromise({
              try: () => this.options.resolveRoot(destination),
              catch: (error) => error
            }).pipe(Effect.either)
            if (resolutionResult._tag === 'Left') {
              fail(
                'add-failed',
                `Cloned to ${destination}, but it could not be added as a Project.`
              )
              return
            }
            const resolution = resolutionResult.right
            if (resolution.status !== 'resolved' || resolution.root !== destination) {
              fail(
                'add-failed',
                `Cloned to ${destination}, but Git did not resolve it as that Project.`
              )
              return
            }
            this.options.emit({
              type: 'progress',
              operationId,
              phase: 'adding',
              detail: 'Adding Project…'
            })
            const acceptedResult = yield* Effect.tryPromise({
              try: () => this.options.acceptProject(destination),
              catch: (error) => error
            }).pipe(Effect.either)
            if (acceptedResult._tag === 'Left') {
              fail(
                'add-failed',
                `Cloned to ${destination}, but it could not be added as a Project.`
              )
              return
            }
            const accepted = acceptedResult.right
            if (accepted.status !== 'added') {
              fail(
                'add-failed',
                `Cloned to ${destination}, but it could not be added as a Project.`
              )
              return
            }
            this.options.emit({ type: 'completed', operationId, project: accepted.project })
          }),
        (reservation) =>
          Effect.tryPromise({
            try: () => reservation.release(),
            catch: () => undefined
          }).pipe(Effect.catchAll(() => Effect.void))
      )
    }).pipe(
      Effect.catchAll((error) => {
        const failure = cloneFailure(error, input.source)
        return Effect.sync(() => fail(failure.reason, failure.detail))
      })
    )
  }
}
