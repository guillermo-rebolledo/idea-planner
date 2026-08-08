import type {
  CreatePullRequestInput,
  CreatePullRequestResult,
  MailboxSnapshot,
  PreparePullRequestResult,
  SessionSummary
} from '@shared/contract'
import { checkoutDirectory } from '@shared/checkout'
import { Context, Effect, Layer, Ref } from 'effect'
import { currentBranch, observeCheckoutState } from './git'
import type { GitHubClient } from './github'
import type { PullRequestStore } from './pull-request-store'

export interface PullRequestServiceDependenciesShape {
  github: GitHubClient
  store: PullRequestStore
  observeState?: typeof observeCheckoutState
  readBranch?: typeof currentBranch
  now?: () => number
}

export class PullRequestServiceDependencies extends Context.Tag(
  'argos/PullRequestServiceDependencies'
)<PullRequestServiceDependencies, PullRequestServiceDependenciesShape>() {}

export function makePullRequestService(
  dependencies: PullRequestServiceDependenciesShape
): Effect.Effect<PullRequestService> {
  return PullRequestService.make.pipe(
    Effect.provide(Layer.succeed(PullRequestServiceDependencies, dependencies))
  )
}

export interface PullRequestDraftContext {
  changedFiles: { path: string; changeKind: 'added' | 'changed' | 'deleted' }[]
  unlisted: number
  messages: string[]
}

const MAX_DESCRIPTION_CONTEXT = 80_000

/** Mechanical fallback: only durable Session evidence, bounded before it reaches the editable field. */
export function buildPullRequestBody(title: string, context?: PullRequestDraftContext): string {
  const lines = ['## Summary', '', `- ${title}`]
  if (context && context.changedFiles.length > 0) {
    lines.push('', '### Files')
    let listed = 0
    for (const file of context.changedFiles) {
      const label =
        file.changeKind === 'added'
          ? 'Added'
          : file.changeKind === 'deleted'
            ? 'Deleted'
            : 'Changed'
      const candidate = `- ${label} \`${file.path}\``
      if ([...lines, candidate].join('\n').length > MAX_DESCRIPTION_CONTEXT) break
      lines.push(candidate)
      listed += 1
    }
    if (listed < context.changedFiles.length) {
      lines.push(`- ${String(context.changedFiles.length - listed)} more files not listed`)
    }
    if (context.unlisted > 0)
      lines.push(`- ${String(context.unlisted)} more changed files not listed`)
  }
  const messages = context?.messages.map((message) => message.trim()).filter(Boolean) ?? []
  if (messages.length > 0) {
    lines.push('', '## Context', '')
    for (const message of messages) {
      const oneLine = message.replace(/\s+/gu, ' ').slice(0, 1_000)
      if ([...lines, `- ${oneLine}`].join('\n').length > MAX_DESCRIPTION_CONTEXT) break
      lines.push(`- ${oneLine}`)
    }
  }
  lines.push('', '## Testing', '', '- Not run')
  return lines.join('\n').slice(0, MAX_DESCRIPTION_CONTEXT)
}

const SUCCESS_TTL_MS = 2 * 60_000
const FAILURE_TTL_MS = 20_000
const MAX_FAILURE_TTL_MS = 15 * 60_000

interface CachedPullRequest {
  value: NonNullable<MailboxSnapshot['projects'][number]['sessions'][number]['pullRequest']>
  expiresAt: number
  failures: number
}

function cacheKey(session: SessionSummary, url: string): string {
  return `${session.id}\u0000${checkoutDirectory(session.projectRoot, session.checkout)}\u0000${url}`
}

function expiryFor(state: string, now: () => number): number {
  return state === 'merged' || state === 'closed'
    ? Number.POSITIVE_INFINITY
    : now() + SUCCESS_TTL_MS
}

/** User-triggered publishing and demand-driven remote state for Session rows. */
export class PullRequestService {
  private readonly github: GitHubClient
  private readonly store: PullRequestStore
  private readonly observeState: typeof observeCheckoutState
  private readonly readBranch: typeof currentBranch
  private readonly now: () => number
  private readonly cache: Ref.Ref<Map<string, CachedPullRequest>>

  private constructor(
    options: PullRequestServiceDependenciesShape,
    cache: Ref.Ref<Map<string, CachedPullRequest>>
  ) {
    this.github = options.github
    this.store = options.store
    this.observeState = options.observeState ?? observeCheckoutState
    this.readBranch = options.readBranch ?? currentBranch
    this.now = options.now ?? Date.now
    this.cache = cache
  }

  static readonly make = Effect.gen(function* () {
    const options = yield* PullRequestServiceDependencies
    const cache = yield* Ref.make(new Map<string, CachedPullRequest>())
    return new PullRequestService(options, cache)
  })

  prepare(
    session: SessionSummary,
    context?: PullRequestDraftContext
  ): Effect.Effect<PreparePullRequestResult> {
    const { github, observeState, readBranch } = this
    return Effect.gen(function* () {
      if (session.checkout.kind !== 'worktree') {
        return { status: 'unavailable' as const, reason: 'local-checkout' as const }
      }
      const checkout = checkoutDirectory(session.projectRoot, session.checkout)
      const state = yield* Effect.promise(() => observeState(checkout))
      if (state.status !== 'observed' || state.state !== 'clean') {
        return {
          status: 'unavailable' as const,
          reason: 'checkout-busy' as const,
          detail:
            state.status === 'observed'
              ? `Git reports ${state.state}. Finish that operation before publishing.`
              : 'The Checkout cannot be read safely right now.'
        }
      }
      const branch = yield* Effect.promise(() => readBranch(checkout))
      if (!branch) return { status: 'unavailable' as const, reason: 'detached-head' as const }
      const readiness = yield* github.readiness(checkout)
      if (readiness.status !== 'ready') {
        const reason =
          readiness.status === 'unavailable'
            ? ('gh-unavailable' as const)
            : readiness.status === 'unauthenticated'
              ? ('gh-unauthenticated' as const)
              : ('github-unavailable' as const)
        return { status: 'unavailable' as const, reason, detail: readiness.detail }
      }
      const baseBranch = session.checkout.baseBranch ?? (yield* github.defaultBranch(checkout))
      if (!baseBranch) {
        return {
          status: 'unavailable' as const,
          reason: 'github-unavailable' as const,
          detail: 'GitHub could not determine this repository’s default branch.'
        }
      }
      return {
        status: 'ready' as const,
        baseBranch,
        headBranch: branch,
        title: session.title.slice(0, 200),
        body: buildPullRequestBody(session.title, context)
      }
    })
  }

  create(
    session: SessionSummary,
    input: CreatePullRequestInput
  ): Effect.Effect<CreatePullRequestResult> {
    const { cache, github, now, observeState, store } = this
    return Effect.gen(function* () {
      if (session.checkout.kind !== 'worktree') {
        return {
          status: 'failed' as const,
          detail: 'Pull Requests are available for Worktree Sessions only.'
        }
      }
      const checkout = checkoutDirectory(session.projectRoot, session.checkout)
      const state = yield* Effect.promise(() => observeState(checkout))
      if (state.status !== 'observed' || state.state !== 'clean') {
        return {
          status: 'failed' as const,
          detail: 'Finish the current Git operation before publishing.'
        }
      }
      const result = yield* github.create({
        checkout,
        baseBranch: input.baseBranch,
        title: input.title,
        body: input.body
      })
      if (result.status !== 'failed') {
        yield* Effect.promise(() => store.write(session.id, result.pullRequest))
        yield* Ref.update(cache, (current) => {
          const next = new Map(current)
          next.set(cacheKey(session, result.pullRequest.url), {
            value: result.pullRequest,
            expiresAt: expiryFor(result.pullRequest.state, now),
            failures: 0
          })
          return next
        })
      }
      return result
    })
  }

  /** Refreshes only PRs the person created here; failures retain the last known state. */
  attachToMailbox(snapshot: MailboxSnapshot): Effect.Effect<MailboxSnapshot> {
    const { cache, github, now, store } = this
    const attach = (
      session: MailboxSnapshot['projects'][number]['sessions'][number]
    ): Effect.Effect<MailboxSnapshot['projects'][number]['sessions'][number]> =>
      Effect.gen(function* () {
        const stored = yield* Effect.promise(() => store.read(session.id))
        if (!stored) return { ...session, pullRequest: null }
        if (stored.state === 'merged' || stored.state === 'closed') {
          return { ...session, pullRequest: stored }
        }
        const checkout = checkoutDirectory(session.projectRoot, session.checkout)
        const key = cacheKey(session, stored.url)
        const current = yield* Ref.get(cache)
        const cached = current.get(key)
        if (cached && cached.expiresAt > now()) {
          return { ...session, pullRequest: cached.value }
        }
        const fresh = yield* github.get(checkout, stored.url)
        if (fresh) {
          yield* Effect.promise(() => store.write(session.id, fresh))
          yield* Ref.update(cache, (value) => {
            const next = new Map(value)
            next.set(key, {
              value: fresh,
              expiresAt: expiryFor(fresh.state, now),
              failures: 0
            })
            return next
          })
          return { ...session, pullRequest: fresh }
        }
        const failures = (cached?.failures ?? 0) + 1
        yield* Ref.update(cache, (value) => {
          const next = new Map(value)
          next.set(key, {
            value: cached?.value ?? stored,
            expiresAt:
              now() + Math.min(FAILURE_TTL_MS * 2 ** Math.max(0, failures - 1), MAX_FAILURE_TTL_MS),
            failures
          })
          return next
        })
        return { ...session, pullRequest: cached?.value ?? stored }
      })
    const attachGroups = (
      groups: MailboxSnapshot['projects']
    ): Effect.Effect<MailboxSnapshot['projects']> =>
      Effect.gen(function* () {
        const attached: MailboxSnapshot['projects'] = []
        for (const group of groups) {
          const sessions = []
          for (const session of group.sessions) sessions.push(yield* attach(session))
          attached.push({ ...group, sessions })
        }
        return attached
      })
    return Effect.gen(function* () {
      return {
        ...snapshot,
        pinned: yield* attachGroups(snapshot.pinned),
        projects: yield* attachGroups(snapshot.projects)
      }
    })
  }

  forget(sessionId: string): Effect.Effect<void> {
    const { cache, store } = this
    return Effect.gen(function* () {
      yield* Ref.update(cache, (current) => {
        const next = new Map(current)
        for (const key of next.keys()) {
          if (key.startsWith(`${sessionId}\u0000`)) next.delete(key)
        }
        return next
      })
      yield* Effect.promise(() => store.forget(sessionId))
    })
  }
}
