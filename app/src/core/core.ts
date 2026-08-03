import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Cause, Context, Effect, Exit, Layer } from 'effect'
import { z } from 'zod'
import {
  checkoutDirectory,
  CoreError,
  startSessionInputSchema,
  type MailboxCoreQuery,
  type MailboxProject,
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
  HarnessStream,
  RecordCheckoutChangesInput,
  SubmitConversationMessageInput,
  UnfinishedRun
} from '@shared/conversation'
import type { ProjectView } from '@shared/project'
import type { HarnessId } from '@shared/readiness'
import {
  grantStandingApprovalInputSchema,
  type GrantStandingApprovalInput,
  type RevokeStandingApprovalInput,
  type StandingApproval
} from '@shared/approval'
import { writeJsonAtomic } from './atomic'
import { describeState } from './session-state'
import { suggestSessionTitle } from '@shared/title'
import { ProjectStore } from './projects'
import { SessionStore } from './sessions'
import { StandingApprovalStore } from './approvals'
import {
  createConversationEffects,
  type ApplyHarnessEventInput,
  type BeginConversationRunInput,
  type AnswerHarnessInput,
  type IngestHarnessOutputInput,
  type OpenHarnessInput
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
  setProjectSkillsTrusted(root: string, trusted: boolean): Promise<ProjectView>
  grantStandingApproval(input: GrantStandingApprovalInput): Promise<StandingApproval>
  listStandingApprovals(projectRoot: string): Promise<StandingApproval[]>
  standingApprovalRules(projectRoot: string, harness: HarnessId): Promise<string[]>
  revokeStandingApproval(input: RevokeStandingApprovalInput): Promise<void>
  queryMailbox(query: MailboxCoreQuery): Promise<MailboxSnapshot>
  setSessionPinned(sessionId: string, pinned: boolean): Promise<SessionSummary>
  setSessionArchived(sessionId: string, archived: boolean): Promise<SessionSummary>
  renameSession(sessionId: string, title: string): Promise<SessionSummary>
  acceptRun(input: AcceptRunInput): Promise<RunSnapshot>
  listRuns(sessionId: string): Promise<RunSnapshot[]>
  recordRunEvent(input: RecordRunEventInput): Promise<RunSnapshot>
  getConversation(sessionId: string): Promise<ConversationSnapshot>
  submitConversationMessage(input: SubmitConversationMessageInput): Promise<ConversationSnapshot>
  beginConversationRun(input: BeginConversationRunInput): Promise<ConversationSnapshot>
  applyHarnessEvent(input: ApplyHarnessEventInput): Promise<void>
  openHarness(input: OpenHarnessInput): Promise<HarnessStream>
  answerHarnessApproval(
    input: AnswerHarnessInput
  ): Promise<{ answered: boolean; outgoing: string[] }>
  interruptHarness(runId: string): Promise<string[]>
  ingestHarnessOutput(input: IngestHarnessOutputInput): Promise<HarnessStream>
  recordCheckoutChanges(input: RecordCheckoutChangesInput): Promise<void>
  listUnfinishedRuns(): Promise<UnfinishedRun[]>
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
  setProjectSkillsTrusted(root: string, trusted: boolean): Effect.Effect<ProjectView, CoreError>
  grantStandingApproval(
    input: GrantStandingApprovalInput
  ): Effect.Effect<StandingApproval, CoreError>
  listStandingApprovals(projectRoot: string): Effect.Effect<StandingApproval[], CoreError>
  standingApprovalRules(projectRoot: string, harness: HarnessId): Effect.Effect<string[], CoreError>
  revokeStandingApproval(input: RevokeStandingApprovalInput): Effect.Effect<void, CoreError>
  queryMailbox(query: MailboxCoreQuery): Effect.Effect<MailboxSnapshot, CoreError>
  setSessionPinned(sessionId: string, pinned: boolean): Effect.Effect<SessionSummary, CoreError>
  setSessionArchived(sessionId: string, archived: boolean): Effect.Effect<SessionSummary, CoreError>
  renameSession(sessionId: string, title: string): Effect.Effect<SessionSummary, CoreError>
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
  openHarness(input: OpenHarnessInput): Effect.Effect<HarnessStream, CoreError>
  answerHarnessApproval(
    input: AnswerHarnessInput
  ): Effect.Effect<{ answered: boolean; outgoing: string[] }, CoreError>
  interruptHarness(runId: string): Effect.Effect<string[], CoreError>
  ingestHarnessOutput(input: IngestHarnessOutputInput): Effect.Effect<HarnessStream, CoreError>
  recordCheckoutChanges(input: RecordCheckoutChangesInput): Effect.Effect<void, CoreError>
  listUnfinishedRuns(): Effect.Effect<UnfinishedRun[], CoreError>
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
  const approvals = new StandingApprovalStore(deps.stateDirectory, now, nextId)

  const conversation = createConversationEffects({
    directoryFor: (sessionId) => sessions.directoryFor(sessionId),
    // A Session's Checkout, so durable content can be kept relative to it
    // rather than carrying an absolute path out of the person's machine.
    checkoutFor: (sessionId) =>
      sessions.get(sessionId).pipe(Effect.map((s) => checkoutDirectory(s.projectRoot, s.checkout))),
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
        checkout: input.checkout,
        title: suggestSessionTitle(input.message)
      })
      // The message is what created the Session, so a Session that exists
      // without it is a Session nobody asked for. If this cannot land the
      // record goes with it — including when the request is interrupted,
      // which `catchAll` alone would not cover.
      //
      // Failing to clean up is not allowed to replace the reason: the caller
      // needs to know why the message was refused, not that a tidy-up failed.
      yield* conversation
        .submit({
          sessionId: session.id,
          submissionId: `start-${session.id}`,
          text: input.message,
          source: 'composer'
        })
        .pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) ? Effect.void : Effect.ignore(sessions.delete(session.id))
          )
        )
      return session
    })

  /**
   * The Runs whose Conversation still has them open. After a quit or a crash
   * nothing closed them, so they read as working when nothing is working —
   * and the Session goes on saying so until somebody develops it again.
   */
  const listUnfinishedRuns = (): Effect.Effect<UnfinishedRun[], CoreError> =>
    Effect.gen(function* () {
      const all = yield* sessions.list()
      const open = yield* Effect.forEach(
        all,
        (session) =>
          conversation.state(session.id).pipe(
            Effect.map((state): UnfinishedRun | null =>
              state.activeRunId === null
                ? null
                : { sessionId: session.id, runId: state.activeRunId }
            ),
            // A Conversation that cannot be read has nothing to say about
            // whether a Run is open, and this is not the place to decide.
            Effect.catchAll(() => Effect.succeed<UnfinishedRun | null>(null))
          ),
        { concurrency: 8 }
      )
      return open.filter((entry): entry is UnfinishedRun => entry !== null)
    })

  /**
   * The mailbox over the Session store. Searching is over Session titles in
   * memory: there is no corpus of documents left to index.
   */
  const queryMailbox = (query: MailboxCoreQuery): Effect.Effect<MailboxSnapshot, CoreError> =>
    Effect.gen(function* () {
      const all = yield* sessions.list()
      const knownProjects = yield* projects.list()
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
      const described = yield* Effect.forEach(
        matched,
        (session) =>
          // The projection beside the Conversation, not the Conversation
          // itself: the inbox is read on every event, and reading every
          // journal back is what would make that cost grow with how much work
          // the person has done in this app (ticket 12f).
          conversation.state(session.id).pipe(
            Effect.map((state): MailboxSession => ({
              ...session,
              dormant:
                query.view === 'active' &&
                session.pinned &&
                Date.parse(session.updatedAt) <= dormantBefore,
              ...describeState(state)
            })),
            // A Conversation that cannot be read still leaves a Session in the
            // inbox: losing the row would hide the Session rather than the
            // problem.
            Effect.catchAll(() =>
              Effect.succeed<MailboxSession>({
                ...session,
                dormant: false,
                status: 'idle',
                waitingFor: null
              })
            )
          ),
        // Every Session in the inbox costs one Conversation read, so reading
        // them one after another is what makes a large inbox slow to open.
        { concurrency: 8 }
      )
      return {
        view: query.view,
        total: inView.length,
        matched: described.length,
        ...groupByProject(described, knownProjects, query.view),
        archivedTotal: all.filter((session) => session.archivedAt !== null).length
      }
    })

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

  /**
   * A permission granted for one Project, for good. The Project must be one
   * the app has: a rule stored against a root nobody added would be a rule
   * nobody can see, and therefore nobody can revoke.
   */
  const grantStandingApproval = (
    rawInput: GrantStandingApprovalInput
  ): Effect.Effect<StandingApproval, CoreError> =>
    Effect.gen(function* () {
      const parsed = grantStandingApprovalInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid approval')
        )
      }
      const input = parsed.data
      const known = yield* projects.list()
      if (!known.some((project) => project.root === input.projectRoot)) {
        return yield* Effect.fail(new CoreError('INVALID_INPUT', 'That Project has not been added'))
      }
      return yield* approvals.grant(input)
    })

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
    // A Project's permissions go with the Project: what it was allowed to do
    // is part of what removing it forgets.
    removeProject: (root) =>
      projects.remove(root).pipe(Effect.flatMap(() => approvals.forgetProject(root))),
    setProjectSkillsTrusted: (root, trusted) => projects.setSkillsTrusted(root, trusted),
    grantStandingApproval,
    listStandingApprovals: (projectRoot) => approvals.list(projectRoot),
    standingApprovalRules: (projectRoot, harness) => approvals.rules(projectRoot, harness),
    revokeStandingApproval: (input) => approvals.revoke(input),
    queryMailbox,
    setSessionPinned: (sessionId, pinned) => sessions.update(sessionId, { pinned }),
    setSessionArchived: (sessionId, archived) => sessions.update(sessionId, { archived }),
    // Titles are derived from the first message everywhere else; this is the
    // one place the person's own words replace the derivation.
    renameSession: (sessionId, title) => {
      const trimmed = title.trim()
      return trimmed.length === 0
        ? Effect.fail(new CoreError('INVALID_INPUT', 'A Session title cannot be empty'))
        : sessions.update(sessionId, { title: trimmed })
    },
    acceptRun,
    listRuns,
    recordRunEvent,
    getConversation: (sessionId) => conversation.get(sessionId),
    submitConversationMessage: (input) => conversation.submit(input),
    beginConversationRun: (input) => conversation.begin(input),
    applyHarnessEvent: (input) => conversation.apply(input),
    openHarness: (input) => conversation.open(input),
    answerHarnessApproval: (input) => conversation.answer(input),
    interruptHarness: (runId) => conversation.interrupt(runId),
    ingestHarnessOutput: (input) => conversation.ingest(input),
    recordCheckoutChanges: (input) => conversation.recordCheckoutChanges(input),
    listUnfinishedRuns,
    finalizeConversationRun: (input) => conversation.finalize(input)
  }
}

/**
 * The sidebar's shape: Pinned on top, then Projects with Sessions nested.
 * Pinned stays project-grouped too, so a pinned Session never loses the name
 * of the Project it works in. Status never decides placement — rows must not
 * re-shuffle between groups as Runs start and stop.
 *
 * Every known Project appears even when it has nothing to show, because an
 * empty Project is still somewhere to start a Session. A Session whose
 * Project was removed still needs a home, so one is invented from its root
 * and marked unavailable. The archived view lists only Projects that have
 * something archived: it is a record, not a launcher.
 */
function groupByProject(
  sessions: MailboxSession[],
  knownProjects: ProjectView[],
  view: MailboxCoreQuery['view']
): { pinned: MailboxProject[]; projects: MailboxProject[] } {
  const groups: MailboxProject[] = knownProjects.map((project) => ({
    root: project.root,
    name: project.name,
    available: project.available,
    sessions: []
  }))
  const byRoot = new Map(groups.map((group) => [group.root, group]))
  const pinnedByRoot = new Map<string, MailboxProject>()
  for (const session of sessions) {
    let home = byRoot.get(session.projectRoot)
    if (!home) {
      home = {
        root: session.projectRoot,
        name: basename(session.projectRoot),
        available: false,
        sessions: []
      }
      byRoot.set(home.root, home)
      groups.push(home)
    }
    if (view === 'active' && session.pinned) {
      let pinnedHome = pinnedByRoot.get(home.root)
      if (!pinnedHome) {
        pinnedHome = { ...home, sessions: [] }
        pinnedByRoot.set(home.root, pinnedHome)
      }
      pinnedHome.sessions.push(session)
    } else {
      home.sessions.push(session)
    }
  }
  return {
    pinned: groups.flatMap((group) => pinnedByRoot.get(group.root) ?? []),
    projects: view === 'archived' ? groups.filter((group) => group.sessions.length > 0) : groups
  }
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
    setProjectSkillsTrusted: (root, trusted) => run(core.setProjectSkillsTrusted(root, trusted)),
    grantStandingApproval: (input) => run(core.grantStandingApproval(input)),
    listStandingApprovals: (projectRoot) => run(core.listStandingApprovals(projectRoot)),
    standingApprovalRules: (projectRoot, harness) =>
      run(core.standingApprovalRules(projectRoot, harness)),
    revokeStandingApproval: (input) => run(core.revokeStandingApproval(input)),
    queryMailbox: (query) => run(core.queryMailbox(query)),
    setSessionPinned: (sessionId, pinned) => run(core.setSessionPinned(sessionId, pinned)),
    setSessionArchived: (sessionId, archived) => run(core.setSessionArchived(sessionId, archived)),
    renameSession: (sessionId, title) => run(core.renameSession(sessionId, title)),
    acceptRun: (input) => run(core.acceptRun(input)),
    listRuns: (sessionId) => run(core.listRuns(sessionId)),
    recordRunEvent: (input) => run(core.recordRunEvent(input)),
    getConversation: (sessionId) => run(core.getConversation(sessionId)),
    submitConversationMessage: (input) => run(core.submitConversationMessage(input)),
    beginConversationRun: (input) => run(core.beginConversationRun(input)),
    applyHarnessEvent: (input) => run(core.applyHarnessEvent(input)),
    openHarness: (input) => run(core.openHarness(input)),
    answerHarnessApproval: (input) => run(core.answerHarnessApproval(input)),
    interruptHarness: (runId) => run(core.interruptHarness(runId)),
    ingestHarnessOutput: (input) => run(core.ingestHarnessOutput(input)),
    recordCheckoutChanges: (input) => run(core.recordCheckoutChanges(input)),
    listUnfinishedRuns: () => run(core.listUnfinishedRuns()),
    finalizeConversationRun: (input) => run(core.finalizeConversationRun(input))
  }
}
