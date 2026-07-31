import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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
import { suggestIdeaTitle } from '@shared/title'
import {
  emptyMailbox,
  indexExists,
  queryIndex,
  rebuildIndex,
  upsertIdea,
  type IndexedIdea
} from './search-index'

export interface CoreDeps {
  now?: () => Date
  randomId?: () => string
  onTransactionBoundary?: (boundary: TransactionBoundary) => void
}

export type TransactionBoundary =
  | { phase: 'prepared' }
  | { phase: 'document-committed'; documentIndex: number }
  | { phase: 'before-finalize' }

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
}

const IDEA_FILE = 'idea.md'
const MAX_SLUG_LENGTH = 40
const SCAN_CONCURRENCY = 8

class IdeaClock extends Context.Tag('core/IdeaClock')<IdeaClock, { now(): Date }>() {}
class IdGenerator extends Context.Tag('core/IdGenerator')<IdGenerator, { nextId(): string }>() {}
class TransactionObserver extends Context.Tag('core/TransactionObserver')<
  TransactionObserver,
  { onBoundary(boundary: TransactionBoundary): void }
>() {}

type CoreServices = IdeaClock | IdGenerator | TransactionObserver

export function createCoreEffects(deps: CoreDeps = {}): CoreEffects {
  const services: Layer.Layer<CoreServices> = Layer.mergeAll(
    Layer.succeed(IdeaClock, { now: deps.now ?? (() => new Date()) }),
    Layer.succeed(IdGenerator, { nextId: deps.randomId ?? (() => `idea-${randomUUID()}`) }),
    Layer.succeed(TransactionObserver, {
      onBoundary: deps.onTransactionBoundary ?? (() => undefined)
    })
  )

  const libraryPath = Effect.runSync(Ref.make(Option.none<string>()))
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
            openState: 'ready',
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
            conversationId,
            'capture'
          )
          yield* upsertProjection(library, idea, `# ${idea.title}\n\n${input.notes}`)
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
    transactionId: 'set-pinned' | 'set-archived',
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
              const summary = yield* readIdeaSummary(library, folder, false)
              if (!summary) {
                return yield* Effect.fail(new CoreError('IDEA_NOT_FOUND', 'The Idea was not found'))
              }
              if (summary.openState === 'read-only-newer-format') {
                return yield* Effect.fail(
                  new CoreError(
                    'INVALID_INPUT',
                    'This Idea was written by a newer app format and is open read-only'
                  )
                )
              }
              if (summary.openState === 'unrecoverable-content') {
                return yield* Effect.fail(
                  new CoreError('UNRECOVERABLE_CONTENT', 'Canonical Idea content is unreadable')
                )
              }
              const ideaDir = join(library, folder)
              const root = yield* Effect.tryPromise({
                try: () => findRootDocument(ideaDir),
                catch: () => new CoreError('UNRECOVERABLE_CONTENT', 'The root Idea is unreadable')
              })
              if (!root) {
                return yield* Effect.fail(
                  new CoreError('UNRECOVERABLE_CONTENT', 'The root Idea is unreadable')
                )
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
              yield* commitTransaction(
                ideaDir,
                identity,
                [{ path: root.path, content: nextRaw }],
                transactionId,
                recovery?.events ?? []
              )
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
            const summary = yield* readIdeaSummary(library, folder, false)
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

  return {
    openLibrary,
    captureIdea: (input) => provide(captureIdea(input)),
    openIdea,
    listIdeas: () => listIdeas,
    queryMailbox,
    setIdeaPinned: (relativePath, pinned) =>
      updateRootFlags(relativePath, 'set-pinned', { pinned }),
    setIdeaArchived: (relativePath, archived) =>
      updateRootFlags(relativePath, 'set-archived', { archived }),
    previewDeleteIdea
  }
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
    previewDeleteIdea: (relativePath) => run(core.previewDeleteIdea(relativePath))
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

function writePortableIdea(
  ideaDir: string,
  idea: IdeaSummary,
  notes: string,
  planningIndexId: string,
  conversationId: string,
  transactionId: TransactionId
): Effect.Effect<void, CoreError, TransactionObserver> {
  const body = notes.replace(/\r\n/g, '\n').trim()
  const root = [
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

  return commitTransaction(
    ideaDir,
    identity,
    [
      { path: IDEA_FILE, content: root },
      { path: 'planning/index.md', content: planningIndex },
      { path: 'planning/conversation.md', content: conversation }
    ],
    transactionId,
    []
  )
}

type TransactionId =
  'capture' | 'format-1-migration' | 'repair-links' | 'set-pinned' | 'set-archived'

type RecoveryIdentity = Pick<RecoveryState, 'format' | 'ideaId' | 'summary' | 'documents'>

function commitTransaction(
  ideaDir: string,
  identity: RecoveryIdentity,
  documents: { path: string; content: string }[],
  transactionId: TransactionId,
  priorEvents: RecoveryState['events']
): Effect.Effect<void, CoreError, TransactionObserver> {
  return Effect.gen(function* () {
    const observer = yield* TransactionObserver
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(join(ideaDir, '.idea'), { recursive: true })
        const transactionDir = join(ideaDir, '.idea', 'transactions', transactionId)
        for (const document of documents) {
          const staged = join(transactionDir, document.path)
          await mkdir(join(staged, '..'), { recursive: true })
          await writeFile(staged, document.content, 'utf8')
          const target = join(ideaDir, document.path)
          const targetExists = await pathExists(target)
          if (targetExists) await copyFile(target, `${staged}.previous`)
        }
        const recoveryPath = join(ideaDir, '.idea', 'recovery.json')
        const previousRecovery = join(transactionDir, '.recovery.previous')
        const hasPreviousRecovery = await pathExists(recoveryPath)
        if (hasPreviousRecovery) await copyFile(recoveryPath, previousRecovery)
        await writeJsonAtomic(recoveryPath, {
          ...identity,
          events: [...priorEvents, { type: 'transaction-prepared', transactionId }],
          transaction: {
            id: transactionId,
            state: 'prepared',
            previousRecovery: hasPreviousRecovery
              ? `.idea/transactions/${transactionId}/.recovery.previous`
              : undefined,
            writes: documents.map((document) => ({
              target: document.path,
              staged: `.idea/transactions/${transactionId}/${document.path}`,
              previous: `.idea/transactions/${transactionId}/${document.path}.previous`,
              sha256: createHash('sha256').update(document.content).digest('hex')
            }))
          }
        })
        observer.onBoundary({ phase: 'prepared' })

        for (const [documentIndex, document] of documents.entries()) {
          await mkdir(join(ideaDir, document.path, '..'), { recursive: true })
          await rename(join(transactionDir, document.path), join(ideaDir, document.path))
          observer.onBoundary({ phase: 'document-committed', documentIndex })
        }
        observer.onBoundary({ phase: 'before-finalize' })
        await writeJsonAtomic(recoveryPath, {
          ...identity,
          events: [...priorEvents, { type: 'transaction-completed', transactionId }],
          transaction: null
        })
        await rm(transactionDir, { recursive: true, force: true })
      },
      catch: (error) =>
        error instanceof CoreError
          ? error
          : new CoreError(
              'IO_ERROR',
              error instanceof Error ? error.message : `Could not save the Idea to ${ideaDir}`
            )
    })
  })
}

function scanIdeas(library: string): Effect.Effect<IdeaSummary[], CoreError, TransactionObserver> {
  return Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(library, { withFileTypes: true }),
      catch: () => new CoreError('IO_ERROR', `Could not read the Idea Library at ${library}`)
    })
    // Dot-folders (like the disposable .index projection) are never Ideas.
    const folders = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    const recoveries = yield* Effect.forEach(
      folders,
      (entry) => recoverIdeaTransaction(join(library, entry.name)),
      { concurrency: 1 }
    )
    yield* Effect.forEach(folders, (entry) => migrateSupportedIdea(join(library, entry.name)), {
      concurrency: 1
    })
    const summaries = yield* Effect.forEach(
      folders,
      (entry, index) => readIdeaSummary(library, entry.name, recoveries[index] ?? false),
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
  events: { type: string; transactionId: string }[]
  transaction: null | {
    id: string
    state: 'prepared'
    previousRecovery?: string
    writes: { target: string; staged: string; previous?: string; sha256: string }[]
  }
}

function reopenIdea(
  library: string,
  relativePath: string
): Effect.Effect<OpenedIdea, CoreError, TransactionObserver> {
  return Effect.gen(function* () {
    const parsedPath = ideaRelativePathSchema.safeParse(relativePath)
    if (!parsedPath.success) {
      return yield* Effect.fail(
        new CoreError('INVALID_INPUT', 'The Idea reference is not portable')
      )
    }
    const ideaDir = join(library, parsedPath.data)
    const summary = yield* readIdeaSummary(library, parsedPath.data, false)
    if (!summary)
      return yield* Effect.fail(new CoreError('IDEA_NOT_FOUND', 'The Idea was not found'))

    const rootDocument = yield* Effect.tryPromise({
      try: () => findRootDocument(ideaDir),
      catch: () => new CoreError('UNRECOVERABLE_CONTENT', 'The root Idea is unreadable')
    })
    if (!rootDocument) {
      return yield* Effect.fail(
        new CoreError('UNRECOVERABLE_CONTENT', 'The root Idea is unreadable')
      )
    }

    if (summary.openState === 'read-only-newer-format') {
      return {
        idea: summary,
        documents: {
          root: { id: summary.id, kind: 'root' as const, path: rootDocument.path },
          planningIndex: {
            id: `${summary.id}:newer-planning-index`,
            kind: 'planning-index' as const,
            path: rootDocument.parsed.frontmatter['planning_index'] ?? 'planning/index.md'
          },
          conversation: {
            id: `${summary.id}:newer-conversation`,
            kind: 'conversation' as const,
            path: rootDocument.parsed.frontmatter['conversation'] ?? 'planning/conversation.md'
          }
        },
        notice: 'This Idea was written by a newer app format. Update the app to edit it.'
      }
    }

    const recoveryPath = join(ideaDir, '.idea', 'recovery.json')
    const recovery = yield* Effect.tryPromise({
      try: async () => JSON.parse(await readFile(recoveryPath, 'utf8')) as RecoveryState,
      catch: () =>
        new CoreError('UNRECOVERABLE_CONTENT', 'The private recovery metadata is unreadable')
    })
    const identities = yield* Effect.tryPromise({
      try: () => collectManagedIdentities(ideaDir),
      catch: () => new CoreError('UNRECOVERABLE_CONTENT', 'Managed content could not be read')
    })
    const rootPath = identities.get(recovery.documents.root.id)
    const planningIndexPath = identities.get(recovery.documents.planningIndex.id)
    const conversationPath = identities.get(recovery.documents.conversation.id)
    if (!rootPath || !planningIndexPath || !conversationPath) {
      return yield* Effect.fail(
        new CoreError(
          'UNRECOVERABLE_CONTENT',
          'One or more canonical planning documents could not be recovered'
        )
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
      },
      notice:
        summary.openState === 'recovered'
          ? 'An interrupted write was recovered from local content.'
          : null
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
): Effect.Effect<boolean, CoreError, TransactionObserver> {
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
      catch: () => new CoreError('UNRECOVERABLE_CONTENT', 'Managed links could not be inspected')
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

    yield* commitTransaction(
      ideaDir,
      recovery,
      [
        { path: rootPath, content: nextRoot },
        { path: indexPath, content: nextIndex }
      ],
      'repair-links',
      recovery.events
    )
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

function recoverIdeaTransaction(ideaDir: string): Effect.Effect<boolean, CoreError> {
  return Effect.tryPromise({
    try: async () => {
      const recoveryPath = join(ideaDir, '.idea', 'recovery.json')
      const raw = await readFile(recoveryPath, 'utf8').catch(() => null)
      if (raw === null) return false
      const recovery = JSON.parse(raw) as RecoveryState
      if (!recovery.transaction) return false
      if (recovery.format > 1) return false
      const rootDocument = await findRootDocument(ideaDir).catch(() => null)
      const rootFormat = Number(rootDocument?.parsed.frontmatter['format'] ?? '0')
      if (rootFormat > 1) return false
      if (
        recovery.transaction.writes.some(
          (write) =>
            !isPortableManagedPath(write.target) ||
            !isPortableManagedPath(write.staged) ||
            (write.previous !== undefined && !isPortableManagedPath(write.previous))
        ) ||
        (recovery.transaction.previousRecovery !== undefined &&
          !isPortableManagedPath(recovery.transaction.previousRecovery))
      ) {
        return false
      }

      const cannotComplete = (
        await Promise.all(
          recovery.transaction.writes.map(async (write) => {
            const stagedExists = await pathExists(join(ideaDir, write.staged))
            if (stagedExists) return false
            const target = join(ideaDir, write.target)
            if (!(await pathExists(target))) return true
            const targetHash = createHash('sha256')
              .update(await readFile(target, 'utf8'))
              .digest('hex')
            return targetHash !== write.sha256
          })
        )
      ).some(Boolean)
      if (cannotComplete) {
        if (recovery.transaction.id === 'capture') {
          await rm(ideaDir, { recursive: true, force: true })
          return true
        }
        for (const write of recovery.transaction.writes) {
          const target = join(ideaDir, write.target)
          const previous = write.previous ? join(ideaDir, write.previous) : null
          if (previous && (await pathExists(previous))) await rename(previous, target)
          else await rm(target, { force: true })
        }
        const previousRecovery = recovery.transaction.previousRecovery
          ? join(ideaDir, recovery.transaction.previousRecovery)
          : null
        if (previousRecovery && (await pathExists(previousRecovery))) {
          await rename(previousRecovery, recoveryPath)
        } else {
          await rm(recoveryPath, { force: true })
        }
        await rm(join(ideaDir, '.idea', 'transactions', recovery.transaction.id), {
          recursive: true,
          force: true
        })
        return true
      }

      for (const write of recovery.transaction.writes) {
        const staged = join(ideaDir, write.staged)
        const target = join(ideaDir, write.target)
        const stagedExists = await pathExists(staged)
        if (stagedExists) {
          await mkdir(join(target, '..'), { recursive: true })
          await rename(staged, target)
        }
      }
      await writeJsonAtomic(recoveryPath, {
        ...recovery,
        events: [
          ...recovery.events,
          { type: 'transaction-recovered', transactionId: recovery.transaction.id }
        ],
        transaction: null
      })
      await rm(join(ideaDir, '.idea', 'transactions', recovery.transaction.id), {
        recursive: true,
        force: true
      })
      return true
    },
    catch: (error) =>
      new CoreError(
        'IO_ERROR',
        error instanceof Error ? error.message : 'Could not recover an interrupted Idea write'
      )
  })
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

function isPortableManagedPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const staged = `${path}.staged`
  await writeFile(staged, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(staged, path)
}

function readIdeaSummary(
  library: string,
  folder: string,
  recovered: boolean
): Effect.Effect<IdeaSummary | null, CoreError> {
  return Effect.gen(function* () {
    const root = yield* Effect.tryPromise(() => findRootDocument(join(library, folder))).pipe(
      Effect.orElseSucceed(() => null)
    )
    if (!root) return yield* recoverySummary(library, folder)
    const parsed = root.parsed

    const format = Number(parsed.frontmatter['format'] ?? '0')
    const wasRecovered =
      recovered ||
      (yield* Effect.promise(async () => {
        const recoveryRaw = await readFile(
          join(library, folder, '.idea', 'recovery.json'),
          'utf8'
        ).catch(() => null)
        if (!recoveryRaw) return false
        try {
          const recovery = JSON.parse(recoveryRaw) as RecoveryState
          return recovery.events.some((event) => event.type === 'transaction-recovered')
        } catch {
          return false
        }
      }))
    const archivedRaw = parsed.frontmatter['archived']
    const candidate = {
      id: parsed.frontmatter['id'],
      kind: parsed.frontmatter['kind'],
      title: parsed.title,
      status: parsed.frontmatter['status'],
      createdAt: parsed.frontmatter['created'],
      updatedAt: parsed.frontmatter['updated'],
      openState: format > 1 ? 'read-only-newer-format' : wasRecovered ? 'recovered' : 'ready',
      relativePath: folder,
      // pinned and archived accept external edits; junk reads as the default.
      pinned: parsed.frontmatter['pinned'] === 'true',
      archivedAt:
        archivedRaw && z.string().datetime().safeParse(archivedRaw).success ? archivedRaw : null
    }
    const validated = ideaSummarySchema.safeParse(candidate)
    if (!validated.success) return null
    if (validated.data.openState === 'ready' || validated.data.openState === 'recovered') {
      yield* Effect.tryPromise({
        try: () =>
          writeJsonAtomic(join(library, folder, '.idea', 'projection.json'), {
            format: 1,
            source: 'canonical-markdown',
            idea: validated.data
          }),
        catch: () => new CoreError('IO_ERROR', 'Could not rebuild the Idea projection')
      })
    }
    return validated.data
  })
}

function recoverySummary(library: string, folder: string): Effect.Effect<IdeaSummary | null> {
  return Effect.promise(async () => {
    const raw = await readFile(join(library, folder, '.idea', 'recovery.json'), 'utf8').catch(
      () => null
    )
    if (!raw) return null
    try {
      const recovery = JSON.parse(raw) as RecoveryState
      const parsed = ideaSummarySchema.safeParse({
        ...recovery.summary,
        id: recovery.ideaId,
        relativePath: folder,
        openState: 'unrecoverable-content'
      })
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  })
}

function migrateSupportedIdea(
  ideaDir: string
): Effect.Effect<void, CoreError, TransactionObserver> {
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
      openState: 'ready',
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
      `${candidate.data.id}:conversation`,
      'format-1-migration'
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
