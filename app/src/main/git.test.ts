import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyInversePatch,
  createWorktree,
  currentBranch,
  currentTreeDigest,
  diffSnapshots,
  initRepository,
  listBranches,
  observeCheckoutState,
  planRestoration,
  resolveProjectRoot,
  snapshotCheckout,
  type RestorationPlan
} from './git'
import { conflictingRepository as prepareConflict, testGit as git } from './git-test-support'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'git-probe-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** What git itself calls the root, which on macOS is not the path we passed. */
async function toplevel(cwd: string): Promise<string> {
  const { stdout } = await git('git', ['rev-parse', '--show-toplevel'], { cwd })
  return stdout.trim()
}

/** The commit a checkout is on, as git itself writes it. */
async function headOf(cwd: string): Promise<string> {
  const { stdout } = await git('git', ['rev-parse', 'HEAD'], { cwd })
  return stdout.trim()
}

/** A repository whose two branches change the same file differently. */
async function conflictingRepository(filename = 'conflict.txt'): Promise<void> {
  await prepareConflict(root, filename)
}

async function attempt(cwd: string, args: string[]): Promise<void> {
  await git('git', args, { cwd }).catch(() => undefined)
}

describe('observing Checkout State', () => {
  it('distinguishes missing git, a plain folder, and an unsafe nested Checkout', async () => {
    await expect(observeCheckoutState(root, { pathEnv: '' })).resolves.toEqual({
      status: 'git-unavailable'
    })
    await expect(observeCheckoutState(root)).resolves.toEqual({ status: 'not-a-repository' })

    await git('git', ['init', '--quiet'], { cwd: root })
    const nested = join(root, 'nested')
    await mkdir(nested)
    await expect(observeCheckoutState(nested)).resolves.toEqual({
      status: 'observed',
      state: 'unsafe-root'
    })
  })

  it('observes clean branches, detached HEAD, and linked worktrees', async () => {
    await git('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root })
    await writeFile(join(root, 'tracked.txt'), 'base\n')
    await commitAll(root, 'base')
    await expect(observeCheckoutState(root)).resolves.toEqual({
      status: 'observed',
      state: 'clean'
    })

    await git('git', ['checkout', '--quiet', '--detach'], { cwd: root })
    await expect(observeCheckoutState(root)).resolves.toEqual({
      status: 'observed',
      state: 'clean'
    })

    const linked = await mkdtemp(join(tmpdir(), 'git-state-worktree-'))
    await rm(linked, { recursive: true, force: true })
    await git('git', ['worktree', 'add', '--quiet', '-b', 'linked', linked], { cwd: root })
    await expect(observeCheckoutState(linked)).resolves.toEqual({
      status: 'observed',
      state: 'clean'
    })
    await git('git', ['worktree', 'remove', '--force', linked], { cwd: root })
  })

  it.each([
    ['merge', ['merge', 'side']],
    ['rebase', ['rebase', 'side']],
    ['cherry-pick', ['cherry-pick', 'side']],
    ['revert', ['revert', 'side']]
  ] as const)('names an active %s operation', async (state, command) => {
    await conflictingRepository()
    let operation: string[] = [...command]
    if (state === 'cherry-pick' || state === 'revert') {
      const { stdout } = await git('git', ['rev-parse', 'side'], { cwd: root })
      operation = [command[0], stdout.trim()]
    }
    await attempt(root, operation)

    await expect(observeCheckoutState(root)).resolves.toEqual({ status: 'observed', state })
  })

  it('distinguishes an active squash merge from the harmless message it leaves behind', async () => {
    await conflictingRepository()
    await attempt(root, ['merge', '--squash', 'side'])
    await expect(observeCheckoutState(root)).resolves.toEqual({
      status: 'observed',
      state: 'squash-merge'
    })

    await git('git', ['add', '-A'], { cwd: root })
    await expect(observeCheckoutState(root)).resolves.toEqual({
      status: 'observed',
      state: 'clean'
    })
  })

  it('detects unresolved entries through an unusual NUL-sensitive filename', async () => {
    const filename = 'line\nbreak\tand space.txt'
    await conflictingRepository(filename)
    await attempt(root, ['merge', 'side'])
    const { stdout: marker } = await git('git', ['rev-parse', '--git-path', 'MERGE_HEAD'], {
      cwd: root
    })
    await unlink(isAbsolute(marker.trim()) ? marker.trim() : resolve(root, marker.trim()))

    await expect(observeCheckoutState(root)).resolves.toEqual({
      status: 'observed',
      state: 'unresolved-index'
    })
  })
})

/** One commit of everything, with the identity a bare test machine lacks. */
async function commitAll(cwd: string, message: string): Promise<void> {
  await git('git', ['add', '-A'], { cwd })
  await git(
    'git',
    ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '--quiet', '-m', message],
    { cwd }
  )
}

describe('resolving a Project root', () => {
  it('accepts a repository and answers with the root git resolves', async () => {
    await git('git', ['init', '--quiet'], { cwd: root })

    await expect(resolveProjectRoot(root)).resolves.toEqual({
      status: 'resolved',
      root: await toplevel(root)
    })
  })

  it('answers with the repository root when given a directory inside it', async () => {
    await git('git', ['init', '--quiet'], { cwd: root })
    const nested = join(root, 'src', 'deep')
    await mkdir(nested, { recursive: true })

    // Pointing anywhere inside a repository adds that repository, once.
    await expect(resolveProjectRoot(nested)).resolves.toEqual({
      status: 'resolved',
      root: await toplevel(root)
    })
  })

  it('refuses a folder that is not a repository', async () => {
    await writeFile(join(root, 'notes.md'), 'not a repository')

    await expect(resolveProjectRoot(root)).resolves.toEqual({ status: 'not-a-repository' })
  })

  it('does not blame git when the folder itself has gone', async () => {
    const vanished = join(root, 'never-existed')

    // Spawning into a directory that is not there fails the same way a missing
    // binary does. Only one of those is git's fault.
    await expect(resolveProjectRoot(vanished)).resolves.toEqual({ status: 'not-a-repository' })
  })

  it('reports a missing git binary as a missing dependency, not as a bad folder', async () => {
    await writeFile(join(root, 'notes.md'), 'not a repository')

    // An empty PATH is a machine with no git on it. Answering
    // 'not-a-repository' here would send the user to fix the wrong thing.
    await expect(resolveProjectRoot(root, { pathEnv: '' })).resolves.toEqual({
      status: 'git-unavailable'
    })
  })
})

describe('reading the current branch', () => {
  it('names the branch a repository is on, even before its first commit', async () => {
    await git('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root })

    // An unborn branch is still where the next commit goes, which is the
    // answer the title bar is stating.
    await expect(currentBranch(root)).resolves.toBe('main')
  })

  it('follows a checkout to the branch it lands on', async () => {
    await git('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root })
    await writeFile(join(root, 'notes.md'), 'first')
    await commitAll(root, 'first')
    await git('git', ['checkout', '--quiet', '-b', 'fix-location-crash'], { cwd: root })

    await expect(currentBranch(root)).resolves.toBe('fix-location-crash')
  })

  it('answers null for a detached HEAD rather than inventing a name', async () => {
    await git('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root })
    await writeFile(join(root, 'notes.md'), 'first')
    await commitAll(root, 'first')
    await git('git', ['checkout', '--quiet', '--detach'], { cwd: root })

    await expect(currentBranch(root)).resolves.toBeNull()
  })

  it('answers null when the folder is not a repository', async () => {
    await expect(currentBranch(root)).resolves.toBeNull()
  })
})

describe('initialising a repository', () => {
  it('makes a plain folder into a Project root', async () => {
    await writeFile(join(root, 'notes.md'), 'not a repository yet')
    await expect(resolveProjectRoot(root)).resolves.toEqual({ status: 'not-a-repository' })

    await expect(initRepository(root)).resolves.toEqual({ status: 'initialized' })

    await expect(resolveProjectRoot(root)).resolves.toEqual({
      status: 'resolved',
      root: await toplevel(root)
    })
  })

  it('reports a missing git binary rather than claiming it initialised anything', async () => {
    await expect(initRepository(root, { pathEnv: '' })).resolves.toEqual({
      status: 'git-unavailable'
    })
  })

  it('blocks an unsafe nested root instead of creating a repository inside a repository', async () => {
    await git('git', ['init', '--quiet'], { cwd: root })
    const nested = join(root, 'nested')
    await mkdir(nested)

    await expect(initRepository(nested)).resolves.toEqual({
      status: 'blocked',
      state: 'unsafe-root'
    })
    await expect(resolveProjectRoot(nested)).resolves.toEqual({
      status: 'resolved',
      root: await toplevel(root)
    })
  })
})

describe('what the process inherited', () => {
  it('ignores a GIT_DIR the app was handed, so the folder still decides', async () => {
    // Exactly what a git hook exports. Inherited, it makes *any* directory
    // look like a repository — including one the person never tracked.
    const elsewhere = await mkdtemp(join(tmpdir(), 'git-elsewhere-'))
    await git('git', ['init', '--quiet'], { cwd: elsewhere })
    process.env['GIT_DIR'] = join(elsewhere, '.git')
    process.env['GIT_INDEX_FILE'] = join(elsewhere, '.git', 'index')
    try {
      // `root` is a plain folder, and stays one however this app was invoked.
      await expect(resolveProjectRoot(root)).resolves.toEqual({ status: 'not-a-repository' })
    } finally {
      delete process.env['GIT_DIR']
      delete process.env['GIT_INDEX_FILE']
      await rm(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('snapshotting a Checkout', () => {
  let appOwned: string

  /** A repository with one committed file, as any Project would have. */
  async function commit(content: string): Promise<void> {
    await writeFile(join(root, 'tracked.ts'), content)
    await writeFile(join(root, '.gitignore'), 'node_modules/\n')
    await git('git', ['add', '-A'], { cwd: root })
    await git(
      'git',
      ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'init'],
      { cwd: root }
    )
  }

  async function loose(): Promise<number> {
    const { stdout } = await git('sh', [
      '-c',
      `find ${join(root, '.git', 'objects')} -type f | wc -l`
    ])
    return Number(stdout.trim())
  }

  beforeEach(async () => {
    await git('git', ['init', '--quiet'], { cwd: root })
    appOwned = await mkdtemp(join(tmpdir(), 'git-snapshot-'))
    await commit('a\n')
  })

  afterEach(async () => {
    await rm(appOwned, { recursive: true, force: true })
  })

  it('sees a change made by a shell command, which no Harness would report', async () => {
    const before = await snapshotCheckout(root, appOwned)
    await writeFile(join(root, 'tracked.ts'), 'agent\n')
    await writeFile(join(root, 'added.ts'), 'new\n')
    const after = await snapshotCheckout(root, appOwned)

    expect(before.status).toBe('taken')
    const { changes: changed } = await diffSnapshots(root, appOwned, before, after)
    expect(changed.map((file) => file.path).sort()).toEqual(['added.ts', 'tracked.ts'])
    expect(changed.find((file) => file.path === 'tracked.ts')?.diff).toContain('+agent')
  })

  it('leaves what the person had already changed out of it', async () => {
    // Dirty before the Run, and something staged: theirs, not the agent's.
    await writeFile(join(root, 'tracked.ts'), 'a\nmine\n')
    await writeFile(join(root, 'untracked.md'), 'draft\n')
    await git('git', ['add', 'untracked.md'], { cwd: root })

    const before = await snapshotCheckout(root, appOwned)
    await writeFile(join(root, 'tracked.ts'), 'a\nmine\nagent\n')
    const after = await snapshotCheckout(root, appOwned)

    const { changes: changed } = await diffSnapshots(root, appOwned, before, after)
    expect(changed.map((file) => file.path)).toEqual(['tracked.ts'])
    expect(changed[0]?.diff).toContain('+agent')
    expect(changed[0]?.diff).not.toContain('+mine')
  })

  it('writes nothing into the person’s repository', async () => {
    const objectsBefore = await loose()
    const { stdout: stagedBefore } = await git('git', ['diff', '--cached', '--name-only'], {
      cwd: root
    })

    const before = await snapshotCheckout(root, appOwned)
    await writeFile(join(root, 'tracked.ts'), 'agent\n')
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'x'), 'junk\n')
    const after = await snapshotCheckout(root, appOwned)
    const { changes: changed } = await diffSnapshots(root, appOwned, before, after)

    expect(await loose()).toBe(objectsBefore)
    const { stdout: stagedAfter } = await git('git', ['diff', '--cached', '--name-only'], {
      cwd: root
    })
    expect(stagedAfter).toBe(stagedBefore)
    // Ignored files are the person's business and never the agent's work.
    expect(changed.map((file) => file.path)).toEqual(['tracked.ts'])
  })

  it('works in a linked worktree, where the objects are not under .git', async () => {
    const linked = join(await mkdtemp(join(tmpdir(), 'git-linked-')), 'work')
    await git('git', ['worktree', 'add', '--quiet', '-b', 'side', linked], { cwd: root })

    const before = await snapshotCheckout(linked, appOwned)
    await writeFile(join(linked, 'tracked.ts'), 'agent\n')
    const after = await snapshotCheckout(linked, appOwned)

    expect((await diffSnapshots(linked, appOwned, before, after)).changes).toMatchObject([
      { path: 'tracked.ts' }
    ])
    await rm(linked, { recursive: true, force: true })
  })

  it('names files git itself would quote or that read as two paths', async () => {
    // Both verified against git: a path containing `" b/"` makes the patch
    // header ambiguous, and one with a quote in it is escaped entirely.
    await mkdir(join(root, 'a b'), { recursive: true })
    await writeFile(join(root, 'a b', 'ar.txt'), 'x\n')
    await writeFile(join(root, 'weird"name.txt'), 'y\n')
    const before = await snapshotCheckout(root, appOwned)
    await writeFile(join(root, 'a b', 'ar.txt'), 'x\nagent\n')
    await writeFile(join(root, 'weird"name.txt'), 'y\nagent\n')
    const after = await snapshotCheckout(root, appOwned)

    const { changes: changed } = await diffSnapshots(root, appOwned, before, after)
    expect(changed.map((file) => file.path).sort()).toEqual(['a b/ar.txt', 'weird"name.txt'])
    for (const file of changed) expect(file.diff).toContain('+agent')
  })

  it('says which files were created and which were deleted', async () => {
    await writeFile(join(root, 'doomed.ts'), 'export const doomed = true\n')
    const before = await snapshotCheckout(root, appOwned)
    await rm(join(root, 'doomed.ts'))
    await writeFile(join(root, 'fresh.ts'), 'export const fresh = true\n')
    await writeFile(join(root, 'tracked.ts'), 'changed\n')
    const after = await snapshotCheckout(root, appOwned)

    const { changes: changed } = await diffSnapshots(root, appOwned, before, after)
    expect(changed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'doomed.ts', changeKind: 'deleted' }),
        expect.objectContaining({ path: 'fresh.ts', changeKind: 'added' }),
        expect.objectContaining({ path: 'tracked.ts', changeKind: 'changed' })
      ])
    )
  })

  it('caps how many files it lists, and says how many it did not', async () => {
    const before = await snapshotCheckout(root, appOwned)
    await mkdir(join(root, 'generated'), { recursive: true })
    await Promise.all(
      Array.from({ length: 505 }, (_, index) =>
        writeFile(join(root, 'generated', `file-${String(index)}.ts`), 'export const x = 1\n')
      )
    )
    const after = await snapshotCheckout(root, appOwned)

    const comparison = await diffSnapshots(root, appOwned, before, after)
    expect(comparison.changes).toHaveLength(500)
    expect(comparison.unlisted).toBe(5)
  })

  it('says so rather than failing when the Checkout is not a repository', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'git-plain-'))
    await expect(snapshotCheckout(plain, appOwned)).resolves.toEqual({
      status: 'skipped',
      reason: 'not-a-repository'
    })
    await rm(plain, { recursive: true, force: true })
  })

  it('snapshots during an active operation without touching its real index', async () => {
    const { stdout: branch } = await git('git', ['branch', '--show-current'], { cwd: root })
    await git('git', ['checkout', '--quiet', '-b', 'side'], { cwd: root })
    await writeFile(join(root, 'tracked.ts'), 'side\n')
    await commitAll(root, 'side')
    await git('git', ['checkout', '--quiet', branch.trim()], { cwd: root })
    await writeFile(join(root, 'tracked.ts'), 'main\n')
    await commitAll(root, 'main')
    await attempt(root, ['merge', 'side'])
    const { stdout: indexBefore } = await git('git', ['ls-files', '--stage', '-z'], { cwd: root })

    await expect(snapshotCheckout(root, appOwned)).resolves.toMatchObject({ status: 'taken' })

    const { stdout: indexAfter } = await git('git', ['ls-files', '--stage', '-z'], { cwd: root })
    expect(indexAfter).toBe(indexBefore)
  })
})

describe('planning and applying a restoration', () => {
  let store: string

  /** The repository every restoration case starts from: one committed file. */
  async function committed(): Promise<void> {
    await git('git', ['init', '--quiet', '-b', 'main'], { cwd: root })
    await writeFile(join(root, 'tracked.ts'), 'base\n')
    await writeFile(join(root, '.gitignore'), 'ignored/\n')
    await commitAll(root, 'init')
  }

  /** A tree of the Checkout as it is right now, which is what a Run brackets. */
  async function tree(): Promise<string> {
    const snapshot = await snapshotCheckout(root, store)
    if (snapshot.status !== 'taken') throw new Error(`snapshot ${JSON.stringify(snapshot)}`)
    return snapshot.tree
  }

  async function plan(before: string, after: string): Promise<RestorationPlan> {
    const planned = await planRestoration({ checkout: root, store, before, after })
    if (planned.status !== 'planned') throw new Error(`planning ${JSON.stringify(planned)}`)
    return planned.plan
  }

  /** What one path was classified as, by path rather than by position. */
  function classificationOf(planned: RestorationPlan, path: string): string | undefined {
    return planned.paths.find((entry) => entry.path === path)?.classification
  }

  beforeEach(async () => {
    store = await mkdtemp(join(tmpdir(), 'git-restore-store-'))
  })

  afterEach(async () => {
    await rm(store, { recursive: true, force: true })
  })

  it('puts back every kind of change a Run can make', async () => {
    await committed()
    await writeFile(join(root, 'doomed.ts'), 'doomed\n')
    await writeFile(join(root, 'image.bin'), Buffer.from([0, 1, 2, 250, 0, 255]))
    await writeFile(join(root, 'script.sh'), '#!/bin/sh\necho hi\n')
    await writeFile(join(root, 'blank.txt'), '')
    await commitAll(root, 'more')
    const before = await tree()

    // One Run: a modification, a creation, a deletion, a binary rewrite, an
    // added executable bit, a newly untracked file, and an emptied file.
    await writeFile(join(root, 'tracked.ts'), 'agent\n')
    await writeFile(join(root, 'fresh.ts'), 'fresh\n')
    await rm(join(root, 'doomed.ts'))
    await writeFile(join(root, 'image.bin'), Buffer.from([9, 9, 9, 0, 1, 200]))
    await chmod(join(root, 'script.sh'), 0o755)
    await writeFile(join(root, 'blank.txt'), 'no longer blank\n')
    await mkdir(join(root, 'ignored'), { recursive: true })
    await writeFile(join(root, 'ignored', 'noise.log'), 'noise\n')
    const after = await tree()

    const planned = await plan(before, after)
    expect(planned.paths.map((entry) => entry.path).sort()).toEqual([
      'blank.txt',
      'doomed.ts',
      'fresh.ts',
      'image.bin',
      'script.sh',
      'tracked.ts'
    ])
    expect(planned.paths.every((entry) => entry.classification === 'safe')).toBe(true)

    await expect(
      applyInversePatch({ checkout: root, store, patch: planned.patch })
    ).resolves.toEqual({ status: 'applied' })

    await expect(readFile(join(root, 'tracked.ts'), 'utf8')).resolves.toBe('base\n')
    await expect(readFile(join(root, 'doomed.ts'), 'utf8')).resolves.toBe('doomed\n')
    await expect(readFile(join(root, 'blank.txt'), 'utf8')).resolves.toBe('')
    await expect(access(join(root, 'fresh.ts'))).rejects.toThrow()
    expect([...(await readFile(join(root, 'image.bin')))]).toEqual([0, 1, 2, 250, 0, 255])
    expect((await stat(join(root, 'script.sh'))).mode & 0o111).toBe(0)
    // An ignored file was never the Run's work and is never anyone's to undo.
    await expect(readFile(join(root, 'ignored', 'noise.log'), 'utf8')).resolves.toBe('noise\n')
  })

  it('classifies a path touched since the Run as diverged, and never writes to it', async () => {
    await committed()
    const before = await tree()
    await writeFile(join(root, 'tracked.ts'), 'agent\n')
    await writeFile(join(root, 'untouched.ts'), 'agent\n')
    const after = await tree()

    await writeFile(join(root, 'tracked.ts'), 'agent\nand then me\n')
    const planned = await plan(before, after)

    expect(classificationOf(planned, 'tracked.ts')).toBe('diverged')
    expect(classificationOf(planned, 'untouched.ts')).toBe('safe')
    expect(planned.patch).not.toContain('tracked.ts')

    await expect(
      applyInversePatch({ checkout: root, store, patch: planned.patch })
    ).resolves.toEqual({ status: 'applied' })
    await expect(readFile(join(root, 'tracked.ts'), 'utf8')).resolves.toBe('agent\nand then me\n')
    await expect(access(join(root, 'untouched.ts'))).rejects.toThrow()
  })

  it('says a path is already restored rather than offering to restore it twice', async () => {
    await committed()
    const before = await tree()
    await writeFile(join(root, 'tracked.ts'), 'agent\n')
    const after = await tree()
    await writeFile(join(root, 'tracked.ts'), 'base\n')

    const planned = await plan(before, after)
    expect(classificationOf(planned, 'tracked.ts')).toBe('already-restored')
    expect(planned.patch).toBe('')
  })

  it('refuses a patch computed against a tree that has since moved', async () => {
    await committed()
    const before = await tree()
    await writeFile(join(root, 'tracked.ts'), 'agent\n')
    const after = await tree()
    const planned = await plan(before, after)

    // The person saves their editor between reviewing and confirming.
    await writeFile(join(root, 'tracked.ts'), 'mine now\n')

    expect(await currentTreeDigest(root, store)).not.toBe(planned.treeDigest)
    await expect(
      applyInversePatch({ checkout: root, store, patch: planned.patch })
    ).resolves.toEqual({ status: 'refused' })
    await expect(readFile(join(root, 'tracked.ts'), 'utf8')).resolves.toBe('mine now\n')
  })

  it('refuses while a Git operation is underway, and leaves the tree and index alone', async () => {
    await conflictingRepository('tracked.ts')
    const before = await tree()
    await writeFile(join(root, 'other.ts'), 'agent\n')
    const after = await tree()
    const planned = await plan(before, after)
    await attempt(root, ['merge', 'side'])

    const { stdout: indexBefore } = await git('git', ['ls-files', '--stage', '-z'], { cwd: root })
    await expect(
      applyInversePatch({ checkout: root, store, patch: planned.patch })
    ).resolves.toEqual({ status: 'refused' })
    const { stdout: indexAfter } = await git('git', ['ls-files', '--stage', '-z'], { cwd: root })

    expect(indexAfter).toBe(indexBefore)
    await expect(readFile(join(root, 'other.ts'), 'utf8')).resolves.toBe('agent\n')
  })

  it('reports the Checkout State rather than planning during an operation', async () => {
    await conflictingRepository('tracked.ts')
    const before = await tree()
    await writeFile(join(root, 'other.ts'), 'agent\n')
    const after = await tree()
    const nested = join(root, 'nested')
    await mkdir(nested, { recursive: true })

    await expect(planRestoration({ checkout: nested, store, before, after })).resolves.toEqual({
      status: 'skipped',
      reason: 'checkout-state',
      state: 'unsafe-root'
    })
  })

  it('leaves the person’s staged work exactly as they staged it', async () => {
    await committed()
    await writeFile(join(root, 'mine.ts'), 'mine\n')
    await git('git', ['add', 'mine.ts'], { cwd: root })
    const before = await tree()
    await writeFile(join(root, 'tracked.ts'), 'agent\n')
    const after = await tree()
    const { stdout: stagedBefore } = await git('git', ['ls-files', '--stage', '-z'], { cwd: root })

    const planned = await plan(before, after)
    await expect(
      applyInversePatch({ checkout: root, store, patch: planned.patch })
    ).resolves.toEqual({ status: 'applied' })

    const { stdout: stagedAfter } = await git('git', ['ls-files', '--stage', '-z'], { cwd: root })
    expect(stagedAfter).toBe(stagedBefore)
    await expect(readFile(join(root, 'tracked.ts'), 'utf8')).resolves.toBe('base\n')
  })

  it('writes every object it makes into app-owned state, and none into the repository', async () => {
    await committed()
    const { stdout: loose } = await git('sh', [
      '-c',
      `find ${join(root, '.git', 'objects')} -type f | wc -l`
    ])
    const before = await tree()
    await writeFile(join(root, 'tracked.ts'), 'agent\n')
    const after = await tree()
    await plan(before, after)

    const { stdout: looseAfter } = await git('sh', [
      '-c',
      `find ${join(root, '.git', 'objects')} -type f | wc -l`
    ])
    expect(looseAfter.trim()).toBe(loose.trim())
  })

  it('plans nothing for a Run that changed nothing', async () => {
    await committed()
    const before = await tree()
    const planned = await plan(before, before)
    expect(planned).toMatchObject({ paths: [], patch: '' })
  })
})

describe('listing branches for an isolated checkout base', () => {
  it('names the local branches, most recently committed first, with the current one', async () => {
    await git('git', ['init', '--quiet', '-b', 'trunk'], { cwd: root })
    await writeFile(join(root, 'a.txt'), 'a\n')
    await commitAll(root, 'first')
    await git('git', ['branch', 'older'], { cwd: root })
    await git('git', ['checkout', '--quiet', '-b', 'newer'], { cwd: root })
    await writeFile(join(root, 'b.txt'), 'b\n')
    await commitAll(root, 'second')
    await git('git', ['checkout', '--quiet', 'trunk'], { cwd: root })

    const listed = await listBranches(root)
    expect(listed.current).toBe('trunk')
    expect(listed.branches[0]).toBe('newer')
    expect(listed.branches).toEqual(expect.arrayContaining(['trunk', 'older', 'newer']))
  })

  it('answers empty rather than failing when the folder is not a repository', async () => {
    await expect(listBranches(root)).resolves.toEqual({ branches: [], current: null })
  })
})

describe('creating an isolated checkout', () => {
  it('returns a typed unsafe-root block before touching repository state', async () => {
    await git('git', ['init', '--quiet', '-b', 'trunk'], { cwd: root })
    await writeFile(join(root, 'a.txt'), 'a\n')
    await commitAll(root, 'first')
    const nested = join(root, 'nested')
    const home = await mkdtemp(join(tmpdir(), 'git-worktrees-'))
    await mkdir(nested)
    const { stdout: indexBefore } = await git('git', ['ls-files', '--stage', '-z'], { cwd: root })

    await expect(
      createWorktree({
        projectRoot: nested,
        worktreesDirectory: home,
        branch: 'must-not-exist',
        baseBranch: 'trunk'
      })
    ).resolves.toEqual({ status: 'blocked', state: 'unsafe-root' })

    const { stdout: indexAfter } = await git('git', ['ls-files', '--stage', '-z'], { cwd: root })
    expect(indexAfter).toBe(indexBefore)
    await rm(home, { recursive: true, force: true })
  })

  it('adds a linked worktree on a new branch cut from the chosen base', async () => {
    await git('git', ['init', '--quiet', '-b', 'trunk'], { cwd: root })
    await writeFile(join(root, 'a.txt'), 'a\n')
    await writeFile(join(root, '.gitignore'), '.env*\n')
    await commitAll(root, 'first')
    await writeFile(join(root, '.env.local'), 'checkout-only\n')
    const home = await mkdtemp(join(tmpdir(), 'git-worktrees-'))

    const created = await createWorktree({
      projectRoot: root,
      worktreesDirectory: home,
      branch: 'fix-location-crash',
      baseBranch: 'trunk'
    })

    if (created.status !== 'created') throw new Error('expected a worktree')
    expect(await currentBranch(created.path)).toBe('fix-location-crash')
    expect(created.bootstrap).toMatchObject({
      outcome: 'copied',
      copied: ['.env.local'],
      skipped: [],
      // The Project's own HEAD, not the worktree's: the state carried came out
      // of the person's working copy.
      provenance: { branch: 'trunk', commit: await headOf(root) }
    })
    await expect(readFile(join(created.path, '.env.local'), 'utf8')).resolves.toBe(
      'checkout-only\n'
    )
    // The person's own copy never moves.
    expect(await currentBranch(root)).toBe('trunk')
    await rm(home, { recursive: true, force: true })
  })

  it('finds a free branch name rather than failing on a taken one', async () => {
    await git('git', ['init', '--quiet', '-b', 'trunk'], { cwd: root })
    await writeFile(join(root, 'a.txt'), 'a\n')
    await commitAll(root, 'first')
    await git('git', ['branch', 'fix-crash'], { cwd: root })
    const home = await mkdtemp(join(tmpdir(), 'git-worktrees-'))

    const created = await createWorktree({
      projectRoot: root,
      worktreesDirectory: home,
      branch: 'fix-crash',
      baseBranch: 'trunk'
    })

    if (created.status !== 'created') throw new Error('expected a worktree')
    expect(created.branch).not.toBe('fix-crash')
    expect(created.branch).toContain('fix-crash')
    await rm(home, { recursive: true, force: true })
  })

  it('says what went wrong rather than throwing when the base does not exist', async () => {
    await git('git', ['init', '--quiet', '-b', 'trunk'], { cwd: root })
    const home = await mkdtemp(join(tmpdir(), 'git-worktrees-'))

    const created = await createWorktree({
      projectRoot: root,
      worktreesDirectory: home,
      branch: 'anything',
      baseBranch: 'no-such-branch'
    })

    expect(created.status).toBe('failed')
    await rm(home, { recursive: true, force: true })
  })

  it('creates from a named base during a merge without touching the working tree or index', async () => {
    await conflictingRepository()
    await attempt(root, ['merge', 'side'])
    const home = await mkdtemp(join(tmpdir(), 'git-worktrees-'))
    const { stdout: statusBefore } = await git('git', ['status', '--porcelain=v1', '-z'], {
      cwd: root
    })
    const { stdout: indexBefore } = await git('git', ['ls-files', '--stage', '-z'], { cwd: root })

    await expect(
      createWorktree({
        projectRoot: root,
        worktreesDirectory: home,
        branch: 'during-merge',
        baseBranch: 'main'
      })
    ).resolves.toMatchObject({ status: 'created', branch: 'during-merge' })

    const { stdout: statusAfter } = await git('git', ['status', '--porcelain=v1', '-z'], {
      cwd: root
    })
    const { stdout: indexAfter } = await git('git', ['ls-files', '--stage', '-z'], { cwd: root })
    expect(statusAfter).toBe(statusBefore)
    expect(indexAfter).toBe(indexBefore)
    await rm(home, { recursive: true, force: true })
  })

  it('keeps missing Git and a non-repository as distinct outcomes', async () => {
    const input = {
      projectRoot: root,
      worktreesDirectory: join(root, 'worktrees'),
      branch: 'new',
      baseBranch: 'main'
    }
    await expect(createWorktree(input)).resolves.toEqual({ status: 'not-a-repository' })
    await expect(createWorktree(input, { pathEnv: '' })).resolves.toEqual({
      status: 'git-unavailable'
    })
  })
})
