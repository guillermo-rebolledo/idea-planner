import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ChangeKind } from '@shared/conversation'
import type {
  CheckoutState,
  CheckoutStateObservation,
  WorktreeBootstrapResult
} from '@shared/checkout'
import type { UndoPath, UndoPathClassification } from '@shared/run-undo'
import { promisify } from 'node:util'
import { bootstrapWorktree } from './worktree-bootstrap'

const run = promisify(execFile)

/** Long enough for a cold `git` on a slow disk; short enough to never hang the app. */
const TIMEOUT_MS = 10_000

export type ProjectRootResolution =
  | { status: 'resolved'; root: string }
  | { status: 'not-a-repository' }
  | { status: 'git-unavailable' }

export type RepositoryInit =
  | { status: 'initialized' }
  | { status: 'git-unavailable' }
  | { status: 'blocked'; state: CheckoutState }

interface GitOptions {
  /** Overrides `PATH` for the probe. An empty string is a machine with no git. */
  pathEnv?: string
}

/**
 * Observes the Checkout through Git's own paths. In particular, `.git` is not
 * assumed to be a directory: linked worktrees and submodules make it a file.
 */
export async function observeCheckoutState(
  checkout: string,
  options: GitOptions = {}
): Promise<CheckoutStateObservation> {
  const resolution = await resolveProjectRoot(checkout, options)
  if (resolution.status !== 'resolved') return resolution

  try {
    const [claimed, repository] = await Promise.all([realpath(checkout), realpath(resolution.root)])
    const fromRepository = relative(repository, claimed)
    if (
      fromRepository !== '' &&
      fromRepository !== '..' &&
      !fromRepository.startsWith(`..${sep}`)
    ) {
      return { status: 'observed', state: 'unsafe-root' }
    }

    const [rebaseMerge, rebaseApply, cherryPick, revert, merge, squash, unresolved] =
      await Promise.all([
        markerExists(checkout, 'rebase-merge', options),
        markerExists(checkout, 'rebase-apply', options),
        markerExists(checkout, 'CHERRY_PICK_HEAD', options),
        markerExists(checkout, 'REVERT_HEAD', options),
        markerExists(checkout, 'MERGE_HEAD', options),
        markerExists(checkout, 'SQUASH_MSG', options),
        hasUnresolvedEntries(checkout, options)
      ])

    let state: CheckoutState = 'clean'
    if (rebaseMerge || rebaseApply) state = 'rebase'
    else if (cherryPick) state = 'cherry-pick'
    else if (revert) state = 'revert'
    else if (squash && unresolved) state = 'squash-merge'
    else if (merge) state = 'merge'
    else if (unresolved) state = 'unresolved-index'
    return { status: 'observed', state }
  } catch {
    return (await isGitMissing(options))
      ? { status: 'git-unavailable' }
      : { status: 'not-a-repository' }
  }
}

async function markerExists(
  checkout: string,
  marker: string,
  options: GitOptions
): Promise<boolean> {
  const { stdout } = await run(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-path', marker],
    {
      cwd: checkout,
      env: environment(options),
      timeout: TIMEOUT_MS
    }
  )
  const path = stdout.trim()
  return access(isAbsolute(path) ? path : resolve(checkout, path)).then(
    () => true,
    () => false
  )
}

/** `-z` keeps every possible filename opaque; only the presence of a record matters. */
async function hasUnresolvedEntries(checkout: string, options: GitOptions): Promise<boolean> {
  const { stdout } = await run('git', ['ls-files', '--unmerged', '-z'], {
    cwd: checkout,
    env: environment(options),
    timeout: TIMEOUT_MS
  })
  return stdout.length > 0
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
  const observation = await observeCheckoutState(path, options)
  if (observation.status === 'git-unavailable') return observation
  if (observation.status === 'observed' && observation.state === 'unsafe-root') {
    return { status: 'blocked', state: observation.state }
  }
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
 * The branch a Checkout is on right now, or null when there is no branch to
 * name: a detached HEAD, a folder that is not a repository, or a machine with
 * no git. Null is an honest answer for all three — the title bar says less
 * rather than guessing.
 *
 * `symbolic-ref` rather than `rev-parse --abbrev-ref`: a repository before
 * its first commit is still on a branch, and only the former says which.
 */
export async function currentBranch(
  checkout: string,
  options: GitOptions = {}
): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['symbolic-ref', '--short', '--quiet', 'HEAD'], {
      cwd: checkout,
      env: environment(options),
      timeout: TIMEOUT_MS
    })
    const branch = stdout.trim()
    return branch === '' ? null : branch
  } catch {
    return null
  }
}

/**
 * The Project's local branches, most recently committed first, for choosing
 * an isolated checkout's base. Observed on each ask, never stored — a branch
 * can be made or deleted in any terminal at any time.
 */
export async function listBranches(
  projectRoot: string,
  options: GitOptions = {}
): Promise<{ branches: string[]; current: string | null }> {
  try {
    const { stdout } = await run(
      'git',
      [
        'for-each-ref',
        'refs/heads',
        '--sort=-committerdate',
        '--count=200',
        '--format=%(refname:short)'
      ],
      { cwd: projectRoot, env: environment(options), timeout: TIMEOUT_MS }
    )
    const branches = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    return { branches, current: await currentBranch(projectRoot, options) }
  } catch {
    return { branches: [], current: null }
  }
}

export type WorktreeCreation =
  | {
      status: 'created'
      path: string
      branch: string
      bootstrap: WorktreeBootstrapResult
    }
  | { status: 'blocked'; state: CheckoutState }
  | { status: 'git-unavailable' }
  | { status: 'not-a-repository' }
  | { status: 'failed'; message: string }

/**
 * Creates a Session's isolated checkout: a linked worktree on a new branch
 * cut from the chosen base, in the app's own directory rather than inside the
 * Project (ADR 0002 — the person's repository is never written into beyond
 * git's own worktree bookkeeping). A taken branch name gets a numbered
 * sibling rather than a refusal: the name was derived, not chosen.
 */
export async function createWorktree(
  input: {
    projectRoot: string
    /** The app-owned directory all isolated checkouts live under. */
    worktreesDirectory: string
    branch: string
    baseBranch: string
  },
  options: GitOptions = {}
): Promise<WorktreeCreation> {
  const observation = await observeCheckoutState(input.projectRoot, options)
  if (observation.status !== 'observed') return observation
  if (observation.state === 'unsafe-root') return { status: 'blocked', state: observation.state }
  await mkdir(input.worktreesDirectory, { recursive: true })
  let failure = 'The worktree could not be created'
  for (let attempt = 0; attempt < 20; attempt++) {
    const branch = attempt === 0 ? input.branch : `${input.branch}-${String(attempt + 1)}`
    const path = join(input.worktreesDirectory, branch)
    const latest = await observeCheckoutState(input.projectRoot, options)
    if (latest.status !== 'observed') return latest
    if (latest.state === 'unsafe-root') return { status: 'blocked', state: latest.state }
    try {
      await run('git', ['worktree', 'add', '--quiet', '-b', branch, path, input.baseBranch], {
        cwd: input.projectRoot,
        env: environment(options),
        timeout: TIMEOUT_MS
      })
      const bootstrap = await bootstrapWorktree({
        projectRoot: input.projectRoot,
        checkoutRoot: path
      }).catch((): WorktreeBootstrapResult => ({
        outcome: 'skipped',
        copied: [],
        skipped: [{ path: '.worktreeinclude', reason: 'copy-failed' }]
      }))
      return { status: 'created', path, branch, bootstrap }
    } catch (error) {
      failure = error instanceof Error ? error.message : failure
      // Only a taken name is worth retrying under a different one; a missing
      // base or a broken repository fails the same way every time.
      if (!/already exists|already checked out/i.test(failure)) break
    }
  }
  return { status: 'failed', message: failure.slice(0, 500) }
}

/**
 * A snapshot of a Checkout: the tree git would write if everything in the
 * working directory were staged. A skipped snapshot names why it was skipped:
 * a missing Git, a non-repository, or a Checkout State that makes reading a
 * stable tree unsafe. A Run must not fail over any of them.
 */
export type CheckoutSnapshot =
  | { status: 'taken'; tree: string }
  | { status: 'skipped'; reason: 'git-unavailable' | 'not-a-repository' }
  | { status: 'skipped'; reason: 'checkout-state'; state: CheckoutState }

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
  const observation = await observeCheckoutState(checkout, options)
  if (observation.status !== 'observed') {
    return { status: 'skipped', reason: observation.status }
  }
  if (observation.state === 'unsafe-root') {
    return { status: 'skipped', reason: 'checkout-state', state: observation.state }
  }
  let scratch: string | undefined
  try {
    await mkdir(join(appOwnedDirectory, OBJECTS), { recursive: true })
    await mkdir(join(appOwnedDirectory, SCRATCH), { recursive: true })
    // A fresh index per capture, never a file two captures share. Snapshots of
    // one Session are now retained for its whole life (ADR 0006), so a
    // long-lived index would be state two Runs could disagree about — and one
    // left behind by a crash would seed the next capture with stale entries.
    scratch = await mkdtemp(join(appOwnedDirectory, SCRATCH, 'index-'))
    const env = {
      ...(await readEnvironment(checkout, appOwnedDirectory, options)),
      GIT_INDEX_FILE: join(scratch, 'index')
    }
    const latest = await observeCheckoutState(checkout, options)
    if (latest.status !== 'observed') {
      return { status: 'skipped', reason: latest.status }
    }
    if (latest.state === 'unsafe-root') {
      return { status: 'skipped', reason: 'checkout-state', state: latest.state }
    }
    // Staged into our index, never theirs. `-A` is what makes a file the agent
    // created count, and what makes one it deleted count as gone.
    await run('git', ['add', '-A'], { cwd: checkout, env, timeout: TIMEOUT_MS })
    const { stdout } = await run('git', ['write-tree'], {
      cwd: checkout,
      env,
      timeout: TIMEOUT_MS
    })
    const tree = stdout.trim()
    return tree ? { status: 'taken', tree } : { status: 'skipped', reason: 'not-a-repository' }
  } catch {
    return (await isGitMissing(options))
      ? { status: 'skipped', reason: 'git-unavailable' }
      : { status: 'skipped', reason: 'not-a-repository' }
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * What undoing a Run would mean right now: every path it changed, measured
 * against what the Checkout holds at this moment, and the patch that would put
 * the safe ones back.
 *
 * Nothing here writes. The plan is something to read and confirm, and the
 * digest it carries is what makes confirming it safe — the tree is measured
 * again immediately before anything is applied, and a plan computed against a
 * different tree is refused rather than adapted.
 */
export interface RestorationPlan {
  paths: UndoPath[]
  /**
   * The inverse patch, from what the Run left back to what was there before,
   * restricted to the safe paths. Binary-capable, so a changed image is put
   * back rather than reported as unrepresentable.
   */
  patch: string
  /** The tree this was computed against, which is what staleness is measured by. */
  treeDigest: string
}

export type RestorationPlanning =
  | { status: 'planned'; plan: RestorationPlan }
  | { status: 'skipped'; reason: 'git-unavailable' | 'not-a-repository' }
  | { status: 'skipped'; reason: 'checkout-state'; state: CheckoutState }

/**
 * Classifies every path a Run changed and builds the inverse patch for the
 * ones still exactly as it left them.
 *
 * Three answers per path, and the difference between them is the whole point:
 * a path that still matches the Run's own output can be put back mechanically;
 * one that already matches its pre-Run content has nothing to put back; and
 * anything else has been touched since — by the person, their editor, or a
 * later Run — and is never written to.
 */
export async function planRestoration(
  input: {
    checkout: string
    /** The app-owned store holding both trees, and where scratch files go. */
    store: string
    /** The Checkout as it was before the Run. */
    before: string
    /** The Checkout as the Run left it. */
    after: string
  },
  options: GitOptions = {}
): Promise<RestorationPlanning> {
  const current = await snapshotCheckout(input.checkout, input.store, options)
  if (current.status !== 'taken') return current
  try {
    const env = await readEnvironment(input.checkout, input.store, options)
    const affected = await namedChanges(input.checkout, env, [input.before, input.after])
    if (affected.length === 0) {
      return {
        status: 'planned',
        plan: { paths: [], patch: '', treeDigest: current.tree }
      }
    }
    // Two comparisons rather than a blob read per path: git already walks both
    // trees in one pass, and a path absent from a comparison is a path the two
    // trees agree about.
    const [fromAfter, fromBefore] = await Promise.all([
      namedChanges(input.checkout, env, [input.after, current.tree]),
      namedChanges(input.checkout, env, [input.before, current.tree])
    ])
    const movedSinceRun = new Set(fromAfter.map((change) => change.path))
    const movedSinceBaseline = new Set(fromBefore.map((change) => change.path))
    const paths: UndoPath[] = affected.map((change) => ({
      path: change.path,
      changeKind: change.changeKind,
      classification: classify(movedSinceRun.has(change.path), movedSinceBaseline.has(change.path))
    }))
    const safe = paths.filter((path) => path.classification === 'safe').map((path) => path.path)
    const patch = safe.length === 0 ? '' : await inversePatch(input, env, safe)
    return { status: 'planned', plan: { paths, patch, treeDigest: current.tree } }
  } catch {
    return (await isGitMissing(options))
      ? { status: 'skipped', reason: 'git-unavailable' }
      : { status: 'skipped', reason: 'not-a-repository' }
  }
}

function classify(movedSinceRun: boolean, movedSinceBaseline: boolean): UndoPathClassification {
  if (!movedSinceRun) return 'safe'
  return movedSinceBaseline ? 'diverged' : 'already-restored'
}

/**
 * The patch that turns what the Run left back into what was there before it.
 * The trees are named in that order — after, then before — because that is
 * literally the direction of travel; nothing is reversed after the fact.
 */
async function inversePatch(
  input: { checkout: string; before: string; after: string },
  env: NodeJS.ProcessEnv,
  paths: string[]
): Promise<string> {
  const { stdout } = await run(
    'git',
    [
      'diff-tree',
      '-r',
      '-p',
      '--binary',
      '--no-color',
      '--no-ext-diff',
      input.after,
      input.before,
      '--',
      ...paths
    ],
    { cwd: input.checkout, env, timeout: TIMEOUT_MS, maxBuffer: MAX_DIFF_BYTES }
  )
  return stdout
}

/**
 * Whether a restoration is still the one that was reviewed. Cheap on purpose:
 * it is asked again in the moment between the person confirming and anything
 * being written, and the only honest answer at that point is a fresh one.
 */
export async function currentTreeDigest(
  checkout: string,
  store: string,
  options: GitOptions = {}
): Promise<string | null> {
  const snapshot = await snapshotCheckout(checkout, store, options)
  return snapshot.status === 'taken' ? snapshot.tree : null
}

export type PatchApplication =
  | { status: 'applied' }
  /** `git apply --check` refused it. Nothing was written. */
  | { status: 'refused' }

/**
 * Applies an inverse patch to the working tree, and only to the working tree.
 *
 * `--check` first, so a patch that would not apply cleanly is refused before
 * a single file is touched: `git apply` is all-or-nothing per invocation, and
 * checking first turns "half the files moved" into "nothing moved".
 *
 * Neither call is given `--index` or `--cached`, so the person's staging area
 * is exactly as they left it afterwards. The patch is handed over as a file
 * rather than on stdin so nothing about it depends on how a shell would quote
 * it.
 */
export async function applyInversePatch(
  input: { checkout: string; store: string; patch: string },
  options: GitOptions = {}
): Promise<PatchApplication> {
  if (input.patch === '') return { status: 'applied' }
  const observation = await observeCheckoutState(input.checkout, options)
  if (observation.status !== 'observed' || observation.state !== 'clean') {
    return { status: 'refused' }
  }
  await mkdir(join(input.store, SCRATCH), { recursive: true })
  const file = join(input.store, SCRATCH, `restore-${randomUUID()}.patch`)
  try {
    await writeFile(file, input.patch, { mode: 0o600 })
    const env = environment(options)
    const args = ['apply', '--binary', '--whitespace=nowarn']
    await run('git', [...args, '--check', file], {
      cwd: input.checkout,
      env,
      timeout: TIMEOUT_MS
    })
    await run('git', [...args, file], { cwd: input.checkout, env, timeout: TIMEOUT_MS })
    return { status: 'applied' }
  } catch {
    return { status: 'refused' }
  } finally {
    await rm(file, { force: true }).catch(() => undefined)
  }
}

/** The paths two trees disagree about, and what happened to each. */
async function namedChanges(
  checkout: string,
  env: NodeJS.ProcessEnv,
  trees: string[]
): Promise<SnapshotChange[]> {
  const { stdout } = await run('git', ['diff-tree', '-r', '--name-status', '-z', ...trees], {
    cwd: checkout,
    env,
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_DIFF_BYTES
  })
  return readNameStatus(stdout)
}

/**
 * What changed between two snapshots of one Checkout. Either snapshot being
 * skipped means the question cannot be answered, which is reported as
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
  const env = await readEnvironment(checkout, appOwnedDirectory, options)
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

/**
 * Where git reads and writes objects for everything the app does with trees:
 * the app's own object directory, with the Project's added only as a
 * **read-only alternate**. Every blob and tree this app creates therefore
 * lands in app-owned state, and the person's repository is only ever read
 * from (ADR 0006).
 *
 * No index. Staging needs one and asks for a fresh one of its own; reading
 * trees needs none, and an index named here would be one more file that could
 * be stale.
 */
async function readEnvironment(
  checkout: string,
  appOwnedDirectory: string,
  options: GitOptions
): Promise<NodeJS.ProcessEnv> {
  return {
    ...environment(options),
    GIT_OBJECT_DIRECTORY: join(appOwnedDirectory, OBJECTS),
    // Asked for rather than assumed: in a linked worktree or a submodule
    // `.git` is a file and the objects are elsewhere.
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

/** Short-lived working files — a capture's index, a patch about to be applied. */
const SCRATCH = 'scratch'

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
