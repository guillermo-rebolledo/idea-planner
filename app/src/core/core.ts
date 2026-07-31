import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
 */
export interface Core {
  openLibrary(path: string): Promise<LibrarySnapshot>
  captureIdea(input: CaptureIdeaInput): Promise<IdeaSummary>
  listIdeas(): Promise<IdeaSummary[]>
}

const IDEA_FILE = 'idea.md'
const MAX_SLUG_LENGTH = 40

export function createCore(deps: CoreDeps = {}): Core {
  const now = deps.now ?? (() => new Date())
  const randomId = deps.randomId ?? (() => `idea-${randomUUID()}`)

  let libraryPath: string | null = null
  // Writes are serialized so two captures can never race on folder naming.
  let writeQueue: Promise<unknown> = Promise.resolve()

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(work, work)
    writeQueue = result.catch(() => undefined)
    return result
  }

  async function openLibrary(path: string): Promise<LibrarySnapshot> {
    let stats
    try {
      stats = await stat(path)
    } catch {
      throw new CoreError('LIBRARY_MISSING', `No folder exists at ${path}`)
    }
    if (!stats.isDirectory()) {
      throw new CoreError('NOT_A_DIRECTORY', `${path} is not a folder`)
    }
    libraryPath = path
    return { path, ideas: await scanIdeas(path) }
  }

  async function captureIdea(rawInput: CaptureIdeaInput): Promise<IdeaSummary> {
    if (libraryPath === null) {
      throw new CoreError('NO_LIBRARY_OPEN', 'Open an Idea Library before capturing an Idea')
    }
    const parsed = captureIdeaInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new CoreError('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid Idea input')
    }
    const library = libraryPath
    const input = parsed.data
    const title = input.title.trim() || suggestIdeaTitle(input.notes)

    return enqueue(async () => {
      const timestamp = now().toISOString()
      const idea: IdeaSummary = {
        id: randomId(),
        kind: input.kind,
        title,
        status: 'saved',
        createdAt: timestamp,
        updatedAt: timestamp,
        relativePath: await reserveFolder(library, title)
      }
      await writeIdeaFile(join(library, idea.relativePath), idea, input.notes)
      return idea
    })
  }

  async function listIdeas(): Promise<IdeaSummary[]> {
    if (libraryPath === null) {
      throw new CoreError('NO_LIBRARY_OPEN', 'Open an Idea Library before listing Ideas')
    }
    return scanIdeas(libraryPath)
  }

  return { openLibrary, captureIdea, listIdeas }
}

async function reserveFolder(library: string, title: string): Promise<string> {
  const base = slugify(title)
  for (let attempt = 1; ; attempt++) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`
    try {
      await mkdir(join(library, candidate))
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new CoreError('IO_ERROR', `Could not create Idea folder in ${library}`)
      }
    }
  }
}

async function writeIdeaFile(ideaDir: string, idea: IdeaSummary, notes: string): Promise<void> {
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
  try {
    await writeFile(staged, markdown, 'utf8')
    await rename(staged, join(ideaDir, IDEA_FILE))
  } catch {
    throw new CoreError('IO_ERROR', `Could not save the Idea to ${ideaDir}`)
  }
}

async function scanIdeas(library: string): Promise<IdeaSummary[]> {
  let entries
  try {
    entries = await readdir(library, { withFileTypes: true })
  } catch {
    throw new CoreError('IO_ERROR', `Could not read the Idea Library at ${library}`)
  }

  const ideas: IdeaSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const summary = await readIdeaSummary(library, entry.name)
    if (summary) ideas.push(summary)
  }

  return ideas.sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title)
  )
}

async function readIdeaSummary(library: string, folder: string): Promise<IdeaSummary | null> {
  let raw: string
  try {
    raw = await readFile(join(library, folder, IDEA_FILE), 'utf8')
  } catch {
    return null
  }
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
