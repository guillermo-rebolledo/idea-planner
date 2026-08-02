import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChangeKind } from '@shared/conversation'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Long enough for a cold `git` on a slow disk; short enough to never hang the app. */
const TIMEOUT_MS = 10_000

export type ProjectRootResolution =
  | { status: 'resolved'; root: string }
  | { status: 'not-a-repository' }
  | { status: 'git-unavailable' }

export type RepositoryInit = { status: 'initialized' } | { status: 'git-unavailable' }

interface GitOptions {
  /** Overrides `PATH` for the probe. An empty string is a machine with no git. */
  pathEnv?: string
}

/**
 * Asks git where the repository containing `path` begins.
 *
 * The answer is the Project's identity (ADR 0005), so it is git's answer and
 * not the path the user picked: selecting any directory inside a repository
 * resolves to the same root, and worktrees and submodules — where `.git` is a
 * file rather than a directory — resolve correctly without us reimplementing
 * discovery.
 */
export async function resolveProjectRoot(
  path: string,
  options: GitOptions = {}
): Promise<ProjectRootResolution> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], {
      cwd: path,
      env: environment(options),
      timeout: TIMEOUT_MS
    })
    const root = stdout.trim()
    return root ? { status: 'resolved', root } : { status: 'not-a-repository' }
  } catch {
    return (await isGitMissing(options))
      ? { status: 'git-unavailable' }
      : { status: 'not-a-repository' }
  }
}

/**
 * Turns a folder into a repository. This is the only Git mutation the app
 * performs, and it happens only after the user asks for it.
 */
export async function initRepository(
  path: string,
  options: GitOptions = {}
): Promise<RepositoryInit> {
  try {
    await run('git', ['init', '--quiet'], {
      cwd: path,
      env: environment(options),
      timeout: TIMEOUT_MS
    })
    return { status: 'initialized' }
  } catch (error) {
    if (await isGitMissing(options)) return { status: 'git-unavailable' }
    throw error
  }
}

/**
 * A snapshot of a Checkout: the tree git would write if everything in the
 * working directory were staged. `unavailable` is not a failure — a Checkout
 * that is not a repository, or a machine with no git, simply has no snapshot,
 * and a Run must not fail over it.
 */
export type CheckoutSnapshot = { status: 'taken'; tree: string } | { status: 'unavailable' }

/** One file that changed between two snapshots, and how. */
export interface SnapshotChange {
  /** Relative to the Checkout, as git names it. */
  path: string
  /** Git says which of the three it was, so nothing here has to guess. */
  changeKind: ChangeKind
  /** The unified diff between the two snapshots, as git rendered it. */
  diff: string
}

/**
 * How many files changed, when more of them changed than are listed. Zero
 * means the list is everything: a cap nobody is told about turns a partial
 * answer into a wrong one.
 */
export interface SnapshotComparison {
  changes: SnapshotChange[]
  unlisted: number
}

/**
 * Records what is in the Checkout right now, so that what a Run changes can be
 * told from what was already there — however the change was made. The Harness
 * reports what it edits with its own tools, and a shell command it runs
 * reports nothing at all (ticket 12c).
 *
 * This never touches the person's repository. Their index and their object
 * store are left exactly as they were: git is pointed at an app-owned index
 * and an app-owned object directory, with the repository added only as a
 * read-only alternate, so every blob and tree this writes lands in app-owned
 * state. Their `.gitignore` still applies, so build output stays out.
 */
export async function snapshotCheckout(
  checkout: string,
  appOwnedDirectory: string,
  options: GitOptions = {}
): Promise<CheckoutSnapshot> {
  try {
    const env = await snapshotEnvironment(checkout, appOwnedDirectory, options)
    await mkdir(join(appOwnedDirectory, OBJECTS), { recursive: true })
    // Staged into our index, never theirs. `-A` is what makes a file the agent
    // created count, and what makes one it deleted count as gone.
    await run('git', ['add', '-A'], { cwd: checkout, env, timeout: TIMEOUT_MS })
    const { stdout } = await run('git', ['write-tree'], {
      cwd: checkout,
      env,
      timeout: TIMEOUT_MS
    })
    const tree = stdout.trim()
    return tree ? { status: 'taken', tree } : { status: 'unavailable' }
  } catch {
    return { status: 'unavailable' }
  }
}

/**
 * What changed between two snapshots of one Checkout. Either snapshot being
 * unavailable means the question cannot be answered, which is reported as
 * nothing having been observed rather than as nothing having happened.
 */
export async function diffSnapshots(
  checkout: string,
  appOwnedDirectory: string,
  before: CheckoutSnapshot,
  after: CheckoutSnapshot,
  options: GitOptions = {}
): Promise<SnapshotComparison> {
  const nothing: SnapshotComparison = { changes: [], unlisted: 0 }
  if (before.status !== 'taken' || after.status !== 'taken') return nothing
  if (before.tree === after.tree) return nothing
  const env = await snapshotEnvironment(checkout, appOwnedDirectory, options)
  const trees = [before.tree, after.tree]
  let named: SnapshotChange[]
  try {
    // The paths and what happened to each, asked for separately and
    // NUL-separated. They cannot be read out of the patch itself: git quotes a
    // path with a quote or a control character in it, and
    // `diff --git a/a b/ar.txt b/a b/ar.txt` is what a path containing " b/"
    // looks like — both were verified against git.
    const { stdout } = await run('git', ['diff-tree', '-r', '--name-status', '-z', ...trees], {
      cwd: checkout,
      env,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_DIFF_BYTES
    })
    named = readNameStatus(stdout)
  } catch {
    return nothing
  }
  if (named.length === 0) return nothing
  const listed = named.slice(0, MAX_CHANGED_FILES)
  // The patch bodies, in the order git already named them. A diff too large
  // to read back leaves every file listed with no body: what changed still
  // beats nothing at all.
  const patches = await patchBodies(checkout, env, trees, named.length)
  return {
    changes: listed.map((change, index) => ({ ...change, diff: patches[index] ?? '' })),
    unlisted: named.length - listed.length
  }
}

/**
 * `--name-status -z` output: a status field and a path, each NUL-terminated.
 * Anything git reports that is not plainly an add or a delete is a change to
 * the file that is there — including a rename, which without rename detection
 * arrives as a delete and an add anyway.
 */
function readNameStatus(stdout: string): SnapshotChange[] {
  const fields = stdout.split('\0')
  const changes: SnapshotChange[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index]?.trim()
    const path = fields[index + 1]
    if (!status || !path) continue
    changes.push({
      path,
      changeKind: status.startsWith('A') ? 'added' : status.startsWith('D') ? 'deleted' : 'changed',
      diff: ''
    })
  }
  return changes
}

/**
 * One patch per changed file, positionally. `diff-tree` walks the trees once,
 * so the patch sections arrive in the same order as the names; anything else
 * means this read the output wrong, and a body attached to the wrong file is
 * worse than no body.
 */
async function patchBodies(
  checkout: string,
  env: NodeJS.ProcessEnv,
  trees: string[],
  expected: number
): Promise<string[]> {
  try {
    const { stdout } = await run(
      'git',
      ['diff-tree', '-r', '-p', '--no-color', '--no-ext-diff', ...trees],
      { cwd: checkout, env, timeout: TIMEOUT_MS, maxBuffer: MAX_DIFF_BYTES }
    )
    const sections = stdout
      .split(/^diff --git /m)
      .slice(1)
      .map((section) => `diff --git ${section}`.trimEnd())
    return sections.length === expected ? sections : []
  } catch {
    return []
  }
}

async function snapshotEnvironment(
  checkout: string,
  appOwnedDirectory: string,
  options: GitOptions
): Promise<NodeJS.ProcessEnv> {
  return {
    ...environment(options),
    GIT_INDEX_FILE: join(appOwnedDirectory, 'index'),
    GIT_OBJECT_DIRECTORY: join(appOwnedDirectory, OBJECTS),
    // Read-only access to what the repository already has, so this rehashes
    // nothing it can borrow. Asked for rather than assumed: in a linked
    // worktree or a submodule `.git` is a file and the objects are elsewhere.
    GIT_ALTERNATE_OBJECT_DIRECTORIES: await objectDirectory(checkout, options)
  }
}

async function objectDirectory(checkout: string, options: GitOptions): Promise<string> {
  const { stdout } = await run(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-path', 'objects'],
    { cwd: checkout, env: environment(options), timeout: TIMEOUT_MS }
  )
  return stdout.trim()
}

/** Where the objects this writes go, which is never the person's repository. */
const OBJECTS = 'objects'

/** A diff larger than this is not one anybody was going to read. */
const MAX_DIFF_BYTES = 8 * 1024 * 1024

/**
 * How many files one Run is reported to have changed. A codemod can touch
 * thousands; what the person needs to know is that it happened, and a list
 * beyond this is not one anybody reads either.
 */
const MAX_CHANGED_FILES = 500

/**
 * The environment a git call runs in. Anything the process inherited that
 * would point git at a different repository is dropped: a shell — or a git
 * hook, which exports `GIT_DIR` and `GIT_INDEX_FILE` — can hand this app an
 * environment in which `cwd` no longer decides which repository it is talking
 * to, and every call here means the one the person's Project is in.
 */
function environment(options: GitOptions): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !REDIRECTING.has(name))
  )
  return options.pathEnv === undefined ? inherited : { ...inherited, PATH: options.pathEnv }
}

/** Inherited variables that would answer for a repository nobody asked about. */
const REDIRECTING = new Set([
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE'
])

/**
 * Distinguishes "this machine has no git" from "this folder is not a
 * repository". ADR 0005 keeps those apart deliberately: reporting the first as
 * the second sends the person to fix the wrong thing.
 *
 * The failing call cannot tell us: spawning into a directory that has gone
 * fails with ENOENT exactly as a missing binary does. So we ask git about
 * itself, from a directory that certainly exists, and let that answer decide.
 */
async function isGitMissing(options: GitOptions): Promise<boolean> {
  try {
    await run('git', ['--version'], { env: environment(options), timeout: TIMEOUT_MS })
    return false
  } catch {
    return true
  }
}
