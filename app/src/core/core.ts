import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Cause, Context, Effect, Exit, Layer, Option, Ref } from 'effect'
import {
  CoreError,
  captureIdeaInputSchema,
  ideaSummarySchema,
  type CaptureIdeaInput,
  type IdeaSummary,
  type LibrarySnapshot
} from '@shared/contract'
import { suggestIdeaTitle } from '@shared/title'

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
  listIdeas(): Promise<IdeaSummary[]>
}

/**
 * The same behavior as Effect values, for callers inside the Core process
 * (the utility-process dispatcher). Dependencies are already provided.
 */
export interface CoreEffects {
  openLibrary(path: string): Effect.Effect<LibrarySnapshot, CoreError>
  captureIdea(input: CaptureIdeaInput): Effect.Effect<IdeaSummary, CoreError>
  listIdeas(): Effect.Effect<IdeaSummary[], CoreError>
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
      return { path, ideas: yield* scanIdeas(path) }
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
            relativePath: yield* reserveFolder(library, title)
          }
          yield* writeIdeaFile(join(library, idea.relativePath), idea, input.notes)
          return idea
        })
      )
    })

  const listIdeas: Effect.Effect<IdeaSummary[], CoreError> = requireLibrary('listing Ideas').pipe(
    Effect.flatMap(scanIdeas)
  )

  const provide = <A>(
    effect: Effect.Effect<A, CoreError, CoreServices>
  ): Effect.Effect<A, CoreError> => Effect.provide(effect, services)

  return {
    openLibrary,
    captureIdea: (input) => provide(captureIdea(input)),
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

function writeIdeaFile(
  ideaDir: string,
  idea: IdeaSummary,
  notes: string
): Effect.Effect<void, CoreError> {
  const body = notes.replace(/\r\n/g, '\n').trim()
  const markdown = [
    '---',
    `id: ${idea.id}`,
    `kind: ${idea.kind}`,
    `status: ${idea.status}`,
    `created: ${idea.createdAt}`,
    `updated: ${idea.updatedAt}`,
    '---',
    '',
    `# ${idea.title}`,
    ...(body ? ['', body] : []),
    ''
  ].join('\n')

  // Staged sibling file plus atomic rename, so a crash cannot leave a
  // half-written canonical document.
  const staged = join(ideaDir, `.${IDEA_FILE}.staged`)
  return Effect.tryPromise({
    try: async () => {
      await writeFile(staged, markdown, 'utf8')
      await rename(staged, join(ideaDir, IDEA_FILE))
    },
    catch: () => new CoreError('IO_ERROR', `Could not save the Idea to ${ideaDir}`)
  })
}

function scanIdeas(library: string): Effect.Effect<IdeaSummary[], CoreError> {
  return Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(library, { withFileTypes: true }),
      catch: () => new CoreError('IO_ERROR', `Could not read the Idea Library at ${library}`)
    })
    const summaries = yield* Effect.forEach(
      entries.filter((entry) => entry.isDirectory()),
      (entry) => readIdeaSummary(library, entry.name),
      { concurrency: SCAN_CONCURRENCY }
    )
    return summaries
      .filter((summary): summary is IdeaSummary => summary !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title))
  })
}

function readIdeaSummary(library: string, folder: string): Effect.Effect<IdeaSummary | null> {
  return Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      readFile(join(library, folder, IDEA_FILE), 'utf8')
    ).pipe(Effect.orElseSucceed(() => null))
    if (raw === null) return null

    const parsed = parseIdeaMarkdown(raw)
    if (!parsed) return null

    const candidate = {
      id: parsed.frontmatter['id'],
      kind: parsed.frontmatter['kind'],
      title: parsed.title,
      status: parsed.frontmatter['status'],
      createdAt: parsed.frontmatter['created'],
      updatedAt: parsed.frontmatter['updated'],
      relativePath: folder
    }
    const validated = ideaSummarySchema.safeParse(candidate)
    return validated.success ? validated.data : null
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
