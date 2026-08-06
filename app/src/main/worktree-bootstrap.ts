import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import {
  buildWorktreeBootstrapResult,
  type WorktreeBootstrapResult,
  type WorktreeBootstrapSkipReason
} from '@shared/checkout'
import { promisify } from 'node:util'

const run = promisify(execFile)
const TIMEOUT_MS = 10_000

interface BootstrapInput {
  projectRoot: string
  checkoutRoot: string
  /** Restricts a retry to the paths that failed previously. */
  paths?: string[]
}

interface PatternSet {
  pathspecs: string[]
  invalid: string[]
  literals: string[]
}

/**
 * Copies eligible local configuration into a newly created isolated Checkout.
 * Git owns both candidate matching and ignored-file decisions; filesystem
 * checks then narrow that answer to contained regular files.
 */
export async function bootstrapWorktree(input: BootstrapInput): Promise<WorktreeBootstrapResult> {
  const patterns = input.paths
    ? {
        pathspecs: input.paths.map((path) => `:(top,literal)${path}`),
        invalid: [],
        literals: input.paths
      }
    : await readPatterns(input.projectRoot)
  const skipped: WorktreeBootstrapResult['skipped'] = patterns.invalid.map((path) => ({
    path,
    reason: 'invalid-path'
  }))
  let candidates: string[]
  try {
    candidates = [
      ...new Set([
        ...(await listCandidates(input.projectRoot, patterns.pathspecs)),
        ...patterns.literals
      ])
    ]
  } catch {
    return buildWorktreeBootstrapResult(
      [],
      [...skipped, { path: '.worktreeinclude', reason: 'copy-failed' }]
    )
  }

  const copied: string[] = []
  const projectReal = await realpath(input.projectRoot)
  const checkoutReal = await realpath(input.checkoutRoot)
  for (const path of candidates) {
    const reason = await copyCandidate({ ...input, path, projectReal, checkoutReal })
    if (reason) skipped.push({ path, reason })
    else copied.push(path)
  }
  copied.sort(comparePaths)
  skipped.sort((left, right) => comparePaths(left.path, right.path))
  return buildWorktreeBootstrapResult(copied, skipped)
}

async function readPatterns(projectRoot: string): Promise<PatternSet> {
  let contents: string | null = null
  try {
    contents = await readFile(join(projectRoot, '.worktreeinclude'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const lines = contents === null ? ['.env*'] : contents.split(/\r?\n/)
  const pathspecs: string[] = []
  const invalid: string[] = []
  const literals: string[] = []
  let positivePatterns = 0
  for (const raw of lines) {
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
    if (!excluded) {
      positivePatterns++
      if (!/[?*[\\]/.test(normalized)) literals.push(normalized)
    }
  }
  if (positivePatterns === 0) pathspecs.length = 0
  return { pathspecs, invalid, literals }
}

function validPattern(pattern: string): boolean {
  if (pattern === '' || isAbsolute(pattern) || pattern.includes('\0')) return false
  return !pattern.split('/').some((part) => part === '..')
}

async function listCandidates(projectRoot: string, pathspecs: string[]): Promise<string[]> {
  if (pathspecs.length === 0) return []
  const { stdout } = await run(
    'git',
    ['ls-files', '--cached', '--others', '-z', '--', ...pathspecs],
    { cwd: projectRoot, timeout: TIMEOUT_MS }
  )
  return stdout.split('\0').filter(Boolean)
}

async function copyCandidate(
  input: BootstrapInput & {
    path: string
    projectReal: string
    checkoutReal: string
  }
): Promise<WorktreeBootstrapSkipReason | null> {
  if (!validRelativePath(input.path)) return 'invalid-path'
  if (await isTracked(input.projectRoot, input.path)) return 'tracked'
  if (!(await isIgnored(input.projectRoot, input.path))) return 'not-ignored'

  const source = join(input.projectReal, input.path)
  const destination = join(input.checkoutReal, input.path)
  let sourceStat
  try {
    sourceStat = await lstat(source)
  } catch (error) {
    return errorReason(error, 'missing')
  }
  if (sourceStat.isSymbolicLink()) return 'symlink'
  if (!sourceStat.isFile()) return 'not-regular'
  const sourceReal = await realpath(source).catch(() => null)
  if (!sourceReal || !containedBy(input.projectReal, sourceReal)) return 'invalid-path'

  const parent = join(input.checkoutReal, ...input.path.split('/').slice(0, -1))
  let destinationCreated = false
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const parentReal = await realpath(parent)
    if (!containedBy(input.checkoutReal, parentReal)) return 'invalid-path'
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
    timeout: TIMEOUT_MS
  })
  return stdout.length > 0
}

async function isIgnored(projectRoot: string, path: string): Promise<boolean> {
  try {
    await run('git', ['check-ignore', '--quiet', '--no-index', '--', path], {
      cwd: projectRoot,
      timeout: TIMEOUT_MS
    })
    return true
  } catch {
    return false
  }
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
