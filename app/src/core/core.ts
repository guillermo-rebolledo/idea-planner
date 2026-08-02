import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'
import { Cause, Context, Effect, Either, Exit, Layer, Option, Ref } from 'effect'
import { z } from 'zod'
import {
  CoreError,
  captureIdeaInputSchema,
  ideaRelativePathSchema,
  ideaSummarySchema,
  type CaptureIdeaInput,
  type DeleteIdeaPreview,
  type MailboxCoreQuery,
  type MailboxSnapshot,
  type OpenedIdea,
  type IdeaSummary,
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
import { suggestIdeaTitle } from '@shared/title'
import {
  emptyMailbox,
  indexExists,
  queryIndex,
  rebuildIndex,
  upsertIdea,
  type IndexedIdea
} from './search-index'
import {
  createConversationEffects,
  type ApplyHarnessEventInput,
  type BeginConversationRunInput,
  type IngestProviderOutputInput
} from './conversation'

export interface CoreDeps {
  now?: () => Date
  randomId?: () => string
}

/**
 * The deep product-behavior module. It owns the Idea lifecycle and canonical
 * Markdown persistence, and is the primary test seam. It runs inside the Core
 * utility process in production and directly inside tests.
 *
 * Internals are Effect (see ADR 0001); this interface stays promise-based so
 * Main and tests never see Effect types.
 */
export interface Core {
  openLibrary(path: string): Promise<LibrarySnapshot>
  captureIdea(input: CaptureIdeaInput): Promise<IdeaSummary>
  openIdea(relativePath: string): Promise<OpenedIdea>
  listIdeas(): Promise<IdeaSummary[]>
  queryMailbox(query: MailboxCoreQuery): Promise<MailboxSnapshot>
  setIdeaPinned(relativePath: string, pinned: boolean): Promise<IdeaSummary>
  setIdeaArchived(relativePath: string, archived: boolean): Promise<IdeaSummary>
  previewDeleteIdea(relativePath: string): Promise<DeleteIdeaPreview>
  acceptRun(input: AcceptRunInput): Promise<RunSnapshot>
  listRuns(relativePath: string): Promise<RunSnapshot[]>
  recordRunEvent(input: RecordRunEventInput): Promise<RunSnapshot>
  getConversation(relativePath: string): Promise<ConversationSnapshot>
  submitConversationMessage(input: SubmitConversationMessageInput): Promise<ConversationSnapshot>
  beginConversationRun(input: BeginConversationRunInput): Promise<ConversationSnapshot>
  applyHarnessEvent(input: ApplyHarnessEventInput): Promise<void>
  ingestProviderOutput(input: IngestProviderOutputInput): Promise<HarnessEvent[]>
  finalizeConversationRun(input: FinalizeConversationRunInput): Promise<ConversationSnapshot>
}

/**
 * The same behavior as Effect values, for callers inside the Core process
 * (the utility-process dispatcher). Dependencies are already provided.
 */
export interface CoreEffects {
  openLibrary(path: string): Effect.Effect<LibrarySnapshot, CoreError>
  captureIdea(input: CaptureIdeaInput): Effect.Effect<IdeaSummary, CoreError>
  openIdea(relativePath: string): Effect.Effect<OpenedIdea, CoreError>
  listIdeas(): Effect.Effect<IdeaSummary[], CoreError>
  queryMailbox(query: MailboxCoreQuery): Effect.Effect<MailboxSnapshot, CoreError>
  setIdeaPinned(relativePath: string, pinned: boolean): Effect.Effect<IdeaSummary, CoreError>
  setIdeaArchived(relativePath: string, archived: boolean): Effect.Effect<IdeaSummary, CoreError>
  previewDeleteIdea(relativePath: string): Effect.Effect<DeleteIdeaPreview, CoreError>
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
  ingestProviderOutput(input: IngestProviderOutputInput): Effect.Effect<HarnessEvent[], CoreError>
  finalizeConversationRun(
    input: FinalizeConversationRunInput
  ): Effect.Effect<ConversationSnapshot, CoreError>
}

const IDEA_FILE = 'idea.md'
const MAX_SLUG_LENGTH = 40
const SCAN_CONCURRENCY = 8

class IdeaClock extends Context.Tag('core/IdeaClock')<IdeaClock, { now(): Date }>() {}
class IdGenerator extends Context.Tag('core/IdGenerator')<IdGenerator, { nextId(): string }>() {}

type CoreServices = IdeaClock | IdGenerator

export function createCoreEffects(deps: CoreDeps = {}): CoreEffects {
  const services: Layer.Layer<CoreServices> = Layer.mergeAll(
    Layer.succeed(IdeaClock, { now: deps.now ?? (() => new Date()) }),
    Layer.succeed(IdGenerator, { nextId: deps.randomId ?? (() => `idea-${randomUUID()}`) })
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
            Effect.fail(
              new CoreError('NO_LIBRARY_OPEN', `Open an Idea Library before ${activity}`)
            ),
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
      const ideas = yield* provide(scanIdeas(path))
      // Refresh the disposable search projection; a failure here never blocks
      // the library, because queries rebuild it again on demand.
      yield* rebuildProjection(path, ideas).pipe(Effect.catchAll(() => Effect.void))
      return { path, ideas }
    })

  const captureIdea = (
    rawInput: CaptureIdeaInput
  ): Effect.Effect<IdeaSummary, CoreError, CoreServices> =>
    Effect.gen(function* () {
      const library = yield* requireLibrary('capturing an Idea')
      const parsed = captureIdeaInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid Idea input')
        )
      }
      const input = parsed.data
      const title = input.title.trim() || suggestIdeaTitle(input.notes)

      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const clock = yield* IdeaClock
          const ids = yield* IdGenerator
          const timestamp = clock.now().toISOString()
          const idea: IdeaSummary = {
            id: ids.nextId(),
            kind: input.kind,
            title,
            status: 'saved',
            createdAt: timestamp,
            updatedAt: timestamp,
            relativePath: yield* reserveFolder(library, title),
            pinned: false,
            archivedAt: null
          }
          const planningIndexId = ids.nextId()
          const conversationId = ids.nextId()
          yield* writePortableIdea(
            join(library, idea.relativePath),
            idea,
            input.notes,
            planningIndexId,
            conversationId
          )
          // Index exactly what was persisted so search answers cannot change
          // when the projection is later rebuilt from canonical content.
          yield* upsertProjection(
            library,
            idea,
            markdownBody(renderRootDocument(idea, input.notes))
          )
          return idea
        })
      )
    })

  const listIdeas: Effect.Effect<IdeaSummary[], CoreError> = requireLibrary('listing Ideas').pipe(
    Effect.flatMap((library) => provide(scanIdeas(library)))
  )

  const openIdea = (relativePath: string): Effect.Effect<OpenedIdea, CoreError> =>
    requireLibrary('opening an Idea').pipe(
      Effect.flatMap((library) => provide(reopenIdea(library, relativePath)))
    )

  const queryMailbox = (query: MailboxCoreQuery): Effect.Effect<MailboxSnapshot, CoreError> =>
    requireLibrary('searching Ideas').pipe(
      Effect.flatMap((library) =>
        provide(
          Effect.gen(function* () {
            const clock = yield* IdeaClock
            if (indexExists(library)) {
              const attempt = yield* Effect.try({
                try: () => queryIndex(library, query, clock.now()),
                catch: () => new CoreError('IO_ERROR', 'The search index is unreadable')
              }).pipe(Effect.either)
              if (Either.isRight(attempt)) return { ...attempt.right, index: 'ready' as const }
            }
            // Missing or corrupt projection: rebuild it from canonical
            // content and answer from the fresh index.
            const ideas = yield* scanIdeas(library)
            yield* rebuildProjection(library, ideas)
            if (ideas.length === 0)
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
  ): Effect.Effect<IdeaSummary, CoreError> =>
    requireLibrary('updating an Idea').pipe(
      Effect.flatMap((library) =>
        provide(
          writeLock.withPermits(1)(
            Effect.gen(function* () {
              const parsedPath = ideaRelativePathSchema.safeParse(relativePath)
              if (!parsedPath.success) {
                return yield* Effect.fail(
                  new CoreError('INVALID_INPUT', 'The Idea reference is not portable')
                )
              }
              const folder = parsedPath.data
              const summary = yield* readIdeaSummary(library, folder)
              if (!summary) {
                return yield* Effect.fail(new CoreError('IDEA_NOT_FOUND', 'The Idea was not found'))
              }
              const ideaDir = join(library, folder)
              const root = yield* Effect.tryPromise({
                try: () => findRootDocument(ideaDir),
                catch: () => new CoreError('IO_ERROR', 'The root Idea is unreadable')
              })
              if (!root) {
                return yield* Effect.fail(new CoreError('IO_ERROR', 'The root Idea is unreadable'))
              }
              const clock = yield* IdeaClock
              const nextSummary: IdeaSummary = {
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
              const recovery = yield* Effect.promise(() => readRecovery(ideaDir))
              const identity: RecoveryIdentity = recovery
                ? {
                    format: recovery.format,
                    ideaId: recovery.ideaId,
                    summary: nextSummary,
                    documents: recovery.documents
                  }
                : {
                    format: 1,
                    ideaId: summary.id,
                    summary: nextSummary,
                    documents: {
                      root: { id: summary.id, path: root.path },
                      planningIndex: {
                        id: `${summary.id}:planning-index`,
                        path: root.parsed.frontmatter['planning_index'] ?? 'planning/index.md'
                      },
                      conversation: {
                        id: `${summary.id}:conversation`,
                        path: root.parsed.frontmatter['conversation'] ?? 'planning/conversation.md'
                      }
                    }
                  }
              yield* writeManagedDocuments(ideaDir, identity, [
                { path: root.path, content: nextRaw }
              ])
              yield* upsertProjection(library, nextSummary, markdownBody(nextRaw))
              return nextSummary
            })
          )
        )
      )
    )

  const previewDeleteIdea = (relativePath: string): Effect.Effect<DeleteIdeaPreview, CoreError> =>
    requireLibrary('deleting an Idea').pipe(
      Effect.flatMap((library) =>
        provide(
          Effect.gen(function* () {
            const parsedPath = ideaRelativePathSchema.safeParse(relativePath)
            if (!parsedPath.success) {
              return yield* Effect.fail(
                new CoreError('INVALID_INPUT', 'The Idea reference is not portable')
              )
            }
            const folder = parsedPath.data
            const summary = yield* readIdeaSummary(library, folder)
            if (!summary) {
              return yield* Effect.fail(new CoreError('IDEA_NOT_FOUND', 'The Idea was not found'))
            }
            const ideaDir = join(library, folder)
            const recovery = yield* Effect.promise(() => readRecovery(ideaDir))
            const ownedFiles = new Set([
              recovery?.documents.root.path ?? IDEA_FILE,
              recovery?.documents.planningIndex.path ?? 'planning/index.md',
              recovery?.documents.conversation.path ?? 'planning/conversation.md'
            ])
            const partition = yield* Effect.tryPromise({
              try: () => partitionIdeaFolder(ideaDir, ownedFiles),
              catch: () => new CoreError('IO_ERROR', 'Could not inspect the Idea folder')
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
              const ideaDir = join(library, input.relativePath)
              const idea = yield* readIdeaSummary(library, input.relativePath)
              if (!idea) {
                return yield* Effect.fail(new CoreError('IDEA_NOT_FOUND', 'The Idea was not found'))
              }
              if (input.configuration.workingDirectory !== ideaDir) {
                return yield* Effect.fail(
                  new CoreError('INVALID_INPUT', 'Run Working Directory does not match the Idea')
                )
              }
              const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
              const submissionKey = createHash('sha256').update(input.submissionId).digest('hex')
              const submissionsDir = join(ideaDir, '.idea', 'submissions')
              const runsDir = join(ideaDir, '.idea', 'runs')
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
              const clock = yield* IdeaClock
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
            const parsedPath = ideaRelativePathSchema.parse(relativePath)
            const runsDir = join(library, parsedPath, '.idea', 'runs')
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
              const path = join(library, event.relativePath, '.idea', 'runs', `${event.runId}.json`)
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
              const clock = yield* IdeaClock
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
    captureIdea: (input) => provide(captureIdea(input)),
    openIdea,
    listIdeas: () => listIdeas,
    queryMailbox,
    setIdeaPinned: (relativePath, pinned) => updateRootFlags(relativePath, { pinned }),
    setIdeaArchived: (relativePath, archived) => updateRootFlags(relativePath, { archived }),
    previewDeleteIdea,
    acceptRun,
    listRuns,
    recordRunEvent,
    getConversation: (relativePath) => conversation.get(relativePath),
    submitConversationMessage: (input) => conversation.submit(input),
    beginConversationRun: (input) => conversation.begin(input),
    applyHarnessEvent: (input) => conversation.apply(input),
    ingestProviderOutput: (input) => conversation.ingest(input),
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
    captureIdea: (input) => run(core.captureIdea(input)),
    openIdea: (relativePath) => run(core.openIdea(relativePath)),
    listIdeas: () => run(core.listIdeas()),
    queryMailbox: (query) => run(core.queryMailbox(query)),
    setIdeaPinned: (relativePath, pinned) => run(core.setIdeaPinned(relativePath, pinned)),
    setIdeaArchived: (relativePath, archived) => run(core.setIdeaArchived(relativePath, archived)),
    previewDeleteIdea: (relativePath) => run(core.previewDeleteIdea(relativePath)),
    acceptRun: (input) => run(core.acceptRun(input)),
    listRuns: (relativePath) => run(core.listRuns(relativePath)),
    recordRunEvent: (input) => run(core.recordRunEvent(input)),
    getConversation: (relativePath) => run(core.getConversation(relativePath)),
    submitConversationMessage: (input) => run(core.submitConversationMessage(input)),
    beginConversationRun: (input) => run(core.beginConversationRun(input)),
    applyHarnessEvent: (input) => run(core.applyHarnessEvent(input)),
    ingestProviderOutput: (input) => run(core.ingestProviderOutput(input)),
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
            : Effect.fail(new CoreError('IO_ERROR', `Could not create Idea folder in ${library}`))
        )
      )
      if (created) return candidate
    }
  })
}

/** Renders the canonical root document, shared by persistence and indexing. */
function renderRootDocument(idea: IdeaSummary, notes: string): string {
  const body = notes.replace(/\r\n/g, '\n').trim()
  return [
    '---',
    'format: 1',
    `id: ${idea.id}`,
    `kind: ${idea.kind}`,
    `status: ${idea.status}`,
    `created: ${idea.createdAt}`,
    `updated: ${idea.updatedAt}`,
    `pinned: ${idea.pinned}`,
    ...(idea.archivedAt ? [`archived: ${idea.archivedAt}`] : []),
    'planning_index: planning/index.md',
    'conversation: planning/conversation.md',
    '---',
    '',
    `# ${idea.title}`,
    ...(body ? ['', body] : []),
    ''
  ].join('\n')
}

function writePortableIdea(
  ideaDir: string,
  idea: IdeaSummary,
  notes: string,
  planningIndexId: string,
  conversationId: string
): Effect.Effect<void, CoreError> {
  const root = renderRootDocument(idea, notes)
  const planningIndex = [
    '---',
    'format: 1',
    `document_id: ${planningIndexId}`,
    `idea_id: ${idea.id}`,
    'document_kind: planning-index',
    'conversation: conversation.md',
    '---',
    '',
    '# Planning Index',
    '',
    '- [Idea](../idea.md) — the stable root Idea',
    '- [Conversation](conversation.md) — the permanent planning history',
    ''
  ].join('\n')
  const conversation = [
    '---',
    'format: 1',
    `document_id: ${conversationId}`,
    `idea_id: ${idea.id}`,
    'document_kind: conversation',
    '---',
    '',
    '# Conversation',
    '',
    'This permanent Conversation belongs to the Idea.',
    ''
  ].join('\n')
  const identity = {
    format: 1,
    ideaId: idea.id,
    summary: idea,
    documents: {
      root: { id: idea.id, path: 'idea.md' },
      planningIndex: { id: planningIndexId, path: 'planning/index.md' },
      conversation: { id: conversationId, path: 'planning/conversation.md' }
    }
  }

  return writeManagedDocuments(ideaDir, identity, [
    { path: IDEA_FILE, content: root },
    { path: 'planning/index.md', content: planningIndex },
    { path: 'planning/conversation.md', content: conversation }
  ])
}

type RecoveryIdentity = Pick<RecoveryState, 'format' | 'ideaId' | 'summary' | 'documents'>

/**
 * Writes the managed documents and the private identity record together.
 * Writes are direct; the caller holds the write permit, so the order here is
 * the order on disk.
 */
function writeManagedDocuments(
  ideaDir: string,
  identity: RecoveryIdentity,
  documents: { path: string; content: string }[]
): Effect.Effect<void, CoreError> {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(join(ideaDir, '.idea'), { recursive: true })
      for (const document of documents) {
        await mkdir(join(ideaDir, document.path, '..'), { recursive: true })
        await writeFile(join(ideaDir, document.path), document.content, 'utf8')
      }
      await writeJsonAtomic(join(ideaDir, '.idea', 'recovery.json'), identity)
    },
    catch: (error) =>
      error instanceof CoreError
        ? error
        : new CoreError(
            'IO_ERROR',
            error instanceof Error ? error.message : `Could not save the Idea to ${ideaDir}`
          )
  })
}

function scanIdeas(library: string): Effect.Effect<IdeaSummary[], CoreError> {
  return Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(library, { withFileTypes: true }),
      catch: () => new CoreError('IO_ERROR', `Could not read the Idea Library at ${library}`)
    })
    // Dot-folders (like the disposable .index projection) are never Ideas.
    const folders = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    yield* Effect.forEach(folders, (entry) => migrateSupportedIdea(join(library, entry.name)), {
      concurrency: 1
    })
    const summaries = yield* Effect.forEach(
      folders,
      (entry) => readIdeaSummary(library, entry.name),
      { concurrency: SCAN_CONCURRENCY }
    )
    return summaries
      .filter((summary): summary is IdeaSummary => summary !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title))
  })
}

interface RecoveryState {
  format: number
  ideaId: string
  summary?: IdeaSummary
  documents: {
    root: { id: string; path: string }
    planningIndex: { id: string; path: string }
    conversation: { id: string; path: string }
  }
}

function reopenIdea(library: string, relativePath: string): Effect.Effect<OpenedIdea, CoreError> {
  return Effect.gen(function* () {
    const parsedPath = ideaRelativePathSchema.safeParse(relativePath)
    if (!parsedPath.success) {
      return yield* Effect.fail(
        new CoreError('INVALID_INPUT', 'The Idea reference is not portable')
      )
    }
    const ideaDir = join(library, parsedPath.data)
    const summary = yield* readIdeaSummary(library, parsedPath.data)
    if (!summary)
      return yield* Effect.fail(new CoreError('IDEA_NOT_FOUND', 'The Idea was not found'))

    const rootDocument = yield* Effect.tryPromise({
      try: () => findRootDocument(ideaDir),
      catch: () => new CoreError('IO_ERROR', 'The root Idea is unreadable')
    })
    if (!rootDocument) {
      return yield* Effect.fail(new CoreError('IO_ERROR', 'The root Idea is unreadable'))
    }

    const recoveryPath = join(ideaDir, '.idea', 'recovery.json')
    const recovery = yield* Effect.tryPromise({
      try: async () => JSON.parse(await readFile(recoveryPath, 'utf8')) as RecoveryState,
      catch: () => new CoreError('IO_ERROR', 'The private recovery metadata is unreadable')
    })
    const identities = yield* Effect.tryPromise({
      try: () => collectManagedIdentities(ideaDir),
      catch: () => new CoreError('IO_ERROR', 'Managed content could not be read')
    })
    const rootPath = identities.get(recovery.documents.root.id)
    const planningIndexPath = identities.get(recovery.documents.planningIndex.id)
    const conversationPath = identities.get(recovery.documents.conversation.id)
    if (!rootPath || !planningIndexPath || !conversationPath) {
      return yield* Effect.fail(
        new CoreError('IO_ERROR', 'One or more canonical planning documents could not be recovered')
      )
    }
    const documents = {
      root: { ...recovery.documents.root, path: rootPath },
      planningIndex: { ...recovery.documents.planningIndex, path: planningIndexPath },
      conversation: { ...recovery.documents.conversation, path: conversationPath }
    }
    const nextRecovery: RecoveryState = { ...recovery, summary, documents }
    const repaired = yield* repairPortableLinks(ideaDir, nextRecovery)
    if (!repaired) {
      yield* Effect.tryPromise({
        try: () => writeJsonAtomic(recoveryPath, nextRecovery),
        catch: () => new CoreError('IO_ERROR', 'Could not refresh managed-content identities')
      })
    }

    return {
      idea: summary,
      documents: {
        root: { id: documents.root.id, kind: 'root' as const, path: rootPath },
        planningIndex: {
          id: documents.planningIndex.id,
          kind: 'planning-index' as const,
          path: planningIndexPath
        },
        conversation: {
          id: documents.conversation.id,
          kind: 'conversation' as const,
          path: conversationPath
        }
      }
    }
  })
}

async function collectManagedIdentities(ideaDir: string): Promise<Map<string, string>> {
  const identities = new Map<string, string>()
  for (const path of await listMarkdownPaths(ideaDir)) {
    const parsed = parseIdeaMarkdown(await readFile(join(ideaDir, path), 'utf8'))
    if (!parsed) continue
    const id = parsed.frontmatter['document_id'] ?? parsed.frontmatter['id']
    if (id) identities.set(id, path)
  }
  return identities
}

async function findRootDocument(ideaDir: string): Promise<{
  path: string
  raw: string
  parsed: NonNullable<ReturnType<typeof parseIdeaMarkdown>>
} | null> {
  const recoveryRaw = await readFile(join(ideaDir, '.idea', 'recovery.json'), 'utf8').catch(
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
  for (const path of await listMarkdownPaths(ideaDir)) {
    const raw = await readFile(join(ideaDir, path), 'utf8')
    const parsed = parseIdeaMarkdown(raw)
    if (!parsed) continue
    const id = parsed.frontmatter['id']
    if ((rootId && id === rootId) || (!rootId && path === IDEA_FILE && id)) {
      return { path, raw, parsed }
    }
  }
  return null
}

function repairPortableLinks(
  ideaDir: string,
  recovery: RecoveryState
): Effect.Effect<boolean, CoreError> {
  return Effect.gen(function* () {
    const rootPath = recovery.documents.root.path
    const indexPath = recovery.documents.planningIndex.path
    const conversationPath = recovery.documents.conversation.path
    const [rootRaw, indexRaw] = yield* Effect.tryPromise({
      try: () =>
        Promise.all([
          readFile(join(ideaDir, rootPath), 'utf8'),
          readFile(join(ideaDir, indexPath), 'utf8')
        ]),
      catch: () => new CoreError('IO_ERROR', 'Managed links could not be inspected')
    })
    const fromRoot = posix.dirname(rootPath)
    const fromIndex = posix.dirname(indexPath)
    const rootToIndex = posix.relative(fromRoot, indexPath)
    const rootToConversation = posix.relative(fromRoot, conversationPath)
    const indexToRoot = posix.relative(fromIndex, rootPath)
    const indexToConversation = posix.relative(fromIndex, conversationPath)
    const nextRoot = replaceFrontmatterField(
      replaceFrontmatterField(rootRaw, 'planning_index', rootToIndex),
      'conversation',
      rootToConversation
    )
    const nextIndex = replaceFrontmatterField(indexRaw, 'conversation', indexToConversation)
      .replace(/^- \[Idea\]\([^\n)]*\)/m, `- [Idea](${indexToRoot})`)
      .replace(/^- \[Conversation\]\([^\n)]*\)/m, `- [Conversation](${indexToConversation})`)
    if (nextRoot === rootRaw && nextIndex === indexRaw) return false

    yield* writeManagedDocuments(ideaDir, recovery, [
      { path: rootPath, content: nextRoot },
      { path: indexPath, content: nextIndex }
    ])
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
    if (entry.name === '.idea') continue
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

function readIdeaSummary(
  library: string,
  folder: string
): Effect.Effect<IdeaSummary | null, CoreError> {
  return Effect.gen(function* () {
    const ideaDir = join(library, folder)
    const root = yield* Effect.tryPromise(() => findRootDocument(ideaDir)).pipe(
      Effect.orElseSucceed(() => null)
    )
    if (!root) return null
    const parsed = root.parsed
    const archivedRaw = parsed.frontmatter['archived']
    const candidate = {
      id: parsed.frontmatter['id'],
      kind: parsed.frontmatter['kind'],
      title: parsed.title,
      status: parsed.frontmatter['status'],
      createdAt: parsed.frontmatter['created'],
      updatedAt: parsed.frontmatter['updated'],
      relativePath: folder,
      // pinned and archived accept external edits; junk reads as the default.
      pinned: parsed.frontmatter['pinned'] === 'true',
      archivedAt:
        archivedRaw && z.string().datetime().safeParse(archivedRaw).success ? archivedRaw : null
    }
    const validated = ideaSummarySchema.safeParse(candidate)
    if (!validated.success) return null
    yield* Effect.tryPromise({
      try: () =>
        writeJsonAtomic(join(ideaDir, '.idea', 'projection.json'), {
          format: 1,
          source: 'canonical-markdown',
          idea: validated.data
        }),
      catch: () => new CoreError('IO_ERROR', 'Could not rebuild the Idea projection')
    })
    return validated.data
  })
}

function migrateSupportedIdea(ideaDir: string): Effect.Effect<void, CoreError> {
  return Effect.gen(function* () {
    const rootPath = join(ideaDir, IDEA_FILE)
    const raw = yield* Effect.tryPromise(() => readFile(rootPath, 'utf8')).pipe(
      Effect.orElseSucceed(() => null)
    )
    if (raw === null) return
    const parsed = parseIdeaMarkdown(raw)
    if (!parsed) return
    const format = Number(parsed.frontmatter['format'] ?? '0')
    if (format !== 0) return

    const candidate = ideaSummarySchema.safeParse({
      id: parsed.frontmatter['id'],
      kind: parsed.frontmatter['kind'],
      title: parsed.title,
      status: parsed.frontmatter['status'],
      createdAt: parsed.frontmatter['created'],
      updatedAt: parsed.frontmatter['updated'],
      relativePath: basename(ideaDir)
    })
    if (!candidate.success) return

    const hash = createHash('sha256').update(`idea.md\0${raw}`).digest('hex')
    const snapshotDir = join(ideaDir, '.idea', 'snapshots', hash)
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(snapshotDir, { recursive: true })
        await writeFile(join(snapshotDir, IDEA_FILE), raw, 'utf8')
        await writeJsonAtomic(join(snapshotDir, 'manifest.json'), {
          format: 1,
          reason: 'before-format-1-migration',
          contentHash: hash,
          files: [{ path: IDEA_FILE, sha256: createHash('sha256').update(raw).digest('hex') }]
        })
      },
      catch: (error) =>
        new CoreError(
          'IO_ERROR',
          error instanceof Error ? error.message : 'Could not snapshot the legacy Idea'
        )
    })

    const headingMarker = `# ${candidate.data.title}`
    const headingIndex = raw.indexOf(headingMarker)
    const notes = headingIndex === -1 ? '' : raw.slice(headingIndex + headingMarker.length).trim()
    yield* writePortableIdea(
      ideaDir,
      candidate.data,
      notes,
      `${candidate.data.id}:planning-index`,
      `${candidate.data.id}:conversation`
    )
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

async function readRecovery(ideaDir: string): Promise<RecoveryState | null> {
  const raw = await readFile(join(ideaDir, '.idea', 'recovery.json'), 'utf8').catch(() => null)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as RecoveryState
  } catch {
    return null
  }
}

function indexedIdeasFor(library: string, ideas: IdeaSummary[]): Effect.Effect<IndexedIdea[]> {
  return Effect.forEach(
    ideas,
    (summary) =>
      Effect.promise(async (): Promise<IndexedIdea> => {
        const root = await findRootDocument(join(library, summary.relativePath)).catch(() => null)
        return { summary, body: root ? markdownBody(root.raw) : '' }
      }),
    { concurrency: SCAN_CONCURRENCY }
  )
}

function rebuildProjection(library: string, ideas: IdeaSummary[]): Effect.Effect<void, CoreError> {
  return indexedIdeasFor(library, ideas).pipe(
    Effect.flatMap((indexed) =>
      Effect.try({
        try: () => rebuildIndex(library, indexed),
        catch: () => new CoreError('IO_ERROR', 'Could not rebuild the search index')
      })
    )
  )
}

/** Best-effort projection refresh: a failed upsert self-heals on query. */
function upsertProjection(library: string, idea: IdeaSummary, body: string): Effect.Effect<void> {
  return Effect.sync(() => {
    try {
      upsertIdea(library, { summary: idea, body })
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
 * Splits an Idea folder into app-owned delete targets and foreign content to
 * keep. A directory whose entire subtree is app-owned collapses into a single
 * target; `.idea` private state is always app-owned.
 */
async function partitionIdeaFolder(
  ideaDir: string,
  ownedFiles: Set<string>
): Promise<FolderPartition> {
  async function walk(prefix: string): Promise<FolderPartition> {
    const entries = await readdir(join(ideaDir, prefix), { withFileTypes: true })
    if (entries.length === 0) return { allOwned: false, targets: [], keeps: [prefix] }
    const results: FolderPartition[] = []
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        results.push(
          rel === '.idea' ? { allOwned: true, targets: [rel], keeps: [] } : await walk(rel)
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

function parseIdeaMarkdown(
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
  return slug || 'idea'
}
