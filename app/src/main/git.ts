import { execFile } from 'node:child_process'
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

function environment(options: GitOptions): NodeJS.ProcessEnv {
  return options.pathEnv === undefined ? process.env : { ...process.env, PATH: options.pathEnv }
}

/**
 * Distinguishes "this machine has no git" from "this folder is not a
 * repository", which the two are kept apart for deliberately (ADR 0005).
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
