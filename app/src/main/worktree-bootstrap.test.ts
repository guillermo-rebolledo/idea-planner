import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readlink,
  rm,
  stat,
  statfs,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorktreeBootstrapResult } from '@shared/checkout'
import { testGit as git } from './git-test-support'
import { bootstrapWorktree } from './worktree-bootstrap'

let projectRoot: string
let checkoutRoot: string

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'bootstrap-project-'))
  checkoutRoot = await mkdtemp(join(tmpdir(), 'bootstrap-checkout-'))
  await git('git', ['init', '--quiet', '--initial-branch=main'], { cwd: projectRoot })
  await writeFile(join(projectRoot, '.gitignore'), '.env*\n')
  await writeFile(join(projectRoot, '.env.tracked'), 'tracked\n')
  await git('git', ['add', '.gitignore'], { cwd: projectRoot })
  await git('git', ['add', '--force', '.env.tracked'], { cwd: projectRoot })
  await git(
    'git',
    ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'base'],
    { cwd: projectRoot }
  )
})

afterEach(async () => {
  await Promise.all([
    rm(projectRoot, { recursive: true, force: true }),
    rm(checkoutRoot, { recursive: true, force: true })
  ])
})

describe('bootstrapping an isolated Checkout', () => {
  it('copies ignored .env files by default and never copies a tracked match', async () => {
    await writeFile(join(projectRoot, '.env.local'), 'local secret\n')

    const result = await bootstrapWorktree({ projectRoot, checkoutRoot })

    expect(withoutOrigin(result)).toEqual({
      outcome: 'partial',
      copied: ['.env.local'],
      skipped: [{ path: '.env.tracked', reason: 'tracked' }]
    })
    await expect(readFile(join(checkoutRoot, '.env.local'), 'utf8')).resolves.toBe('local secret\n')
    await expect(readFile(join(checkoutRoot, '.env.tracked'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('uses root .worktreeinclude instead of the fallback pattern', async () => {
    await writeFile(join(projectRoot, '.gitignore'), '.env*\nconfig/**\n')
    await writeFile(join(projectRoot, '.env.local'), 'fallback\n')
    await mkdir(join(projectRoot, 'config'), { recursive: true })
    await writeFile(join(projectRoot, 'config', 'local.json'), '{"local":true}\n')
    await writeFile(join(projectRoot, 'config', 'tracked.json'), '{"tracked":true}\n')
    await git('git', ['add', '--force', 'config/tracked.json'], { cwd: projectRoot })
    await mkdir(join(projectRoot, 'public'), { recursive: true })
    await writeFile(join(projectRoot, 'public', 'local.json'), '{"public":true}\n')
    await writeFile(join(projectRoot, '.worktreeinclude'), 'config/**\npublic/**\n')

    const result = await bootstrapWorktree({ projectRoot, checkoutRoot })

    expect(withoutOrigin(result)).toEqual({
      outcome: 'partial',
      copied: ['config/local.json'],
      skipped: [
        { path: 'config/tracked.json', reason: 'tracked' },
        { path: 'public/local.json', reason: 'not-ignored' }
      ]
    })
    await expect(readFile(join(checkoutRoot, 'config', 'local.json'), 'utf8')).resolves.toBe(
      '{"local":true}\n'
    )
    await expect(readFile(join(checkoutRoot, '.env.local'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(
      readFile(join(checkoutRoot, 'config', 'tracked.json'), 'utf8')
    ).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(
      readFile(join(checkoutRoot, 'public', 'local.json'), 'utf8')
    ).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('supports nested Unicode paths and Git-style negation', async () => {
    await writeFile(join(projectRoot, '.gitignore'), 'local/**\n')
    await mkdir(join(projectRoot, 'local', '日本語'), { recursive: true })
    await writeFile(join(projectRoot, 'local', '日本語', 'keep.env'), 'keep\n')
    await writeFile(join(projectRoot, 'local', '日本語', 'skip.env'), 'skip\n')
    await writeFile(join(projectRoot, '.worktreeinclude'), '!local/日本語/skip.env\nlocal/**\n')

    const result = await bootstrapWorktree({ projectRoot, checkoutRoot })

    expect(withoutOrigin(result)).toEqual({
      outcome: 'copied',
      copied: ['local/日本語/keep.env'],
      skipped: []
    })
  })

  it('does not turn a negation-only manifest into an include-everything pattern', async () => {
    await writeFile(join(projectRoot, '.env.local'), 'must stay local\n')
    await writeFile(join(projectRoot, '.worktreeinclude'), '!.env.local\n')

    expect(withoutOrigin(await bootstrapWorktree({ projectRoot, checkoutRoot }))).toEqual({
      outcome: 'skipped',
      copied: [],
      skipped: []
    })
  })

  it('refuses named symlinks and traversal patterns while retaining successful copies', async () => {
    // `local` holds something Git does not ignore, so it is carried file by
    // file rather than cloned whole — which is what puts the symlink rule for
    // a named path in play.
    await writeFile(join(projectRoot, '.gitignore'), 'local/*.env\n')
    await mkdir(join(projectRoot, 'local'))
    await writeFile(join(projectRoot, 'local', 'good.env'), 'good\n')
    await writeFile(join(projectRoot, 'local', 'readme.md'), 'read me\n')
    await symlink(join(projectRoot, 'local', 'good.env'), join(projectRoot, 'local', 'link.env'))
    await writeFile(join(projectRoot, '.worktreeinclude'), 'local/**\n../outside.env\n')

    const result = await bootstrapWorktree({ projectRoot, checkoutRoot })

    expect(withoutOrigin(result)).toEqual({
      outcome: 'partial',
      copied: ['local/good.env'],
      skipped: [
        { path: '../outside.env', reason: 'invalid-path' },
        { path: 'local/link.env', reason: 'symlink' },
        { path: 'local/readme.md', reason: 'not-ignored' }
      ]
    })
  })

  it('reports missing literals and permission failures without concealing copied files', async () => {
    await writeFile(join(projectRoot, '.gitignore'), 'local/**\nmissing.env\n')
    await mkdir(join(projectRoot, 'local'))
    await writeFile(join(projectRoot, 'local', 'good.env'), 'good\n', { mode: 0o640 })
    await writeFile(join(projectRoot, 'local', 'private.env'), 'private\n')
    await chmod(join(projectRoot, 'local', 'private.env'), 0o000)
    await writeFile(
      join(projectRoot, '.worktreeinclude'),
      'local/good.env\nlocal/private.env\nmissing.env\n'
    )

    const result = await bootstrapWorktree({ projectRoot, checkoutRoot })

    await chmod(join(projectRoot, 'local', 'private.env'), 0o600)
    expect(withoutOrigin(result)).toEqual({
      outcome: 'partial',
      copied: ['local/good.env'],
      skipped: [
        { path: 'local/private.env', reason: 'permission-denied' },
        { path: 'missing.env', reason: 'missing' }
      ]
    })
    expect((await stat(join(checkoutRoot, 'local', 'good.env'))).mode & 0o777).toBe(0o640)
    expect((await stat(join(checkoutRoot, 'local'))).mode & 0o777).toBe(0o700)
    await expect(lstat(join(checkoutRoot, 'local', 'private.env'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})

describe('carrying the Project’s ignored directories', () => {
  it('carries every ignored directory Git reports, nested ones included', async () => {
    await writeFile(join(projectRoot, '.gitignore'), '.env*\nnode_modules/\ndist/\n')
    await writeFile(join(projectRoot, '.env.local'), 'local secret\n')
    await mkdir(join(projectRoot, 'node_modules', 'left-pad'), { recursive: true })
    await writeFile(join(projectRoot, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1\n')
    await mkdir(join(projectRoot, 'packages', 'web', 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(projectRoot, 'packages', 'web', 'node_modules', 'dep', 'dep.js'), 'dep\n')
    await writeFile(join(projectRoot, 'packages', 'web', 'index.ts'), 'export const web = 1\n')
    await mkdir(join(projectRoot, 'dist'))
    await writeFile(join(projectRoot, 'dist', 'bundle.js'), 'bundle\n')
    await git('git', ['add', 'packages/web/index.ts'], { cwd: projectRoot })

    const result = await bootstrapWorktree({ projectRoot, checkoutRoot })

    expect(withoutOrigin(result)).toEqual({
      outcome: 'partial',
      copied: ['.env.local', 'dist/', 'node_modules/', 'packages/web/node_modules/'],
      skipped: [{ path: '.env.tracked', reason: 'tracked' }]
    })
    await expect(
      readFile(join(checkoutRoot, 'node_modules', 'left-pad', 'index.js'), 'utf8')
    ).resolves.toBe('module.exports=1\n')
    await expect(
      readFile(join(checkoutRoot, 'packages', 'web', 'node_modules', 'dep', 'dep.js'), 'utf8')
    ).resolves.toBe('dep\n')
    await expect(lstat(join(checkoutRoot, 'packages', 'web', 'index.ts'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('lets a .worktreeinclude name a directory, and still replaces the default set', async () => {
    await writeFile(join(projectRoot, '.gitignore'), '.env*\nnode_modules/\nvendor/\n')
    await writeFile(join(projectRoot, '.env.local'), 'local secret\n')
    await mkdir(join(projectRoot, 'vendor', 'gem'), { recursive: true })
    await writeFile(join(projectRoot, 'vendor', 'gem', 'gem.rb'), 'gem\n')
    await mkdir(join(projectRoot, 'node_modules'))
    await writeFile(join(projectRoot, 'node_modules', 'index.js'), 'nope\n')
    await writeFile(join(projectRoot, '.worktreeinclude'), 'vendor\n')

    const result = await bootstrapWorktree({ projectRoot, checkoutRoot })

    expect(withoutOrigin(result)).toEqual({ outcome: 'copied', copied: ['vendor/'], skipped: [] })
    await expect(readFile(join(checkoutRoot, 'vendor', 'gem', 'gem.rb'), 'utf8')).resolves.toBe(
      'gem\n'
    )
    await expect(lstat(join(checkoutRoot, 'node_modules'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(lstat(join(checkoutRoot, '.env.local'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the symlinks inside a cloned directory, including ones leaving the Project', async () => {
    const store = await mkdtemp(join(tmpdir(), 'bootstrap-store-'))
    try {
      await mkdir(join(store, 'left-pad'), { recursive: true })
      await writeFile(join(store, 'left-pad', 'index.js'), 'module.exports = "from the store"\n')
      await writeFile(
        join(store, 'left-pad', 'package.json'),
        '{"name":"left-pad","version":"1.0.0","main":"index.js"}\n'
      )
      await writeFile(join(projectRoot, '.gitignore'), '.env*\nnode_modules/\n')
      await mkdir(join(projectRoot, 'node_modules', '.pnpm', 'left-pad@1'), { recursive: true })
      await symlink(
        join(store, 'left-pad'),
        join(projectRoot, 'node_modules', '.pnpm', 'left-pad@1', 'left-pad')
      )
      await symlink(
        join('.pnpm', 'left-pad@1', 'left-pad'),
        join(projectRoot, 'node_modules', 'left-pad')
      )

      const result = await bootstrapWorktree({ projectRoot, checkoutRoot })

      expect(withoutOrigin(result)).toEqual({
        outcome: 'partial',
        copied: ['node_modules/'],
        skipped: [{ path: '.env.tracked', reason: 'tracked' }]
      })
      const carried = join(checkoutRoot, 'node_modules', 'left-pad')
      expect((await lstat(carried)).isSymbolicLink()).toBe(true)
      expect(await readlink(carried)).toBe(join('.pnpm', 'left-pad@1', 'left-pad'))
      // Resolved the way the Run's toolchain would, with no install first.
      const resolved = await execute(process.execPath, ['-p', 'require("left-pad")'], {
        cwd: checkoutRoot
      })
      expect(resolved.stdout.trim()).toBe('from the store')
    } finally {
      await rm(store, { recursive: true, force: true })
    }
  })

  it('never carries a directory Git does not report as ignored', async () => {
    await writeFile(join(projectRoot, '.gitignore'), '.env*\ncache/*.bin\n')
    await mkdir(join(projectRoot, 'cache'))
    await writeFile(join(projectRoot, 'cache', 'warm.bin'), 'warm\n')
    await writeFile(join(projectRoot, 'cache', 'notes.md'), 'notes\n')
    await writeFile(join(projectRoot, '.worktreeinclude'), 'cache\ncache/**\n')

    const result = await bootstrapWorktree({ projectRoot, checkoutRoot })

    expect(withoutOrigin(result)).toEqual({
      outcome: 'partial',
      copied: ['cache/warm.bin'],
      skipped: [
        { path: 'cache', reason: 'not-ignored' },
        { path: 'cache/notes.md', reason: 'not-ignored' }
      ]
    })
    await expect(lstat(join(checkoutRoot, 'cache', 'notes.md'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('carries a directory’s files one by one when an exclusion names something inside it', async () => {
    await writeFile(join(projectRoot, '.gitignore'), '.env*\nnode_modules/\n')
    await mkdir(join(projectRoot, 'node_modules', 'left-pad'), { recursive: true })
    await writeFile(join(projectRoot, 'node_modules', 'left-pad', 'index.js'), 'kept\n')
    await mkdir(join(projectRoot, 'node_modules', '.cache'), { recursive: true })
    await writeFile(join(projectRoot, 'node_modules', '.cache', 'huge.bin'), 'refused\n')
    await writeFile(
      join(projectRoot, '.worktreeinclude'),
      'node_modules\nnode_modules/**\n!node_modules/.cache/**\n'
    )

    const result = await bootstrapWorktree({ projectRoot, checkoutRoot })

    expect(withoutOrigin(result)).toEqual({
      outcome: 'copied',
      copied: ['node_modules/left-pad/index.js'],
      skipped: []
    })
    await expect(lstat(join(checkoutRoot, 'node_modules', '.cache'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('still carries a directory whole when an exclusion names no directory', async () => {
    await writeFile(join(projectRoot, '.gitignore'), '.env*\nnode_modules/\n')
    await mkdir(join(projectRoot, 'node_modules', 'left-pad'), { recursive: true })
    await writeFile(join(projectRoot, 'node_modules', 'left-pad', 'index.js'), 'kept\n')
    await writeFile(join(projectRoot, 'node_modules', 'debug.log'), 'noise\n')
    await writeFile(join(projectRoot, '.worktreeinclude'), 'node_modules\n!*.log\n')

    const result = await bootstrapWorktree({ projectRoot, checkoutRoot })

    expect(withoutOrigin(result)).toEqual({
      outcome: 'copied',
      copied: ['node_modules/'],
      skipped: []
    })
    // The exclusion applies to files it names, and does not reach inside a
    // directory carried whole — which is what keeps the clone worth having.
    await expect(readFile(join(checkoutRoot, 'node_modules', 'debug.log'), 'utf8')).resolves.toBe(
      'noise\n'
    )
  })

  it('clones a large directory rather than copying its bytes', async () => {
    await writeFile(join(projectRoot, '.gitignore'), '.env*\nnode_modules/\n')
    await mkdir(join(projectRoot, 'node_modules'))
    const megabyte = randomBytes(1024 * 1024)
    const handle = await open(join(projectRoot, 'node_modules', 'big.bin'), 'w')
    try {
      for (let written = 0; written < LARGE_DIRECTORY_MB; written++) await handle.write(megabyte)
    } finally {
      await handle.close()
    }

    const before = await freeBytes(checkoutRoot)
    const result = await bootstrapWorktree({ projectRoot, checkoutRoot })
    const spent = before - (await freeBytes(checkoutRoot))

    expect(withoutOrigin(result)).toEqual({
      outcome: 'partial',
      copied: ['node_modules/'],
      skipped: [{ path: '.env.tracked', reason: 'tracked' }]
    })
    expect((await stat(join(checkoutRoot, 'node_modules', 'big.bin'))).size).toBe(
      LARGE_DIRECTORY_MB * 1024 * 1024
    )
    // A byte copy would have spent every one of those megabytes.
    expect(spent).toBeLessThan((LARGE_DIRECTORY_MB / 4) * 1024 * 1024)
  })

  it('leaves no half-cloned directory behind when the clone fails partway', async () => {
    await writeFile(join(projectRoot, '.gitignore'), '.env*\nnode_modules/\n')
    await mkdir(join(projectRoot, 'node_modules', 'left-pad'), { recursive: true })
    await writeFile(join(projectRoot, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1\n')
    await mkdir(join(projectRoot, 'node_modules', 'locked'))
    await writeFile(join(projectRoot, 'node_modules', 'locked', 'inner.js'), 'unreadable\n')
    await chmod(join(projectRoot, 'node_modules', 'locked'), 0o000)

    const result = await bootstrapWorktree({ projectRoot, checkoutRoot })

    await chmod(join(projectRoot, 'node_modules', 'locked'), 0o700)
    expect(withoutOrigin(result)).toEqual({
      outcome: 'skipped',
      copied: [],
      skipped: [
        { path: '.env.tracked', reason: 'tracked' },
        { path: 'node_modules/', reason: 'permission-denied' }
      ]
    })
    // The readable half made it across before the failure; none of it stays,
    // because half a dependency tree reads as installed.
    await expect(lstat(join(checkoutRoot, 'node_modules'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})

describe('saying what a Checkout was bootstrapped from', () => {
  it('names the Project’s commit, the branch it was on, and when', async () => {
    await writeFile(join(projectRoot, '.env.local'), 'local secret\n')
    const at = new Date('2026-08-10T04:32:19.000Z')

    const result = await bootstrapWorktree({ projectRoot, checkoutRoot, now: () => at })

    expect(result.provenance).toEqual({
      commit: await head(projectRoot),
      branch: 'main',
      at: '2026-08-10T04:32:19.000Z'
    })
    expect(result.copied).toEqual(['.env.local'])
  })

  it('reports the commit and no branch when the Project is detached', async () => {
    const commit = await head(projectRoot)
    await git('git', ['checkout', '--quiet', '--detach', commit], { cwd: projectRoot })

    const result = await bootstrapWorktree({ projectRoot, checkoutRoot })

    expect(result.provenance).toMatchObject({ commit, branch: null })
  })

  // Unknown, and said so — never mistaken for a Checkout nothing was carried
  // into, which is a Session with no result at all rather than one with no
  // origin.
  it('reports no origin for a Project Git cannot answer for', async () => {
    const notARepository = await mkdtemp(join(tmpdir(), 'bootstrap-bare-'))
    try {
      const result = await bootstrapWorktree({ projectRoot: notARepository, checkoutRoot })

      expect(result).toEqual({
        outcome: 'skipped',
        copied: [],
        skipped: [{ path: '.worktreeinclude', reason: 'copy-failed' }],
        provenance: null
      })
    } finally {
      await rm(notARepository, { recursive: true, force: true })
    }
  })
})

/** The Project's HEAD, as Git itself writes it. */
async function head(root: string): Promise<string> {
  const { stdout } = await git('git', ['rev-parse', 'HEAD'], { cwd: root })
  return stdout.trim()
}

/**
 * What the bootstrap carried, without where it came from: provenance holds a
 * clock reading and the Project's HEAD, and the tests about what is carried
 * are not about either. The ones that are assert on it directly.
 */
function withoutOrigin(
  result: WorktreeBootstrapResult
): Omit<WorktreeBootstrapResult, 'provenance'> {
  const { provenance: _provenance, ...rest } = result
  return rest
}

const execute = promisify(execFile)

/** Big enough that a byte copy is unmistakable in the free-space reading. */
const LARGE_DIRECTORY_MB = 256

async function freeBytes(path: string): Promise<number> {
  const filesystem = await statfs(path)
  return filesystem.bfree * filesystem.bsize
}
