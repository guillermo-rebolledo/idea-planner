import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { diffSnapshots, initRepository, resolveProjectRoot, snapshotCheckout } from './git'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'git-probe-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const git = promisify(execFile)

/** What git itself calls the root, which on macOS is not the path we passed. */
async function toplevel(cwd: string): Promise<string> {
  const { stdout } = await git('git', ['rev-parse', '--show-toplevel'], { cwd })
  return stdout.trim()
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
    const changed = await diffSnapshots(root, appOwned, before, after)
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

    const changed = await diffSnapshots(root, appOwned, before, after)
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
    const changed = await diffSnapshots(root, appOwned, before, after)

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

    expect(await diffSnapshots(linked, appOwned, before, after)).toMatchObject([
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

    const changed = await diffSnapshots(root, appOwned, before, after)
    expect(changed.map((file) => file.path).sort()).toEqual(['a b/ar.txt', 'weird"name.txt'])
    for (const file of changed) expect(file.diff).toContain('+agent')
  })

  it('says so rather than failing when the Checkout is not a repository', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'git-plain-'))
    await expect(snapshotCheckout(plain, appOwned)).resolves.toEqual({ status: 'unavailable' })
    await rm(plain, { recursive: true, force: true })
  })
})
