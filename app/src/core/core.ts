import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'
import { Cause, Context, Effect, Exit, Layer, Option, Ref } from 'effect'
import {
  CoreError,
  captureIdeaInputSchema,
  ideaRelativePathSchema,
  ideaSummarySchema,
  type CaptureIdeaInput,
  type OpenedIdea,
  type IdeaSummary,
  type LibrarySnapshot
} from '@shared/contract'
import { suggestIdeaTitle } from '@shared/title'

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
      return { path, ideas: yield* provide(scanIdeas(path)) }
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
            relativePath: yield* reserveFolder(library, title)
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

  return {
    openLibrary,
    captureIdea: (input) => provide(captureIdea(input)),
    openIdea,
    listIdeas: () => listIdeas
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
    listIdeas: () => run(core.listIdeas())
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

type TransactionId = 'capture' | 'format-1-migration' | 'repair-links'

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
    const folders = entries.filter((entry) => entry.isDirectory())
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
    const candidate = {
      id: parsed.frontmatter['id'],
      kind: parsed.frontmatter['kind'],
      title: parsed.title,
      status: parsed.frontmatter['status'],
      createdAt: parsed.frontmatter['created'],
      updatedAt: parsed.frontmatter['updated'],
      openState: format > 1 ? 'read-only-newer-format' : wasRecovered ? 'recovered' : 'ready',
      relativePath: folder
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
