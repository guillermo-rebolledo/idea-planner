import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initRepository, resolveProjectRoot } from './git'

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
