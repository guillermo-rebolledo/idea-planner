import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

    expect(result).toEqual({
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

    expect(result).toEqual({
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

    expect(result).toEqual({
      outcome: 'copied',
      copied: ['local/日本語/keep.env'],
      skipped: []
    })
  })

  it('does not turn a negation-only manifest into an include-everything pattern', async () => {
    await writeFile(join(projectRoot, '.env.local'), 'must stay local\n')
    await writeFile(join(projectRoot, '.worktreeinclude'), '!.env.local\n')

    await expect(bootstrapWorktree({ projectRoot, checkoutRoot })).resolves.toEqual({
      outcome: 'skipped',
      copied: [],
      skipped: []
    })
  })

  it('refuses symlinks and traversal patterns while retaining successful copies', async () => {
    await writeFile(join(projectRoot, '.gitignore'), 'local/**\n')
    await mkdir(join(projectRoot, 'local'))
    await writeFile(join(projectRoot, 'local', 'good.env'), 'good\n')
    await symlink(join(projectRoot, 'local', 'good.env'), join(projectRoot, 'local', 'link.env'))
    await writeFile(join(projectRoot, '.worktreeinclude'), 'local/**\n../outside.env\n')

    const result = await bootstrapWorktree({ projectRoot, checkoutRoot })

    expect(result).toEqual({
      outcome: 'partial',
      copied: ['local/good.env'],
      skipped: [
        { path: '../outside.env', reason: 'invalid-path' },
        { path: 'local/link.env', reason: 'symlink' }
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
    expect(result).toEqual({
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
