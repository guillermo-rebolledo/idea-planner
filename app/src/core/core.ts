import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Cause, Context, Effect, Exit, Layer } from 'effect'
import { z } from 'zod'
import {
  CoreError,
  startSessionInputSchema,
  type MailboxCoreQuery,
  type MailboxGroup,
  type MailboxSession,
  type MailboxSnapshot,
  type SessionSummary,
  type StartSessionInput
} from '@shared/contract'
import {
  acceptRunInputSchema,
  recordRunEventInputSchema,
  runSnapshotSchema,
  type AcceptRunInput,
  type RecordRunEventInput,
  type RunSnapshot,
  type RunStatus
} from '@shared/run'
import type {
  ConversationSnapshot,
  FinalizeConversationRunInput,
  HarnessEvent,
  SubmitConversationMessageInput
} from '@shared/conversation'
import type { ProjectView } from '@shared/project'
import { writeJsonAtomic } from './atomic'
import { suggestSessionTitle } from '@shared/title'
import { ProjectStore } from './projects'
import { SessionStore } from './sessions'
import {
  createConversationEffects,
  type ApplyHarnessEventInput,
  type BeginConversationRunInput,
  type IngestHarnessOutputInput
} from './conversation'

export interface CoreDeps {
  now?: () => Date
  randomId?: () => string
  /** App-owned state directory in userData. Never inside a Project. */
  stateDirectory?: string
}

/**
 * The deep product-behavior module. It owns the Session lifecycle and the
 * app-owned store behind it, and is the primary test seam. It runs inside the
 * Core utility process in production and directly inside tests.
 *
 * Internals are Effect (see ADR 0001); this interface stays promise-based so
 * Main and tests never see Effect types.
 */
export interface Core {
  startSession(input: StartSessionInput): Promise<SessionSummary>
  listSessions(): Promise<SessionSummary[]>
  getSession(sessionId: string): Promise<SessionSummary>
  listDamagedSessions(): Promise<string[]>
  deleteSession(sessionId: string): Promise<void>
  addProject(root: string): Promise<ProjectView>
  listProjects(): Promise<ProjectView[]>
  removeProject(root: string): Promise<void>
  queryMailbox(query: MailboxCoreQuery): Promise<MailboxSnapshot>
  setSessionPinned(sessionId: string, pinned: boolean): Promise<SessionSummary>
  setSessionArchived(sessionId: string, archived: boolean): Promise<SessionSummary>
  acceptRun(input: AcceptRunInput): Promise<RunSnapshot>
  listRuns(sessionId: string): Promise<RunSnapshot[]>
  recordRunEvent(input: RecordRunEventInput): Promise<RunSnapshot>
  getConversation(sessionId: string): Promise<ConversationSnapshot>
  submitConversationMessage(input: SubmitConversationMessageInput): Promise<ConversationSnapshot>
  beginConversationRun(input: BeginConversationRunInput): Promise<ConversationSnapshot>
  applyHarnessEvent(input: ApplyHarnessEventInput): Promise<void>
  ingestHarnessOutput(input: IngestHarnessOutputInput): Promise<HarnessEvent[]>
  finalizeConversationRun(input: FinalizeConversationRunInput): Promise<ConversationSnapshot>
}

/**
 * The same behavior as Effect values, for callers inside the Core process
 * (the utility-process dispatcher). Dependencies are already provided.
 */
export interface CoreEffects {
  startSession(input: StartSessionInput): Effect.Effect<SessionSummary, CoreError>
  listSessions(): Effect.Effect<SessionSummary[], CoreError>
  getSession(sessionId: string): Effect.Effect<SessionSummary, CoreError>
  listDamagedSessions(): Effect.Effect<string[], CoreError>
  deleteSession(sessionId: string): Effect.Effect<void, CoreError>
  addProject(root: string): Effect.Effect<ProjectView, CoreError>
  listProjects(): Effect.Effect<ProjectView[], CoreError>
  removeProject(root: string): Effect.Effect<void, CoreError>
  queryMailbox(query: MailboxCoreQuery): Effect.Effect<MailboxSnapshot, CoreError>
  setSessionPinned(sessionId: string, pinned: boolean): Effect.Effect<SessionSummary, CoreError>
  setSessionArchived(sessionId: string, archived: boolean): Effect.Effect<SessionSummary, CoreError>
  acceptRun(input: AcceptRunInput): Effect.Effect<RunSnapshot, CoreError>
  listRuns(sessionId: string): Effect.Effect<RunSnapshot[], CoreError>
  recordRunEvent(input: RecordRunEventInput): Effect.Effect<RunSnapshot, CoreError>
  getConversation(sessionId: string): Effect.Effect<ConversationSnapshot, CoreError>
  submitConversationMessage(
    input: SubmitConversationMessageInput
  ): Effect.Effect<ConversationSnapshot, CoreError>
  beginConversationRun(
    input: BeginConversationRunInput
  ): Effect.Effect<ConversationSnapshot, CoreError>
  applyHarnessEvent(input: ApplyHarnessEventInput): Effect.Effect<void, CoreError>
  ingestHarnessOutput(input: IngestHarnessOutputInput): Effect.Effect<HarnessEvent[], CoreError>
  finalizeConversationRun(
    input: FinalizeConversationRunInput
  ): Effect.Effect<ConversationSnapshot, CoreError>
}

const RUNS_DIR = 'runs'
const SUBMISSIONS_DIR = 'submissions'
const DAY_MS = 24 * 60 * 60 * 1000

class SessionClock extends Context.Tag('core/SessionClock')<SessionClock, { now(): Date }>() {}
class IdGenerator extends Context.Tag('core/IdGenerator')<IdGenerator, { nextId(): string }>() {}

type CoreServices = SessionClock | IdGenerator

export function createCoreEffects(deps: CoreDeps = {}): CoreEffects {
  const now = deps.now ?? ((): Date => new Date())
  const nextId = deps.randomId ?? ((): string => `session-${randomUUID()}`)
  const services: Layer.Layer<CoreServices> = Layer.mergeAll(
    Layer.succeed(SessionClock, { now }),
    Layer.succeed(IdGenerator, { nextId })
  )

  // Projects and Sessions are app-owned state, kept beside the app rather
  // than in any repository (ADR 0002, ADR 0005).
  const projects = new ProjectStore(deps.stateDirectory, now)
  const sessions = new SessionStore(deps.stateDirectory, now, nextId)

  const conversation = createConversationEffects({
    directoryFor: (sessionId) => sessions.directoryFor(sessionId),
    clock: Effect.sync(now)
  })
  // Serializes durable Run writes, so a read-modify-write cannot interleave.
  const writeLock = Effect.runSync(Effect.makeSemaphore(1))

  const provide = <A>(
    effect: Effect.Effect<A, CoreError, CoreServices>
  ): Effect.Effect<A, CoreError> => Effect.provide(effect, services)

  /** A Session cannot exist without a Project to work against. */
  const startSession = (rawInput: StartSessionInput): Effect.Effect<SessionSummary, CoreError> =>
    Effect.gen(function* () {
      const parsed = startSessionInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid Session input')
        )
      }
      const input = parsed.data
      const known = yield* projects.list()
      if (!known.some((project) => project.root === input.projectRoot)) {
        return yield* Effect.fail(new CoreError('INVALID_INPUT', 'That Project has not been added'))
      }
      const session = yield* sessions.start({
        projectRoot: input.projectRoot,
        title: suggestSessionTitle(input.message)
      })
      // The message is what created the Session, so a Session that exists
      // without it is a Session nobody asked for. If this cannot land, the
      // record goes with it.
      yield* conversation
        .submit({
          sessionId: session.id,
          submissionId: `start-${session.id}`,
          text: input.message,
          source: 'composer'
        })
        .pipe(
          Effect.catchAll((error) =>
            sessions.delete(session.id).pipe(Effect.andThen(Effect.fail(error)))
          )
        )
      return session
    })

  /**
   * The mailbox over the Session store. Searching is over Session titles in
   * memory: there is no corpus of documents left to index.
   */
  const queryMailbox = (query: MailboxCoreQuery): Effect.Effect<MailboxSnapshot, CoreError> =>
    sessions.list().pipe(
      Effect.map((all) => {
        const inView = all.filter((session) =>
          query.view === 'archived' ? session.archivedAt !== null : session.archivedAt === null
        )
        const terms = query.search.trim().toLowerCase().split(/\s+/).filter(Boolean)
        const dormantBefore = now().getTime() - query.dormantAfterDays * DAY_MS
        const matched = inView
          .filter((session) => {
            const title = session.title.toLowerCase()
            return terms.every((term) => title.includes(term))
          })
          .sort(
            (left, right) =>
              right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title)
          )
          .map((session): MailboxSession => ({
            ...session,
            dormant:
              query.view === 'active' &&
              session.pinned &&
              Date.parse(session.updatedAt) <= dormantBefore
          }))
        return {
          view: query.view,
          total: inView.length,
          matched: matched.length,
          groups: groupSessions(matched, query.view)
        }
      })
    )

  const acceptRun = (rawInput: AcceptRunInput): Effect.Effect<RunSnapshot, CoreError> =>
    provide(
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          const parsed = acceptRunInputSchema.safeParse(rawInput)
          if (!parsed.success) {
            return yield* Effect.fail(
              new CoreError('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid Run')
            )
          }
          const input = parsed.data
          const session = yield* sessions.get(input.sessionId)
          // A Run works on the Session's Checkout, which is the Project it
          // belongs to. Anything else would let a Run edit a directory the
          // Session never named.
          if (input.configuration.checkout !== session.projectRoot) {
            return yield* Effect.fail(
              new CoreError('INVALID_INPUT', "Run Checkout does not match the Session's Project")
            )
          }
          const sessionDir = yield* sessions.directoryFor(input.sessionId)
          const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
          const submissionKey = createHash('sha256').update(input.submissionId).digest('hex')
          const runsDir = join(sessionDir, RUNS_DIR)
          const submissionPath = join(sessionDir, SUBMISSIONS_DIR, `${submissionKey}.json`)
          const existing = yield* Effect.promise(() =>
            readFile(submissionPath, 'utf8').catch(() => null)
          )
          if (existing !== null) {
            const saved = yield* Effect.try({
              try: () => {
                const value = JSON.parse(existing) as { fingerprint?: unknown; run?: unknown }
                return {
                  fingerprint: z.string().length(64).parse(value.fingerprint),
                  run: runSnapshotSchema.parse(value.run)
                }
              },
              catch: () => new CoreError('IO_ERROR', 'Durable Run acceptance is unreadable')
            })
            if (saved.fingerprint !== fingerprint) {
              return yield* Effect.fail(
                new CoreError(
                  'INVALID_INPUT',
                  'Submission identity was already used for different content'
                )
              )
            }
            const acceptedRun = saved.run
            const current = yield* Effect.promise(() =>
              readFile(join(runsDir, `${acceptedRun.id}.json`), 'utf8').catch(() => null)
            )
            if (current === null) return acceptedRun
            return yield* Effect.try({
              try: () => runSnapshotSchema.parse(JSON.parse(current)),
              catch: () => new CoreError('IO_ERROR', 'Durable Run state is unreadable')
            })
          }
          const clock = yield* SessionClock
          const ids = yield* IdGenerator
          const timestamp = clock.now().toISOString()
          const run: RunSnapshot = {
            id: ids.nextId(),
            submissionId: input.submissionId,
            sessionId: input.sessionId,
            prompt: input.prompt,
            configuration: input.configuration,
            status: 'accepted',
            acceptedAt: timestamp,
            updatedAt: timestamp,
            activity: [
              {
                id: ids.nextId(),
                at: timestamp,
                kind: 'lifecycle',
                summary: 'Run accepted locally'
              }
            ]
          }
          // The Run record lands before the submission that names it, so a
          // torn write can leave a Run nothing points at, never a submission
          // pointing at a Run that was never written.
          yield* writeJsonAtomic(join(runsDir, `${run.id}.json`), run)
          yield* writeJsonAtomic(submissionPath, { fingerprint, run })
          return run
        })
      )
    )

  const listRuns = (sessionId: string): Effect.Effect<RunSnapshot[], CoreError> =>
    sessions.directoryFor(sessionId).pipe(
      Effect.flatMap((sessionDir) =>
        Effect.tryPromise({
          try: async () => {
            const runsDir = join(sessionDir, RUNS_DIR)
            const names = await readdir(runsDir).catch(() => [])
            const runs = await Promise.all(
              names
                .filter((name) => name.endsWith('.json'))
                .map(async (name) =>
                  runSnapshotSchema.parse(JSON.parse(await readFile(join(runsDir, name), 'utf8')))
                )
            )
            return runs.sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt))
          },
          catch: () => new CoreError('IO_ERROR', 'Could not read Run history')
        })
      )
    )

  const recordRunEvent = (input: RecordRunEventInput): Effect.Effect<RunSnapshot, CoreError> =>
    provide(
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          const parsedInput = recordRunEventInputSchema.safeParse(input)
          if (!parsedInput.success) {
            return yield* Effect.fail(
              new CoreError(
                'INVALID_INPUT',
                parsedInput.error.issues[0]?.message ?? 'Invalid Run event'
              )
            )
          }
          const event = parsedInput.data
          const sessionDir = yield* sessions.directoryFor(event.sessionId)
          const path = join(sessionDir, RUNS_DIR, `${event.runId}.json`)
          const existing = yield* Effect.tryPromise({
            try: () => readFile(path, 'utf8'),
            catch: () => new CoreError('RUN_NOT_FOUND', 'The Run was not found')
          })
          const run = yield* Effect.try({
            try: () => runSnapshotSchema.parse(JSON.parse(existing)),
            catch: () => new CoreError('IO_ERROR', 'Durable Run state is unreadable')
          })
          if (
            event.status &&
            event.status !== run.status &&
            !RUN_STATUS_TRANSITIONS[run.status].includes(event.status)
          ) {
            return yield* Effect.fail(
              new CoreError(
                'INVALID_INPUT',
                `Run cannot transition from ${run.status} to ${event.status}`
              )
            )
          }
          const clock = yield* SessionClock
          const ids = yield* IdGenerator
          const timestamp = clock.now().toISOString()
          const next = yield* Effect.try({
            try: () =>
              runSnapshotSchema.parse({
                ...run,
                ...(event.status ? { status: event.status } : {}),
                updatedAt: timestamp,
                activity: [
                  ...run.activity,
                  { id: ids.nextId(), at: timestamp, kind: event.kind, summary: event.summary }
                ]
              }),
            catch: () => new CoreError('INVALID_INPUT', 'Invalid Run event')
          })
          yield* writeJsonAtomic(path, next)
          return next
        })
      )
    )

  return {
    startSession,
    listSessions: () => sessions.list(),
    getSession: (sessionId) => sessions.get(sessionId),
    listDamagedSessions: () => sessions.listDamaged(),
    deleteSession: (sessionId) => sessions.delete(sessionId),
    addProject: (root) => projects.add(root),
    listProjects: () => projects.list(),
    removeProject: (root) => projects.remove(root),
    queryMailbox,
    setSessionPinned: (sessionId, pinned) => sessions.update(sessionId, { pinned }),
    setSessionArchived: (sessionId, archived) => sessions.update(sessionId, { archived }),
    acceptRun,
    listRuns,
    recordRunEvent,
    getConversation: (sessionId) => conversation.get(sessionId),
    submitConversationMessage: (input) => conversation.submit(input),
    beginConversationRun: (input) => conversation.begin(input),
    applyHarnessEvent: (input) => conversation.apply(input),
    ingestHarnessOutput: (input) => conversation.ingest(input),
    finalizeConversationRun: (input) => conversation.finalize(input)
  }
}

/**
 * The inbox groups. Ticket 12 owns Session status, so `needs-attention` and
 * `running` are presented and stay empty until something fills them.
 */
function groupSessions(sessions: MailboxSession[], view: MailboxCoreQuery['view']): MailboxGroup[] {
  if (view === 'archived') return [{ key: 'archived', sessions }]
  const groups: MailboxGroup[] = [
    { key: 'pinned', sessions: [] },
    { key: 'needs-attention', sessions: [] },
    { key: 'running', sessions: [] },
    { key: 'recent', sessions: [] }
  ]
  const byKey = new Map(groups.map((group) => [group.key, group]))
  for (const session of sessions) {
    byKey.get(session.pinned ? 'pinned' : 'recent')?.sessions.push(session)
  }
  return groups
}

const RUN_STATUS_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  accepted: ['starting', 'failed', 'supervision-failed'],
  starting: ['running', 'failed', 'stopped', 'policy-violation', 'supervision-failed'],
  running: ['waiting', 'completed', 'failed', 'stopped', 'policy-violation', 'supervision-failed'],
  waiting: ['running', 'completed', 'failed', 'stopped', 'policy-violation', 'supervision-failed'],
  completed: ['supervision-failed'],
  failed: ['supervision-failed'],
  stopped: ['supervision-failed'],
  'policy-violation': ['supervision-failed'],
  'supervision-failed': []
}

export function createCore(deps: CoreDeps = {}): Core {
  const core = createCoreEffects(deps)

  const run = <A>(effect: Effect.Effect<A, CoreError>): Promise<A> =>
    Effect.runPromiseExit(effect).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value
      throw Cause.squash(exit.cause)
    })

  return {
    startSession: (input) => run(core.startSession(input)),
    listSessions: () => run(core.listSessions()),
    getSession: (sessionId) => run(core.getSession(sessionId)),
    listDamagedSessions: () => run(core.listDamagedSessions()),
    deleteSession: (sessionId) => run(core.deleteSession(sessionId)),
    addProject: (root) => run(core.addProject(root)),
    listProjects: () => run(core.listProjects()),
    removeProject: (root) => run(core.removeProject(root)),
    queryMailbox: (query) => run(core.queryMailbox(query)),
    setSessionPinned: (sessionId, pinned) => run(core.setSessionPinned(sessionId, pinned)),
    setSessionArchived: (sessionId, archived) => run(core.setSessionArchived(sessionId, archived)),
    acceptRun: (input) => run(core.acceptRun(input)),
    listRuns: (sessionId) => run(core.listRuns(sessionId)),
    recordRunEvent: (input) => run(core.recordRunEvent(input)),
    getConversation: (sessionId) => run(core.getConversation(sessionId)),
    submitConversationMessage: (input) => run(core.submitConversationMessage(input)),
    beginConversationRun: (input) => run(core.beginConversationRun(input)),
    applyHarnessEvent: (input) => run(core.applyHarnessEvent(input)),
    ingestHarnessOutput: (input) => run(core.ingestHarnessOutput(input)),
    finalizeConversationRun: (input) => run(core.finalizeConversationRun(input))
  }
}
