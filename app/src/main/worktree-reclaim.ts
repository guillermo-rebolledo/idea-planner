import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { SessionSummary } from '@shared/contract'
import {
  MAX_LISTED_WORKTREES,
  removeWorktreesInputSchema,
  type ReclaimableWorktree,
  type RemoveWorktreesInput,
  type WorktreeDiskUsage,
  type WorktreeInventory,
  type WorktreeRemoval,
  type WorktreeRemovalResult,
  type WorktreeSession
} from '@shared/worktree'
import { currentBranch, observeWorktreeContents, removeWorktree } from './git'

/**
 * Reclaiming the isolated Checkouts Argos made for one Project.
 *
 * Two calls, and the gap between them is the point. Reading the inventory
 * writes nothing and removes nothing; removing acts on exactly the directories
 * the person named after reading it. There is no third call, and nothing calls
 * either of them on the app's own initiative — not on Delete, not on Archive,
 * not on quit, not on a timer.
 */

/**
 * How many entries one directory walk visits before it stops counting. A
 * Worktree carrying a cloned `node_modules` is hundreds of thousands of files,
 * and a figure that took a minute to compute is one nobody waited for. The
 * partial answer says it is partial.
 */
const MAX_WALKED_ENTRIES = 120_000

/** What `st_blocks` counts in, fixed by POSIX regardless of the block size. */
const BLOCK_BYTES = 512

export interface WorktreeReclaimDeps {
  /** The app-owned directory this Project's isolated Checkouts live under. */
  directoryFor: (projectRoot: string) => string
  /** Every Session the app has, archived ones included. */
  sessions: () => Promise<SessionSummary[]>
  /**
   * The Checkout directories Runs this process is still responsible for are
   * working in. Asked on every call: a Run can start while the dialog is open.
   */
  busyCheckouts: () => string[]
}

export class WorktreeReclaimService {
  constructor(private readonly deps: WorktreeReclaimDeps) {}

  /**
   * Every Worktree Argos made for this Project, with what each one belongs to,
   * holds, and costs right now.
   *
   * Enumerated from the app's own worktrees directory rather than from `git
   * worktree list`, because the two disagree in exactly the cases that matter:
   * a directory whose Session was deleted is still there, and so is one git
   * has already pruned the record of. The app made these, so the app's own
   * state directory is the register.
   */
  async inventory(projectRoot: string): Promise<WorktreeInventory> {
    const root = this.deps.directoryFor(projectRoot)
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en'))
    const listed = directories.slice(0, MAX_LISTED_WORKTREES)
    const sessions = await this.sessionsByCheckout()
    const busy = this.busyNow()
    const worktrees = await Promise.all(
      listed.map((name) => this.describe(join(root, name), sessions, busy))
    )
    return { projectRoot, worktrees, unlisted: directories.length - listed.length }
  }

  /**
   * Removes exactly the Worktrees named, and nothing else.
   *
   * Every path is re-derived from the Project's own app-owned directory before
   * anything is touched: the window supplies strings, and a string that names
   * somewhere else is refused rather than interpreted. A Session's own record
   * of where it works is never consulted here — this removes directories, and
   * a Session keeps pointing at the one it was fixed to.
   */
  async remove(rawInput: RemoveWorktreesInput): Promise<WorktreeRemovalResult> {
    const input = removeWorktreesInputSchema.parse(rawInput)
    const root = this.deps.directoryFor(input.projectRoot)
    const removals: WorktreeRemoval[] = []
    for (const path of input.paths) {
      removals.push(await this.removeOne({ path, root, projectRoot: input.projectRoot }))
    }
    return { removals }
  }

  /**
   * One removal, whose failure is its own. Sequential rather than concurrent:
   * every one of these ends in `git worktree` against the same repository, and
   * git takes a lock per repository — running them together would turn a
   * removal that worked into one that reports a lock nobody can act on.
   */
  private async removeOne(input: {
    path: string
    root: string
    projectRoot: string
  }): Promise<WorktreeRemoval> {
    const { path } = input
    if (!isInside(input.root, path)) {
      return {
        path,
        outcome: 'failed',
        detail: 'That is not a Checkout Argos made for this Project.'
      }
    }
    // Asked again for every removal rather than once for the batch. Removing a
    // Worktree takes long enough for a Run to start in the next one, and a set
    // captured before the first `git worktree remove` would answer for a
    // moment that has passed — which is the moment an agent's directory is
    // taken out from under it.
    //
    // This is a check and then an act, so it narrows the window rather than
    // closing it: a Run admitted between this line and git's unlink would find
    // its Checkout gone. Closing it would need Run admission and removal to
    // share a lock, and what is left is bounded by something the design
    // already accepts — a Session whose Worktree the person removed is broken
    // either way, and this is the same failure a second earlier.
    if (this.busyNow().has(resolve(path))) {
      return {
        path,
        outcome: 'failed',
        detail: 'A Run is working in it. Stop the Run, then remove it.'
      }
    }
    const attempt = await removeWorktree({ projectRoot: input.projectRoot, path })
    if (attempt.status === 'removed') return { path, outcome: 'removed', detail: null }
    if (attempt.status === 'already-gone') return { path, outcome: 'already-gone', detail: null }
    return { path, outcome: 'failed', detail: attempt.message }
  }

  /** The Checkouts a Run is working in, as of this instant and no earlier. */
  private busyNow(): ReadonlySet<string> {
    return new Set(this.deps.busyCheckouts().map((path) => resolve(path)))
  }

  /** One Worktree, described from disk, from git, and from the Session store. */
  private async describe(
    path: string,
    sessions: ReadonlyMap<string, SessionSummary>,
    busy: ReadonlySet<string>
  ): Promise<ReclaimableWorktree> {
    const session = sessions.get(resolve(path))
    const [branch, contents, disk] = await Promise.all([
      currentBranch(path),
      observeWorktreeContents(path),
      measureDirectory(path)
    ])
    return {
      path,
      branch,
      session: session ? describeSession(session, busy.has(resolve(path))) : null,
      contents,
      disk
    }
  }

  /**
   * Every Session that names an isolated Checkout, by the directory it names.
   * Keyed by both the stored path and its real path: the store holds the path
   * as it was built, and on macOS the same directory answers to two.
   */
  private async sessionsByCheckout(): Promise<Map<string, SessionSummary>> {
    const sessions = await this.deps.sessions().catch(() => [])
    const byCheckout = new Map<string, SessionSummary>()
    for (const session of sessions) {
      if (session.checkout.kind !== 'worktree') continue
      const path = resolve(session.checkout.path)
      byCheckout.set(path, session)
      const real = await realpath(path).catch(() => null)
      if (real !== null) byCheckout.set(resolve(real), session)
    }
    return byCheckout
  }
}

function describeSession(session: SessionSummary, busy: boolean): WorktreeSession {
  return {
    id: session.id,
    title: session.title,
    state: session.archivedAt === null ? 'active' : 'archived',
    busy
  }
}

/** Whether a path is the directory itself or something inside it. */
function isInside(root: string, path: string): boolean {
  const from = relative(resolve(root), resolve(path))
  return from !== '' && !from.startsWith('..') && !from.startsWith(`..${sep}`) && from !== '..'
}

/**
 * What a directory tree is using, as the blocks its files are allocated.
 *
 * Allocated rather than apparent, so this is the figure `du` gives and the
 * person can check it. The difference is not academic in a Worktree: a cloned
 * dependency directory is hundreds of thousands of very small files, and the
 * sum of their sizes is far below what the filesystem actually handed them.
 *
 * It is still an upper bound on what removing one frees, because a Checkout is
 * bootstrapped by cloning on APFS (MEM-132) and cloned files share their
 * blocks until something writes to them. Nothing on the machine can see that
 * sharing per file — `du` reports the same figure — so the surface says so in
 * words rather than reporting a number it cannot compute.
 *
 * Symlinks are counted as links and never followed: a Worktree carrying a
 * dependency directory is full of them, and following one leads out of the
 * tree and back into it. Anything that cannot be read is skipped and the
 * answer marked incomplete rather than silently short.
 */
export async function measureDirectory(path: string): Promise<WorktreeDiskUsage> {
  let bytes = 0
  let visited = 0
  let complete = true
  const pending = [path]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) break
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => null)
    if (entries === null) {
      complete = false
      continue
    }
    for (const entry of entries) {
      if (visited >= MAX_WALKED_ENTRIES) return { bytes, complete: false }
      visited += 1
      const child = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(child)
        continue
      }
      // `lstat`, so a symlink is its own small self rather than whatever it
      // points at — which may be counted again, or may not be in the tree.
      const stats = await lstat(child).catch(() => null)
      if (stats === null) {
        complete = false
        continue
      }
      bytes += stats.blocks * BLOCK_BYTES
    }
  }
  return { bytes, complete }
}
