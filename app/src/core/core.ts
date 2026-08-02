import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { Cause, Context, Effect, Either, Exit, Layer, Option, Ref } from 'effect'
import { z } from 'zod'
import {
  CoreError,
  captureSessionInputSchema,
  sessionRelativePathSchema,
  sessionSummarySchema,
  type CaptureSessionInput,
  type DeleteSessionPreview,
  type MailboxCoreQuery,
  type MailboxSnapshot,
  type OpenedSession,
  type SessionSummary,
  type LibrarySnapshot
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
import { suggestSessionTitle } from '@shared/title'
import {
  emptyMailbox,
  indexExists,
  queryIndex,
  rebuildIndex,
  upsertSession,
  type IndexedSession
} from './search-index'
import {
  createConversationEffects,
  type ApplyHarnessEventInput,
  type BeginConversationRunInput,
  type IngestHarnessOutputInput
} from './conversation'

export interface CoreDeps {
  now?: () => Date
  randomId?: () => string
}

/**
 * The deep product-behavior module. It owns the Session lifecycle and
 * canonical Markdown persistence, and is the primary test seam. It runs inside
 * the Core utility process in production and directly inside tests.
 *
 * Internals are Effect (see ADR 0001); this interface stays promise-based so
 * Main and tests never see Effect types.
 */
export interface Core {
  openLibrary(path: string): Promise<LibrarySnapshot>
  captureSession(input: CaptureSessionInput): Promise<SessionSummary>
  openSession(relativePath: string): Promise<OpenedSession>
  listSessions(): Promise<SessionSummary[]>
  queryMailbox(query: MailboxCoreQuery): Promise<MailboxSnapshot>
  setSessionPinned(relativePath: string, pinned: boolean): Promise<SessionSummary>
  setSessionArchived(relativePath: string, archived: boolean): Promise<SessionSummary>
  previewDeleteSession(relativePath: string): Promise<DeleteSessionPreview>
  acceptRun(input: AcceptRunInput): Promise<RunSnapshot>
  listRuns(relativePath: string): Promise<RunSnapshot[]>
  recordRunEvent(input: RecordRunEventInput): Promise<RunSnapshot>
  getConversation(relativePath: string): Promise<ConversationSnapshot>
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
  openLibrary(path: string): Effect.Effect<LibrarySnapshot, CoreError>
  captureSession(input: CaptureSessionInput): Effect.Effect<SessionSummary, CoreError>
  openSession(relativePath: string): Effect.Effect<OpenedSession, CoreError>
  listSessions(): Effect.Effect<SessionSummary[], CoreError>
  queryMailbox(query: MailboxCoreQuery): Effect.Effect<MailboxSnapshot, CoreError>
  setSessionPinned(relativePath: string, pinned: boolean): Effect.Effect<SessionSummary, CoreError>
  setSessionArchived(
    relativePath: string,
    archived: boolean
  ): Effect.Effect<SessionSummary, CoreError>
  previewDeleteSession(relativePath: string): Effect.Effect<DeleteSessionPreview, CoreError>
  acceptRun(input: AcceptRunInput): Effect.Effect<RunSnapshot, CoreError>
  listRuns(relativePath: string): Effect.Effect<RunSnapshot[], CoreError>
  recordRunEvent(input: RecordRunEventInput): Effect.Effect<RunSnapshot, CoreError>
  getConversation(relativePath: string): Effect.Effect<ConversationSnapshot, CoreError>
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

const SESSION_FILE = 'session.md'
const CONVERSATION_FILE = 'conversation.md'
const PRIVATE_DIR = '.session'
/** The on-disk shape this version writes and is willing to read. */
const FORMAT_VERSION = 2
const MAX_SLUG_LENGTH = 40
const SCAN_CONCURRENCY = 8

class SessionClock extends Context.Tag('core/SessionClock')<SessionClock, { now(): Date }>() {}
class IdGenerator extends Context.Tag('core/IdGenerator')<IdGenerator, { nextId(): string }>() {}

type CoreServices = SessionClock | IdGenerator

export function createCoreEffects(deps: CoreDeps = {}): CoreEffects {
  const services: Layer.Layer<CoreServices> = Layer.mergeAll(
    Layer.succeed(SessionClock, { now: deps.now ?? (() => new Date()) }),
    Layer.succeed(IdGenerator, { nextId: deps.randomId ?? (() => `session-${randomUUID()}`) })
  )

  const libraryPath = Effect.runSync(Ref.make(Option.none<string>()))
  const conversation = createConversationEffects({
    library: Ref.get(libraryPath).pipe(Effect.map(Option.getOrNull)),
    clock: Effect.sync(deps.now ?? (() => new Date()))
  })
  // Writes hold this permit so two captures can never race on folder naming.
  const writeLock = Effect.runSync(Effect.makeSemaphore(1))

  const requireLibrary = (activity: string): Effect.Effect<string, CoreError> =>
    Ref.get(libraryPath).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new CoreError('NO_LIBRARY_OPEN', `Open a library before ${activity}`)),
          onSome: Effect.succeed
        })
      )
    )

  const provide = <A>(
    effect: Effect.Effect<A, CoreError, CoreServices>
  ): Effect.Effect<A, CoreError> => Effect.provide(effect, services)

  const openLibrary = (path: string): Effect.Effect<LibrarySnapshot, CoreError> =>
    Effect.gen(function* () {
      const stats = yield* Effect.tryPromise({
        try: () => stat(path),
        catch: () => new CoreError('LIBRARY_MISSING', `No folder exists at ${path}`)
      })
      if (!stats.isDirectory()) {
        return yield* Effect.fail(new CoreError('NOT_A_DIRECTORY', `${path} is not a folder`))
      }
      yield* Ref.set(libraryPath, Option.some(path))
      const sessions = yield* provide(scanSessions(path))
      // Refresh the disposable search projection; a failure here never blocks
      // the library, because queries rebuild it again on demand.
      yield* rebuildProjection(path, sessions).pipe(Effect.catchAll(() => Effect.void))
      return { path, sessions }
    })

  const captureSession = (
    rawInput: CaptureSessionInput
  ): Effect.Effect<SessionSummary, CoreError, CoreServices> =>
    Effect.gen(function* () {
      const library = yield* requireLibrary('capturing a Session')
      const parsed = captureSessionInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid Session input')
        )
      }
      const input = parsed.data
      const title = input.title.trim() || suggestSessionTitle(input.notes)

      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const clock = yield* SessionClock
          const ids = yield* IdGenerator
          const timestamp = clock.now().toISOString()
          const session: SessionSummary = {
            id: ids.nextId(),
            title,
            createdAt: timestamp,
            updatedAt: timestamp,
            relativePath: yield* reserveFolder(library, title),
            pinned: false,
            archivedAt: null
          }
          const conversationId = ids.nextId()
          yield* writePortableSession(
            join(library, session.relativePath),
            session,
            input.notes,
            conversationId
          )
          // Index exactly what was persisted so search answers cannot change
          // when the projection is later rebuilt from canonical content.
          yield* upsertProjection(
            library,
            session,
            markdownBody(renderRootDocument(session, input.notes))
          )
          return session
        })
      )
    })

  const listSessions: Effect.Effect<SessionSummary[], CoreError> = requireLibrary(
    'listing Sessions'
  ).pipe(Effect.flatMap((library) => provide(scanSessions(library))))

  const openSession = (relativePath: string): Effect.Effect<OpenedSession, CoreError> =>
    requireLibrary('opening a Session').pipe(
      Effect.flatMap((library) => provide(reopenSession(library, relativePath)))
    )

  const queryMailbox = (query: MailboxCoreQuery): Effect.Effect<MailboxSnapshot, CoreError> =>
    requireLibrary('searching Sessions').pipe(
      Effect.flatMap((library) =>
        provide(
          Effect.gen(function* () {
            const clock = yield* SessionClock
            if (indexExists(library)) {
              const attempt = yield* Effect.try({
                try: () => queryIndex(library, query, clock.now()),
                catch: () => new CoreError('IO_ERROR', 'The search index is unreadable')
              }).pipe(Effect.either)
              if (Either.isRight(attempt)) return { ...attempt.right, index: 'ready' as const }
            }
            // Missing or corrupt projection: rebuild it from canonical
            // content and answer from the fresh index.
            const sessions = yield* scanSessions(library)
            yield* rebuildProjection(library, sessions)
            if (sessions.length === 0)
              return { ...emptyMailbox(query.view), index: 'rebuilt' as const }
            const rebuilt = yield* Effect.try({
              try: () => queryIndex(library, query, clock.now()),
              catch: () => new CoreError('IO_ERROR', 'Could not search the rebuilt index')
            })
            return { ...rebuilt, index: 'rebuilt' as const }
          })
        )
      )
    )

  const updateRootFlags = (
    relativePath: string,
    patch: { pinned?: boolean; archived?: boolean }
  ): Effect.Effect<SessionSummary, CoreError> =>
    requireLibrary('updating a Session').pipe(
      Effect.flatMap((library) =>
        provide(
          writeLock.withPermits(1)(
            Effect.gen(function* () {
              const parsedPath = sessionRelativePathSchema.safeParse(relativePath)
              if (!parsedPath.success) {
                return yield* Effect.fail(
                  new CoreError('INVALID_INPUT', 'The Session reference is not portable')
                )
              }
              const folder = parsedPath.data
              const summary = yield* readSessionSummary(library, folder)
              if (!summary) {
                return yield* Effect.fail(
                  new CoreError('SESSION_NOT_FOUND', 'The Session was not found')
                )
              }
              const sessionDir = join(library, folder)
              const root = yield* Effect.tryPromise({
                try: () => findRootDocument(sessionDir),
                catch: () => new CoreError('IO_ERROR', 'The root document is unreadable')
              })
              if (!root) {
                return yield* Effect.fail(
                  new CoreError('IO_ERROR', 'The root document is unreadable')
                )
              }
              // A root document written by a newer app version is not ours to
              // rewrite: round-tripping it here would silently drop frontmatter
              // this version does not understand.
              if (Number(root.parsed.frontmatter['format'] ?? '0') > FORMAT_VERSION) {
                return yield* Effect.fail(
                  new CoreError(
                    'INVALID_INPUT',
                    'This Session was written by a newer version of the app'
                  )
                )
              }
              const clock = yield* SessionClock
              const nextSummary: SessionSummary = {
                ...summary,
                ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
                ...(patch.archived !== undefined
                  ? { archivedAt: patch.archived ? clock.now().toISOString() : null }
                  : {})
              }
              let nextRaw = root.raw
              if (patch.pinned !== undefined) {
                nextRaw = setFrontmatterField(nextRaw, 'pinned', String(nextSummary.pinned))
              }
              if (patch.archived !== undefined) {
                nextRaw = setFrontmatterField(nextRaw, 'archived', nextSummary.archivedAt)
              }
              const recovery = yield* Effect.promise(() => readRecovery(sessionDir))
              const identity: RecoveryIdentity = recovery
                ? {
                    format: recovery.format,
                    sessionId: recovery.sessionId,
                    summary: nextSummary,
                    documents: recovery.documents
                  }
                : {
                    format: FORMAT_VERSION,
                    sessionId: summary.id,
                    summary: nextSummary,
                    documents: {
                      root: { id: summary.id, path: root.path },
                      conversation: {
                        id: `${summary.id}:conversation`,
                        path: root.parsed.frontmatter['conversation'] ?? CONVERSATION_FILE
                      }
                    }
                  }
              yield* writeManagedDocuments(sessionDir, identity, [
                { path: root.path, content: nextRaw }
              ])
              yield* upsertProjection(library, nextSummary, markdownBody(nextRaw))
              return nextSummary
            })
          )
        )
      )
    )

  const previewDeleteSession = (
    relativePath: string
  ): Effect.Effect<DeleteSessionPreview, CoreError> =>
    requireLibrary('deleting a Session').pipe(
      Effect.flatMap((library) =>
        provide(
          Effect.gen(function* () {
            const parsedPath = sessionRelativePathSchema.safeParse(relativePath)
            if (!parsedPath.success) {
              return yield* Effect.fail(
                new CoreError('INVALID_INPUT', 'The Session reference is not portable')
              )
            }
            const folder = parsedPath.data
            const summary = yield* readSessionSummary(library, folder)
            if (!summary) {
              return yield* Effect.fail(
                new CoreError('SESSION_NOT_FOUND', 'The Session was not found')
              )
            }
            const sessionDir = join(library, folder)
            const recovery = yield* Effect.promise(() => readRecovery(sessionDir))
            const ownedFiles = new Set([
              recovery?.documents.root.path ?? SESSION_FILE,
              recovery?.documents.conversation.path ?? CONVERSATION_FILE
            ])
            const partition = yield* Effect.tryPromise({
              try: () => partitionSessionFolder(sessionDir, ownedFiles),
              catch: () => new CoreError('IO_ERROR', 'Could not inspect the Session folder')
            })
            return {
              relativePath: folder,
              title: summary.title,
              targets: partition.allOwned
                ? [folder]
                : partition.targets.map((target) => `${folder}/${target}`),
              keeps: partition.allOwned ? [] : partition.keeps.map((keep) => `${folder}/${keep}`)
            }
          })
        )
      )
    )

  const acceptRun = (rawInput: AcceptRunInput): Effect.Effect<RunSnapshot, CoreError> =>
    requireLibrary('starting a Run').pipe(
      Effect.flatMap((library) =>
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
              const sessionDir = join(library, input.relativePath)
              const session = yield* readSessionSummary(library, input.relativePath)
              if (!session) {
                return yield* Effect.fail(
                  new CoreError('SESSION_NOT_FOUND', 'The Session was not found')
                )
              }
              if (input.configuration.workingDirectory !== sessionDir) {
                return yield* Effect.fail(
                  new CoreError('INVALID_INPUT', 'Run working directory does not match the Session')
                )
              }
              const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
              const submissionKey = createHash('sha256').update(input.submissionId).digest('hex')
              const submissionsDir = join(sessionDir, PRIVATE_DIR, 'submissions')
              const runsDir = join(sessionDir, PRIVATE_DIR, 'runs')
              const submissionPath = join(submissionsDir, `${submissionKey}.json`)
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
                relativePath: input.relativePath,
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
              yield* Effect.tryPromise({
                try: async () => {
                  await Promise.all([
                    mkdir(submissionsDir, { recursive: true, mode: 0o700 }),
                    mkdir(runsDir, { recursive: true, mode: 0o700 })
                  ])
                  await writeJsonAtomic(join(runsDir, `${run.id}.json`), run)
                  await writeJsonAtomic(submissionPath, { fingerprint, run })
                },
                catch: () => new CoreError('IO_ERROR', 'Could not accept the Run durably')
              })
              return run
            })
          )
        )
      )
    )

  const listRuns = (relativePath: string): Effect.Effect<RunSnapshot[], CoreError> =>
    requireLibrary('listing Runs').pipe(
      Effect.flatMap((library) =>
        Effect.tryPromise({
          try: async () => {
            const parsedPath = sessionRelativePathSchema.parse(relativePath)
            const runsDir = join(library, parsedPath, PRIVATE_DIR, 'runs')
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
    requireLibrary('updating a Run').pipe(
      Effect.flatMap((library) =>
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
              const path = join(
                library,
                event.relativePath,
                PRIVATE_DIR,
                'runs',
                `${event.runId}.json`
              )
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
              yield* Effect.tryPromise({
                try: () => writeJsonAtomic(path, next),
                catch: () => new CoreError('IO_ERROR', 'Could not update the Run')
              })
              return next
            })
          )
        )
      )
    )

  return {
    openLibrary,
    captureSession: (input) => provide(captureSession(input)),
    openSession,
    listSessions: () => listSessions,
    queryMailbox,
    setSessionPinned: (relativePath, pinned) => updateRootFlags(relativePath, { pinned }),
    setSessionArchived: (relativePath, archived) => updateRootFlags(relativePath, { archived }),
    previewDeleteSession,
    acceptRun,
    listRuns,
    recordRunEvent,
    getConversation: (relativePath) => conversation.get(relativePath),
    submitConversationMessage: (input) => conversation.submit(input),
    beginConversationRun: (input) => conversation.begin(input),
    applyHarnessEvent: (input) => conversation.apply(input),
    ingestHarnessOutput: (input) => conversation.ingest(input),
    finalizeConversationRun: (input) => conversation.finalize(input)
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
    openLibrary: (path) => run(core.openLibrary(path)),
    captureSession: (input) => run(core.captureSession(input)),
    openSession: (relativePath) => run(core.openSession(relativePath)),
    listSessions: () => run(core.listSessions()),
    queryMailbox: (query) => run(core.queryMailbox(query)),
    setSessionPinned: (relativePath, pinned) => run(core.setSessionPinned(relativePath, pinned)),
    setSessionArchived: (relativePath, archived) =>
      run(core.setSessionArchived(relativePath, archived)),
    previewDeleteSession: (relativePath) => run(core.previewDeleteSession(relativePath)),
    acceptRun: (input) => run(core.acceptRun(input)),
    listRuns: (relativePath) => run(core.listRuns(relativePath)),
    recordRunEvent: (input) => run(core.recordRunEvent(input)),
    getConversation: (relativePath) => run(core.getConversation(relativePath)),
    submitConversationMessage: (input) => run(core.submitConversationMessage(input)),
    beginConversationRun: (input) => run(core.beginConversationRun(input)),
    applyHarnessEvent: (input) => run(core.applyHarnessEvent(input)),
    ingestHarnessOutput: (input) => run(core.ingestHarnessOutput(input)),
    finalizeConversationRun: (input) => run(core.finalizeConversationRun(input))
  }
}

function reserveFolder(library: string, title: string): Effect.Effect<string, CoreError> {
  return Effect.gen(function* () {
    const base = slugify(title)
    for (let attempt = 1; ; attempt++) {
      const candidate = attempt === 1 ? base : `${base}-${attempt}`
      const created = yield* Effect.tryPromise({
        try: () => mkdir(join(library, candidate)).then(() => true),
        catch: (error) => error as NodeJS.ErrnoException
      }).pipe(
        Effect.catchAll((error) =>
          error.code === 'EEXIST'
            ? Effect.succeed(false)
            : Effect.fail(
                new CoreError('IO_ERROR', `Could not create Session folder in ${library}`)
              )
        )
      )
      if (created) return candidate
    }
  })
}

/** Renders the canonical root document, shared by persistence and indexing. */
function renderRootDocument(session: SessionSummary, notes: string): string {
  const body = notes.replace(/\r\n/g, '\n').trim()
  return [
    '---',
    `format: ${FORMAT_VERSION}`,
    `id: ${session.id}`,
    `created: ${session.createdAt}`,
    `updated: ${session.updatedAt}`,
    `pinned: ${session.pinned}`,
    ...(session.archivedAt ? [`archived: ${session.archivedAt}`] : []),
    `conversation: ${CONVERSATION_FILE}`,
    '---',
    '',
    `# ${session.title}`,
    ...(body ? ['', body] : []),
    ''
  ].join('\n')
}

function writePortableSession(
  sessionDir: string,
  session: SessionSummary,
  notes: string,
  conversationId: string
): Effect.Effect<void, CoreError> {
  const root = renderRootDocument(session, notes)
  const conversation = [
    '---',
    `format: ${FORMAT_VERSION}`,
    `document_id: ${conversationId}`,
    `session_id: ${session.id}`,
    'document_kind: conversation',
    '---',
    '',
    '# Conversation',
    '',
    'This permanent Conversation belongs to the Session.',
    ''
  ].join('\n')
  const identity = {
    format: FORMAT_VERSION,
    sessionId: session.id,
    summary: session,
    documents: {
      root: { id: session.id, path: SESSION_FILE },
      conversation: { id: conversationId, path: CONVERSATION_FILE }
    }
  }

  return writeManagedDocuments(sessionDir, identity, [
    { path: SESSION_FILE, content: root },
    { path: CONVERSATION_FILE, content: conversation }
  ])
}

type RecoveryIdentity = Pick<RecoveryState, 'format' | 'sessionId' | 'summary' | 'documents'>

/**
 * Writes the managed documents and the private identity record. Writes are
 * direct and applied in the given order, with the identity record last so a
 * torn write leaves it stale rather than ahead of the documents it names.
 *
 * Callers that mutate an existing Session hold the write permit; the
 * first-write path does not, because no other writer can yet name the Session.
 */
function writeManagedDocuments(
  sessionDir: string,
  identity: RecoveryIdentity,
  documents: { path: string; content: string }[]
): Effect.Effect<void, CoreError> {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(join(sessionDir, PRIVATE_DIR), { recursive: true })
      for (const document of documents) {
        await mkdir(join(sessionDir, document.path, '..'), { recursive: true })
        await writeFile(join(sessionDir, document.path), document.content, 'utf8')
      }
      await writeJsonAtomic(join(sessionDir, PRIVATE_DIR, 'recovery.json'), identity)
    },
    catch: (error) =>
      error instanceof CoreError
        ? error
        : new CoreError(
            'IO_ERROR',
            error instanceof Error ? error.message : `Could not save the Session to ${sessionDir}`
          )
  })
}

function scanSessions(library: string): Effect.Effect<SessionSummary[], CoreError> {
  return Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(library, { withFileTypes: true }),
      catch: () => new CoreError('IO_ERROR', `Could not read the library at ${library}`)
    })
    // Dot-folders (like the disposable .index projection) are never Sessions.
    const folders = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    const summaries = yield* Effect.forEach(
      folders,
      (entry) => readSessionSummary(library, entry.name),
      { concurrency: SCAN_CONCURRENCY }
    )
    return summaries
      .filter((summary): summary is SessionSummary => summary !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title))
  })
}

interface RecoveryState {
  format: number
  sessionId: string
  summary?: SessionSummary
  documents: {
    root: { id: string; path: string }
    conversation: { id: string; path: string }
  }
}

function reopenSession(
  library: string,
  relativePath: string
): Effect.Effect<OpenedSession, CoreError> {
  return Effect.gen(function* () {
    const parsedPath = sessionRelativePathSchema.safeParse(relativePath)
    if (!parsedPath.success) {
      return yield* Effect.fail(
        new CoreError('INVALID_INPUT', 'The Session reference is not portable')
      )
    }
    const sessionDir = join(library, parsedPath.data)
    const summary = yield* readSessionSummary(library, parsedPath.data)
    if (!summary)
      return yield* Effect.fail(new CoreError('SESSION_NOT_FOUND', 'The Session was not found'))

    const rootDocument = yield* Effect.tryPromise({
      try: () => findRootDocument(sessionDir),
      catch: () => new CoreError('IO_ERROR', 'The root document is unreadable')
    })
    if (!rootDocument) {
      return yield* Effect.fail(new CoreError('IO_ERROR', 'The root document is unreadable'))
    }

    const recoveryPath = join(sessionDir, PRIVATE_DIR, 'recovery.json')
    const recovery = yield* Effect.tryPromise({
      try: async () => JSON.parse(await readFile(recoveryPath, 'utf8')) as RecoveryState,
      catch: () => new CoreError('IO_ERROR', 'The private recovery metadata is unreadable')
    })
    const identities = yield* Effect.tryPromise({
      try: () => collectManagedIdentities(sessionDir),
      catch: () => new CoreError('IO_ERROR', 'Managed content could not be read')
    })
    const rootPath = identities.get(recovery.documents.root.id)
    const conversationPath = identities.get(recovery.documents.conversation.id)
    if (!rootPath || !conversationPath) {
      return yield* Effect.fail(
        new CoreError('IO_ERROR', 'One or more canonical documents could not be recovered')
      )
    }
    const documents = {
      root: { ...recovery.documents.root, path: rootPath },
      conversation: { ...recovery.documents.conversation, path: conversationPath }
    }
    const nextRecovery: RecoveryState = { ...recovery, summary, documents }
    const repaired = yield* repairPortableLinks(sessionDir, nextRecovery)
    if (!repaired) {
      yield* Effect.tryPromise({
        try: () => writeJsonAtomic(recoveryPath, nextRecovery),
        catch: () => new CoreError('IO_ERROR', 'Could not refresh managed-content identities')
      })
    }

    return {
      session: summary,
      documents: {
        root: { id: documents.root.id, kind: 'root' as const, path: rootPath },
        conversation: {
          id: documents.conversation.id,
          kind: 'conversation' as const,
          path: conversationPath
        }
      }
    }
  })
}

async function collectManagedIdentities(sessionDir: string): Promise<Map<string, string>> {
  const identities = new Map<string, string>()
  for (const path of await listMarkdownPaths(sessionDir)) {
    const parsed = parseSessionMarkdown(await readFile(join(sessionDir, path), 'utf8'))
    if (!parsed) continue
    const id = parsed.frontmatter['document_id'] ?? parsed.frontmatter['id']
    if (id) identities.set(id, path)
  }
  return identities
}

async function findRootDocument(sessionDir: string): Promise<{
  path: string
  raw: string
  parsed: NonNullable<ReturnType<typeof parseSessionMarkdown>>
} | null> {
  const recoveryRaw = await readFile(join(sessionDir, PRIVATE_DIR, 'recovery.json'), 'utf8').catch(
    () => null
  )
  let rootId: string | null = null
  if (recoveryRaw) {
    try {
      rootId = (JSON.parse(recoveryRaw) as RecoveryState).documents.root.id
    } catch {
      rootId = null
    }
  }
  for (const path of await listMarkdownPaths(sessionDir)) {
    const raw = await readFile(join(sessionDir, path), 'utf8')
    const parsed = parseSessionMarkdown(raw)
    if (!parsed) continue
    // A folder written in a previous on-disk format is discarded, not read:
    // it is left exactly as it is on disk and never becomes a Session.
    if (Number(parsed.frontmatter['format'] ?? '0') < FORMAT_VERSION) continue
    const id = parsed.frontmatter['id']
    if ((rootId && id === rootId) || (!rootId && path === SESSION_FILE && id)) {
      return { path, raw, parsed }
    }
  }
  return null
}

function repairPortableLinks(
  sessionDir: string,
  recovery: RecoveryState
): Effect.Effect<boolean, CoreError> {
  return Effect.gen(function* () {
    const rootPath = recovery.documents.root.path
    const conversationPath = recovery.documents.conversation.path
    const rootRaw = yield* Effect.tryPromise({
      try: () => readFile(join(sessionDir, rootPath), 'utf8'),
      catch: () => new CoreError('IO_ERROR', 'Managed links could not be inspected')
    })
    const rootToConversation = posix.relative(posix.dirname(rootPath), conversationPath)
    const nextRoot = replaceFrontmatterField(rootRaw, 'conversation', rootToConversation)
    if (nextRoot === rootRaw) return false

    yield* writeManagedDocuments(sessionDir, recovery, [{ path: rootPath, content: nextRoot }])
    return true
  })
}

function replaceFrontmatterField(raw: string, key: string, value: string): string {
  const pattern = new RegExp(`^${key}:.*$`, 'm')
  return pattern.test(raw) ? raw.replace(pattern, `${key}: ${value}`) : raw
}

async function listMarkdownPaths(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === PRIVATE_DIR) continue
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) result.push(...(await listMarkdownPaths(root, relative)))
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(relative)
  }
  return result
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const staged = `${path}.staged`
  await writeFile(staged, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(staged, path)
}

function readSessionSummary(
  library: string,
  folder: string
): Effect.Effect<SessionSummary | null, CoreError> {
  return Effect.gen(function* () {
    const sessionDir = join(library, folder)
    const root = yield* Effect.tryPromise(() => findRootDocument(sessionDir)).pipe(
      Effect.orElseSucceed(() => null)
    )
    if (!root) return null
    const parsed = root.parsed
    const archivedRaw = parsed.frontmatter['archived']
    const candidate = {
      id: parsed.frontmatter['id'],
      title: parsed.title,
      createdAt: parsed.frontmatter['created'],
      updatedAt: parsed.frontmatter['updated'],
      relativePath: folder,
      // pinned and archived accept external edits; junk reads as the default.
      pinned: parsed.frontmatter['pinned'] === 'true',
      archivedAt:
        archivedRaw && z.string().datetime().safeParse(archivedRaw).success ? archivedRaw : null
    }
    const validated = sessionSummarySchema.safeParse(candidate)
    if (!validated.success) return null
    yield* Effect.tryPromise({
      try: () =>
        writeJsonAtomic(join(sessionDir, PRIVATE_DIR, 'projection.json'), {
          format: FORMAT_VERSION,
          source: 'canonical-markdown',
          session: validated.data
        }),
      catch: () => new CoreError('IO_ERROR', 'Could not rebuild the Session projection')
    })
    return validated.data
  })
}

/** The Markdown after the frontmatter block, used for full-text search. */
function markdownBody(raw: string): string {
  if (!raw.startsWith('---\n')) return raw
  const end = raw.indexOf('\n---\n', 4)
  return end === -1 ? raw : raw.slice(end + 5)
}

/** Sets (or removes, with null) one field inside the frontmatter block. */
function setFrontmatterField(raw: string, key: string, value: string | null): string {
  if (!raw.startsWith('---\n')) return raw
  const end = raw.indexOf('\n---\n', 4)
  if (end === -1) return raw
  const lines = raw
    .slice(4, end)
    .split('\n')
    .filter((line) => !line.startsWith(`${key}:`))
  if (value !== null) lines.push(`${key}: ${value}`)
  return `---\n${lines.join('\n')}\n---\n${raw.slice(end + 5)}`
}

async function readRecovery(sessionDir: string): Promise<RecoveryState | null> {
  const raw = await readFile(join(sessionDir, PRIVATE_DIR, 'recovery.json'), 'utf8').catch(
    () => null
  )
  if (raw === null) return null
  try {
    return JSON.parse(raw) as RecoveryState
  } catch {
    return null
  }
}

function indexedSessionsFor(
  library: string,
  sessions: SessionSummary[]
): Effect.Effect<IndexedSession[]> {
  return Effect.forEach(
    sessions,
    (summary) =>
      Effect.promise(async (): Promise<IndexedSession> => {
        const root = await findRootDocument(join(library, summary.relativePath)).catch(() => null)
        return { summary, body: root ? markdownBody(root.raw) : '' }
      }),
    { concurrency: SCAN_CONCURRENCY }
  )
}

function rebuildProjection(
  library: string,
  sessions: SessionSummary[]
): Effect.Effect<void, CoreError> {
  return indexedSessionsFor(library, sessions).pipe(
    Effect.flatMap((indexed) =>
      Effect.try({
        try: () => rebuildIndex(library, indexed),
        catch: () => new CoreError('IO_ERROR', 'Could not rebuild the search index')
      })
    )
  )
}

/** Best-effort projection refresh: a failed upsert self-heals on query. */
function upsertProjection(
  library: string,
  session: SessionSummary,
  body: string
): Effect.Effect<void> {
  return Effect.sync(() => {
    try {
      upsertSession(library, { summary: session, body })
    } catch {
      // The next query rebuilds the disposable index from canonical content.
    }
  })
}

interface FolderPartition {
  allOwned: boolean
  targets: string[]
  keeps: string[]
}

/**
 * Splits a Session folder into app-owned delete targets and foreign content to
 * keep. A directory whose entire subtree is app-owned collapses into a single
 * target; `.session` private state is always app-owned.
 */
async function partitionSessionFolder(
  sessionDir: string,
  ownedFiles: Set<string>
): Promise<FolderPartition> {
  async function walk(prefix: string): Promise<FolderPartition> {
    const entries = await readdir(join(sessionDir, prefix), { withFileTypes: true })
    if (entries.length === 0) return { allOwned: false, targets: [], keeps: [prefix] }
    const results: FolderPartition[] = []
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        results.push(
          rel === PRIVATE_DIR ? { allOwned: true, targets: [rel], keeps: [] } : await walk(rel)
        )
      } else if (ownedFiles.has(rel)) {
        results.push({ allOwned: true, targets: [rel], keeps: [] })
      } else {
        results.push({ allOwned: false, targets: [], keeps: [rel] })
      }
    }
    if (results.every((result) => result.allOwned)) {
      return {
        allOwned: true,
        targets: prefix ? [prefix] : results.flatMap((result) => result.targets),
        keeps: []
      }
    }
    return {
      allOwned: false,
      targets: results.flatMap((result) => result.targets),
      keeps: results.flatMap((result) => result.keeps)
    }
  }
  return walk('')
}

function parseSessionMarkdown(
  raw: string
): { frontmatter: Record<string, string>; title: string | null } | null {
  if (!raw.startsWith('---\n')) return null
  const end = raw.indexOf('\n---\n', 4)
  if (end === -1) return null

  const frontmatter: Record<string, string> = {}
  for (const line of raw.slice(4, end).split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }

  const heading = raw
    .slice(end + 5)
    .split('\n')
    .find((line) => line.startsWith('# '))
  return { frontmatter, title: heading ? heading.slice(2).trim() : null }
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
  return slug || 'session'
}
