import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rm, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
  buildWorktreeBootstrapResult,
  type WorktreeBootstrapProvenance,
  type WorktreeBootstrapResult,
  type WorktreeBootstrapSkipReason
} from '@shared/checkout'
import { promisify } from 'node:util'

const run = promisify(execFile)
const TIMEOUT_MS = 10_000
/** A clone moves no bytes, but a dependency tree is a great deal of metadata. */
const CLONE_TIMEOUT_MS = 120_000
/** A directory pattern can make Git name far more paths than a `.env*` does. */
const LISTING_MAX_BYTES = 64 * 1024 * 1024
const REDIRECTING_GIT_ENV = new Set([
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE'
])

interface BootstrapInput {
  projectRoot: string
  checkoutRoot: string
  /** Restricts a retry to the paths that failed previously. */
  paths?: string[]
  now?: () => Date
}

interface PatternSet {
  pathspecs: string[]
  /** Whether every directory Git calls ignored is a candidate, pattern or not. */
  carriesEveryIgnoredDirectory: boolean
  /** The `!` patterns, normalized, for deciding what may be carried whole. */
  excludes: string[]
  invalid: string[]
  literals: string[]
}

/**
 * Carries eligible local state into a newly created isolated Checkout: the
 * Project's ignored directories, cloned copy-on-write, and its ignored
 * configuration files, copied. Git owns both candidate matching and the
 * ignored decision; filesystem checks then narrow that answer to contained
 * regular files and directories.
 *
 * The result says where that state came from, and how long it took to get
 * there — the cost ADR 0004 asserted and nobody has measured since. It says
 * nothing about whether the state suits the Checkout's base: this reads Git,
 * not lockfiles.
 */
export async function bootstrapWorktree(input: BootstrapInput): Promise<WorktreeBootstrapResult> {
  const now = input.now ?? (() => new Date())
  const startedAt = now()
  const elapsed = (): number => Math.max(0, now().getTime() - startedAt.getTime())
  // Read before anything is carried, so the commit named is the one the
  // copying began from rather than wherever the Project has moved to since.
  const provenance = await observeProvenance(input.projectRoot, () => startedAt)
  const patterns = input.paths ? retryPatterns(input.paths) : await readPatterns(input.projectRoot)
  const skipped: WorktreeBootstrapResult['skipped'] = patterns.invalid.map((path) => ({
    path,
    reason: 'invalid-path'
  }))
  let candidates: string[]
  try {
    // Git reports a whole ignored directory as one name, so `node_modules` is
    // one candidate rather than a hundred thousand.
    const reported = await listIgnoredDirectories(input.projectRoot, patterns)
    const directories = reported.filter((path) => !excludedInside(path, patterns.excludes))
    const reportedNames = new Set(reported.map(withoutTrailingSlash))
    const files = [
      ...new Set([
        ...(await listFiles(input.projectRoot, patterns, directories)),
        ...patterns.literals
      ])
    ].filter(
      (path) => !reportedNames.has(path) && !directories.some((carried) => path.startsWith(carried))
    )
    candidates = [...directories, ...files]
  } catch {
    return buildWorktreeBootstrapResult(
      [],
      [...skipped, { path: '.worktreeinclude', reason: 'copy-failed' }],
      { provenance, durationMs: elapsed() }
    )
  }

  const copied: string[] = []
  const projectReal = await realpath(input.projectRoot)
  const checkoutReal = await realpath(input.checkoutRoot)
  for (const path of candidates) {
    const reason = await carryCandidate({ ...input, path, projectReal, checkoutReal })
    if (reason) skipped.push({ path, reason })
    else copied.push(path)
  }
  copied.sort(comparePaths)
  skipped.sort((left, right) => comparePaths(left.path, right.path))
  return buildWorktreeBootstrapResult(copied, skipped, { provenance, durationMs: elapsed() })
}

/**
 * The Project as it stood when the bootstrap began: HEAD, the branch HEAD was
 * on, and the moment. A Project Git cannot answer for reports no origin at
 * all, which reads as unknown — never as a Checkout nothing was carried into.
 */
async function observeProvenance(
  projectRoot: string,
  now: () => Date
): Promise<WorktreeBootstrapProvenance | null> {
  let commit: string
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      env: gitEnvironment(),
      timeout: TIMEOUT_MS
    })
    commit = stdout.trim()
  } catch {
    return null
  }
  if (!/^[0-9a-f]{7,64}$/.test(commit)) return null
  // A detached Project has a commit and no branch, and saying so is the whole
  // point: `--abbrev-ref` would answer the literal string `HEAD` instead.
  const branch = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: projectRoot,
    env: gitEnvironment(),
    timeout: TIMEOUT_MS
  })
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null)
  return { commit, branch, at: now().toISOString() }
}

/** A retry asks Git about exactly the paths that failed, nothing wider. */
function retryPatterns(paths: string[]): PatternSet {
  const names = paths.map(withoutTrailingSlash)
  return {
    pathspecs: names.map((path) => `:(top,literal)${path}`),
    carriesEveryIgnoredDirectory: false,
    excludes: [],
    invalid: [],
    literals: names
  }
}

async function readPatterns(projectRoot: string): Promise<PatternSet> {
  let contents: string | null = null
  try {
    contents = await readFile(join(projectRoot, '.worktreeinclude'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // Without a manifest the ignored files stay `.env*` and the directories are
  // whatever Git reports — a list Argos keeps rather than one it curates.
  if (contents === null) {
    return {
      pathspecs: [':(top,glob).env*'],
      carriesEveryIgnoredDirectory: true,
      excludes: [],
      invalid: [],
      literals: []
    }
  }
  const pathspecs: string[] = []
  const excludes: string[] = []
  const invalid: string[] = []
  const literals: string[] = []
  let positivePatterns = 0
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const excluded = line.startsWith('!')
    const pattern = excluded ? line.slice(1) : line
    if (!validPattern(pattern)) {
      invalid.push(line)
      continue
    }
    const normalized = pattern.startsWith('/') ? pattern.slice(1) : pattern
    pathspecs.push(`:(${excluded ? 'exclude,' : ''}top,glob)${normalized}`)
    if (excluded) {
      excludes.push(normalized)
      continue
    }
    positivePatterns++
    if (!/[?*[\\]/.test(normalized)) literals.push(normalized)
  }
  if (positivePatterns === 0) pathspecs.length = 0
  return { pathspecs, carriesEveryIgnoredDirectory: false, excludes, invalid, literals }
}

function validPattern(pattern: string): boolean {
  if (pattern === '' || isAbsolute(pattern) || pattern.includes('\0')) return false
  return !pattern.split('/').some((part) => part === '..')
}

/**
 * The directories Git itself calls ignored, each collapsed to its highest
 * level — `node_modules/`, `.venv/`, a workspace package's own `node_modules/`.
 * Git collapses a directory only when the whole of it is ignored, so nothing
 * tracked or merely untracked can ride along inside one.
 */
async function listIgnoredDirectories(
  projectRoot: string,
  patterns: PatternSet
): Promise<string[]> {
  if (!patterns.carriesEveryIgnoredDirectory && patterns.pathspecs.length === 0) return []
  const listed = await listPaths(projectRoot, [
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '--no-empty-directory',
    ...(patterns.carriesEveryIgnoredDirectory ? [] : ['--', ...patterns.pathspecs])
  ])
  return listed.filter((entry) => entry.endsWith('/'))
}

/**
 * Whether a `!` pattern names a place inside this directory. Such a directory
 * is never carried whole: a clone would quietly re-admit exactly what the
 * exclusion refused, so its ignored files are carried one by one instead.
 *
 * Only the part of a pattern before its first wildcard is read, so an
 * exclusion that names no directory in particular — one starting `*.` or a
 * doubled star — keeps applying to files without costing every Project its
 * clone.
 */
function excludedInside(directory: string, excludes: string[]): boolean {
  return excludes.some((pattern) => {
    const anchor = literalPrefix(pattern)
    return anchor !== '' && (anchor.startsWith(directory) || directory.startsWith(`${anchor}/`))
  })
}

/** The pattern's leading segments, up to the first one holding a wildcard. */
function literalPrefix(pattern: string): string {
  const segments = pattern.split('/')
  const wildcard = segments.findIndex((segment) => /[?*[]/.test(segment))
  return (wildcard === -1 ? segments : segments.slice(0, wildcard)).join('/')
}

async function listFiles(
  projectRoot: string,
  patterns: PatternSet,
  directories: string[]
): Promise<string[]> {
  if (patterns.pathspecs.length === 0) return []
  // A carried directory is excluded from this listing so its interior is never
  // enumerated: the clone brings all of it, and nothing else has to look.
  const carried = directories.map((path) => `:(exclude,top,literal)${withoutTrailingSlash(path)}`)
  return listPaths(projectRoot, ['--cached', '--others', '--', ...patterns.pathspecs, ...carried])
}

/** One NUL-delimited `ls-files` reading, asked the same way every time. */
async function listPaths(projectRoot: string, args: string[]): Promise<string[]> {
  const { stdout } = await run('git', ['ls-files', '-z', ...args], {
    cwd: projectRoot,
    env: gitEnvironment(),
    timeout: TIMEOUT_MS,
    maxBuffer: LISTING_MAX_BYTES
  })
  return stdout.split('\0').filter(Boolean)
}

async function carryCandidate(
  input: BootstrapInput & {
    path: string
    projectReal: string
    checkoutReal: string
  }
): Promise<WorktreeBootstrapSkipReason | null> {
  const directory = input.path.endsWith('/')
  const name = withoutTrailingSlash(input.path)
  if (!validRelativePath(name)) return 'invalid-path'
  if (await isTracked(input.projectRoot, name)) return 'tracked'
  // A collapsed directory is already Git's ignored answer, and `check-ignore`
  // answers a narrower question about one: a directory emptied of meaning by
  // a `dir/**` rule is not itself a match, though everything in it is.
  if (!directory && !(await isIgnored(input.projectRoot, name))) return 'not-ignored'

  const source = join(input.projectReal, name)
  const destination = join(input.checkoutReal, name)
  let sourceStat
  try {
    sourceStat = await lstat(source)
  } catch (error) {
    return errorReason(error, 'missing')
  }
  if (sourceStat.isSymbolicLink()) return 'symlink'
  if (directory ? !sourceStat.isDirectory() : !sourceStat.isFile()) return 'not-regular'
  const sourceReal = await realpath(source).catch(() => null)
  if (!sourceReal || !containedBy(input.projectReal, sourceReal)) return 'invalid-path'

  const parent = join(input.checkoutReal, ...name.split('/').slice(0, -1))
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const parentReal = await realpath(parent)
    if (!containedBy(input.checkoutReal, parentReal)) return 'invalid-path'
  } catch (error) {
    return errorReason(error, 'copy-failed')
  }
  return directory ? cloneDirectory(source, destination) : copyFile(source, destination)
}

async function copyFile(
  source: string,
  destination: string
): Promise<WorktreeBootstrapSkipReason | null> {
  let destinationCreated = false
  try {
    const sourceFile = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
    let destinationFile
    try {
      const latest = await sourceFile.stat()
      if (!latest.isFile()) return 'not-regular'
      destinationFile = await open(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        latest.mode & 0o777
      )
      destinationCreated = true
      await copyFileContents(sourceFile, destinationFile, latest.size)
    } finally {
      await Promise.allSettled([sourceFile.close(), destinationFile?.close()])
    }
    return null
  } catch (error) {
    if (destinationCreated) await unlink(destination).catch(() => undefined)
    return errorReason(error, 'copy-failed')
  }
}

/**
 * Carries a directory by copy-on-write clone, so a Checkout costs nothing to
 * create and diverges into real disk only as something writes to it. The
 * symlinks inside are recreated rather than followed: a pnpm `node_modules`
 * is a farm of links into a store outside the Project, and one that lost them
 * would look present and not work.
 */
async function cloneDirectory(
  source: string,
  destination: string
): Promise<WorktreeBootstrapSkipReason | null> {
  try {
    await lstat(destination)
    return 'destination-exists'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return errorReason(error, 'copy-failed')
  }
  if (!(await sameFilesystem(source, dirname(destination)))) return 'clone-unsupported'
  try {
    await run(SYSTEM_COPY, cloneArguments(source, destination), { timeout: CLONE_TIMEOUT_MS })
    return null
  } catch (error) {
    // Half a dependency tree is worse than none: it would read as installed.
    await rm(destination, { recursive: true, force: true }).catch(() => undefined)
    return cloneErrorReason(error)
  }
}

/**
 * Cloning across filesystems is impossible everywhere, and on macOS this is
 * also what rules out the silent fallback: `cp -c` byte-copies rather than
 * failing when a filesystem cannot clone, and every volume a supported macOS
 * boots from is APFS, which can. GNU `cp --reflink=always` refuses aloud.
 */
async function sameFilesystem(source: string, destination: string): Promise<boolean> {
  try {
    const [from, to] = await Promise.all([stat(source), stat(destination)])
    return from.dev === to.dev
  } catch {
    return false
  }
}

/**
 * Ownership is deliberately not preserved: a clone already carries mode,
 * timestamps and extended attributes, while asking for the owner as well
 * would fail the whole tree over one root-owned build artifact.
 */
function cloneArguments(source: string, destination: string): string[] {
  return process.platform === 'darwin'
    ? ['-Rc', '--', source, destination]
    : ['-r', '-d', '--preserve=mode,timestamps', '--reflink=always', '--', source, destination]
}

/**
 * Named by its absolute path rather than looked up: GNU `cp` reads `-c` as
 * `--preserve=context`, so a `cp` found first on `PATH` — Homebrew's coreutils
 * put one there — would answer the request to clone with a full byte copy and
 * call it done. Only the system copy means what this asks it.
 */
const SYSTEM_COPY = '/bin/cp'

function cloneErrorReason(error: unknown): WorktreeBootstrapSkipReason {
  const failure = error as { stderr?: string; message?: string } | null
  const said = `${failure?.stderr ?? ''} ${failure?.message ?? ''}`
  if (/not supported|cross-device/i.test(said)) return 'clone-unsupported'
  if (/permission denied/i.test(said)) return 'permission-denied'
  return 'copy-failed'
}

function withoutTrailingSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path
}

async function copyFileContents(
  source: Awaited<ReturnType<typeof open>>,
  destination: Awaited<ReturnType<typeof open>>,
  size: number
): Promise<void> {
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let readPosition = 0
  while (readPosition < size) {
    const { bytesRead } = await source.read(
      buffer,
      0,
      Math.min(buffer.length, size - readPosition),
      readPosition
    )
    if (bytesRead === 0) throw new Error('Source changed while being copied')
    let written = 0
    while (written < bytesRead) {
      const result = await destination.write(buffer, written, bytesRead - written)
      written += result.bytesWritten
    }
    readPosition += bytesRead
  }
}

function validRelativePath(path: string): boolean {
  return (
    path !== '' &&
    !isAbsolute(path) &&
    !path.includes('\0') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
}

async function isTracked(projectRoot: string, path: string): Promise<boolean> {
  const { stdout } = await run('git', ['ls-files', '--cached', '-z', '--', path], {
    cwd: projectRoot,
    env: gitEnvironment(),
    timeout: TIMEOUT_MS
  })
  return stdout.length > 0
}

async function isIgnored(projectRoot: string, path: string): Promise<boolean> {
  try {
    await run('git', ['check-ignore', '--quiet', '--no-index', '--', path], {
      cwd: projectRoot,
      env: gitEnvironment(),
      timeout: TIMEOUT_MS
    })
    return true
  } catch {
    return false
  }
}

/** A caller's repository pointers must never override the Project named by cwd. */
function gitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !REDIRECTING_GIT_ENV.has(name))
  )
}

function containedBy(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

function errorReason(
  error: unknown,
  fallback: WorktreeBootstrapSkipReason
): WorktreeBootstrapSkipReason {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT') return 'missing'
  if (code === 'EACCES' || code === 'EPERM') return 'permission-denied'
  if (code === 'EEXIST') return 'destination-exists'
  if (code === 'ELOOP') return 'symlink'
  return fallback
}

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right, 'en')
}
