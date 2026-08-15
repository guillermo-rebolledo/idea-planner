import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/contract'
import { WorktreeReclaimService, measureDirectory } from './worktree-reclaim'
import { createWorktree } from './git'
import { testGit as git } from './git-test-support'

/**
 * Reclaiming is exercised against real repositories and real linked worktrees.
 * Every claim this surface makes — what a Checkout holds, whether it is gone,
 * whether the branch survived — is a claim about git, and a fake git would be
 * a fake answer.
 */

let sandbox: string
let projectRoot: string
let worktrees: string
let sessions: SessionSummary[]
let busy: string[]

function service(): WorktreeReclaimService {
  return new WorktreeReclaimService({
    directoryFor: () => worktrees,
    sessions: () => Promise.resolve(sessions),
    busyCheckouts: () => busy
  })
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git('git', ['add', '-A'], { cwd })
  await git(
    'git',
    ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '--quiet', '-m', message],
    { cwd }
  )
}

/** One isolated Checkout, made exactly the way starting a Session makes one. */
async function makeWorktree(branch: string): Promise<string> {
  const created = await createWorktree({
    projectRoot,
    worktreesDirectory: worktrees,
    branch,
    baseBranch: 'main'
  })
  if (created.status !== 'created')
    throw new Error(`The Worktree was not created: ${created.status}`)
  return created.path
}

function session(overrides: Partial<SessionSummary> & { checkoutPath: string }): SessionSummary {
  return {
    id: overrides.id ?? 'session-1',
    projectRoot,
    checkout: { kind: 'worktree', path: overrides.checkoutPath, baseBranch: 'main' },
    worktreeBootstrap: null,
    title: overrides.title ?? 'Fix the location crash',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    pinned: false,
    archivedAt: overrides.archivedAt ?? null
  }
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'worktree-reclaim-'))
  projectRoot = join(sandbox, 'project')
  worktrees = join(sandbox, 'worktrees')
  sessions = []
  busy = []
  await mkdir(projectRoot)
  await git('git', ['init', '--quiet', '--initial-branch=main'], { cwd: projectRoot })
  await writeFile(join(projectRoot, 'app.ts'), 'export const app = true\n')
  await commitAll(projectRoot, 'init')
})

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true })
})

describe('listing what Argos made', () => {
  it('names the Session, its state, what the Checkout holds, and what it costs', async () => {
    const clean = await makeWorktree('quiet')
    const dirty = await makeWorktree('uncommitted')
    const committed = await makeWorktree('committed')
    await writeFile(join(dirty, 'scratch.ts'), 'unsaved work\n')
    await writeFile(join(committed, 'landed.ts'), 'work nothing else has\n')
    await commitAll(committed, 'only here')
    sessions = [
      session({ id: 'a', checkoutPath: clean, title: 'Quiet one' }),
      session({
        id: 'b',
        checkoutPath: dirty,
        title: 'Set aside',
        archivedAt: '2026-08-11T00:00:00.000Z'
      })
    ]

    const inventory = await service().inventory(projectRoot)

    expect(inventory.unlisted).toBe(0)
    const byBranch = new Map(inventory.worktrees.map((entry) => [entry.branch, entry]))
    expect(byBranch.get('quiet')?.session).toMatchObject({
      id: 'a',
      title: 'Quiet one',
      state: 'active',
      busy: false
    })
    expect(byBranch.get('quiet')?.contents).toEqual({
      status: 'observed',
      uncommittedChanges: false,
      commitsOnlyHere: false
    })
    // An archived Session still owns its Checkout; archiving says "not now".
    expect(byBranch.get('uncommitted')?.session?.state).toBe('archived')
    expect(byBranch.get('uncommitted')?.contents).toMatchObject({ uncommittedChanges: true })
    // A commit no other branch, remote, or tag holds is the one thing removing
    // this would take with it.
    expect(byBranch.get('committed')?.contents).toMatchObject({ commitsOnlyHere: true })
    // Its Session was deleted; the directory is still on disk, so it is listed.
    expect(byBranch.get('committed')?.session).toBeNull()
    expect(byBranch.get('quiet')?.disk.bytes).toBeGreaterThan(0)
    expect(byBranch.get('quiet')?.disk.complete).toBe(true)
  })

  it('does not call a commit that another branch already holds work only here', async () => {
    const merged = await makeWorktree('merged')
    await writeFile(join(merged, 'landed.ts'), 'shipped\n')
    await commitAll(merged, 'landed')
    await git('git', ['branch', 'keeper', 'merged'], { cwd: projectRoot })

    const inventory = await service().inventory(projectRoot)

    expect(inventory.worktrees[0]?.contents).toMatchObject({ commitsOnlyHere: false })
  })

  it('says a Run is working in one rather than offering it for removal', async () => {
    const path = await makeWorktree('running')
    sessions = [session({ id: 'a', checkoutPath: path })]
    busy = [path]

    const inventory = await service().inventory(projectRoot)

    expect(inventory.worktrees[0]?.session?.busy).toBe(true)
  })

  it('lists a directory git cannot answer for rather than hiding it', async () => {
    // A half-made Checkout, or one whose repository was pruned underneath it.
    // It is still on disk and still costing something, so it is still listed —
    // with what it holds stated as unknown rather than guessed at.
    const stranded = join(worktrees, 'half-made')
    await mkdir(stranded, { recursive: true })
    await writeFile(join(stranded, 'left-behind.ts'), 'orphaned\n')

    const inventory = await service().inventory(projectRoot)

    expect(inventory.worktrees).toHaveLength(1)
    expect(inventory.worktrees[0]).toMatchObject({
      branch: null,
      session: null,
      contents: { status: 'unreadable' }
    })
    expect(inventory.worktrees[0]?.disk.bytes).toBeGreaterThan(0)
  })

  it('is empty, not an error, for a Project Argos has made nothing for', async () => {
    await expect(service().inventory(projectRoot)).resolves.toEqual({
      projectRoot,
      worktrees: [],
      unlisted: 0
    })
  })
})

describe('removing the ones that were asked for', () => {
  it('removes only what was named and leaves the branch where it is', async () => {
    const doomed = await makeWorktree('doomed')
    const kept = await makeWorktree('kept')

    const result = await service().remove({ projectRoot, paths: [doomed] })

    expect(result.removals).toEqual([{ path: doomed, outcome: 'removed', detail: null }])
    await expect(access(doomed)).rejects.toThrow()
    await expect(access(kept)).resolves.toBeUndefined()
    // Branches are left alone: the work is on them, and git is the undo.
    const { stdout } = await git('git', ['branch', '--list', '--format=%(refname:short)'], {
      cwd: projectRoot
    })
    expect(stdout.split('\n').map((line) => line.trim())).toContain('doomed')
  })

  it('removes a Checkout holding uncommitted work, having said that it does', async () => {
    const path = await makeWorktree('dirty')
    await writeFile(join(path, 'scratch.ts'), 'unsaved\n')

    const result = await service().remove({ projectRoot, paths: [path] })

    expect(result.removals[0]?.outcome).toBe('removed')
  })

  it('reports one removed outside the app as gone rather than as a failure', async () => {
    const path = await makeWorktree('elsewhere')
    await git('git', ['worktree', 'remove', '--force', path], { cwd: projectRoot })

    const result = await service().remove({ projectRoot, paths: [path] })

    expect(result.removals).toEqual([{ path, outcome: 'already-gone', detail: null }])
  })

  it('refuses one a Run is working in, and says why', async () => {
    const path = await makeWorktree('running')
    busy = [path]

    const result = await service().remove({ projectRoot, paths: [path] })

    expect(result.removals[0]).toMatchObject({ outcome: 'failed' })
    expect(result.removals[0]?.detail).toMatch(/Run is working in it/)
    await expect(access(path)).resolves.toBeUndefined()
  })

  it('refuses a directory outside the Worktrees Argos made for this Project', async () => {
    const outsider = join(sandbox, 'somebody-elses-work')
    await mkdir(outsider)

    const result = await service().remove({ projectRoot, paths: [outsider, projectRoot] })

    expect(result.removals.map((removal) => removal.outcome)).toEqual(['failed', 'failed'])
    await expect(access(outsider)).resolves.toBeUndefined()
    await expect(access(projectRoot)).resolves.toBeUndefined()
  })

  it('lets one failure stand alone, so the rest are still removed', async () => {
    const blocked = await makeWorktree('blocked')
    const removable = await makeWorktree('removable')
    busy = [blocked]

    const result = await service().remove({ projectRoot, paths: [blocked, removable] })

    expect(result.removals.map((removal) => removal.outcome)).toEqual(['failed', 'removed'])
    await expect(access(blocked)).resolves.toBeUndefined()
    await expect(access(removable)).rejects.toThrow()
  })

  it('removes a directory the Project no longer has any record of', async () => {
    const path = await makeWorktree('orphan')
    // The Project was re-cloned, or its admin file pruned while the directory
    // stayed: `git worktree remove` can never remove this, so nothing but the
    // app can. It is the app's own state directory, and the person asked.
    await rm(join(projectRoot, '.git', 'worktrees'), { recursive: true, force: true })

    const result = await service().remove({ projectRoot, paths: [path] })

    expect(result.removals[0]?.outcome).toBe('removed')
    await expect(access(path)).rejects.toThrow()
  })
})

describe('measuring what a directory costs', () => {
  it('sums the files under it', async () => {
    const tree = join(sandbox, 'measured')
    await mkdir(join(tree, 'nested'), { recursive: true })
    await writeFile(join(tree, 'a.txt'), 'x'.repeat(100))
    await writeFile(join(tree, 'nested', 'b.txt'), 'y'.repeat(50))

    await expect(measureDirectory(tree)).resolves.toEqual({ bytes: 150, complete: true })
  })

  it('answers nothing, completely, for a directory that is not there', async () => {
    await expect(measureDirectory(join(sandbox, 'never-existed'))).resolves.toEqual({
      bytes: 0,
      complete: false
    })
  })
})
