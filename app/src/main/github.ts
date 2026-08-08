import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { Context, Data, Effect, Layer } from 'effect'
import {
  pullRequestSchema,
  type CreatePullRequestResult,
  type PullRequest
} from '@shared/pull-request'

const exec = promisify(execFile)
const JSON_FIELDS = 'number,title,url,state,mergedAt,isDraft'
const TIMEOUT_MS = 120_000

interface ProcessResult {
  stdout: string
  stderr: string
}

interface ProcessOptions {
  cwd: string
  timeout?: number
  env?: NodeJS.ProcessEnv
}

export type ProcessRunner = (
  command: string,
  args: string[],
  options: ProcessOptions
) => Promise<ProcessResult>

export interface GitHubOptions {
  run?: ProcessRunner
  pathEnv?: string
}

class GitHubCommandError extends Data.TaggedError('GitHubCommandError')<{
  cause: unknown
}> {}

interface GitHubProcessService {
  execute(
    command: string,
    args: string[],
    cwd: string
  ): Effect.Effect<ProcessResult, GitHubCommandError>
}

export class GitHubProcess extends Context.Tag('argos/GitHubProcess')<
  GitHubProcess,
  GitHubProcessService
>() {}

const ghPullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  url: z.string().url(),
  state: z.string(),
  mergedAt: z.string().nullable().optional(),
  isDraft: z.boolean().optional()
})

function toPullRequest(value: z.infer<typeof ghPullRequestSchema>): PullRequest {
  const state = value.state.trim().toUpperCase()
  return pullRequestSchema.parse({
    number: value.number,
    title: value.title,
    url: value.url,
    state:
      value.mergedAt || state === 'MERGED'
        ? 'merged'
        : state === 'CLOSED'
          ? 'closed'
          : value.isDraft
            ? 'draft'
            : 'open'
  })
}

/** Decode each list entry independently so one version-drifted result cannot blank the list. */
export function decodePullRequests(text: string): PullRequest[] {
  let values: unknown
  try {
    values = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(values)) return []
  return values.flatMap((value) => {
    const parsed = ghPullRequestSchema.safeParse(value)
    return parsed.success ? [toPullRequest(parsed.data)] : []
  })
}

function decodePullRequest(text: string): PullRequest | null {
  try {
    const parsed = ghPullRequestSchema.safeParse(JSON.parse(text))
    return parsed.success ? toPullRequest(parsed.data) : null
  } catch {
    return null
  }
}

/** Removes the credential-bearing parts forge CLIs can echo before text crosses IPC. */
export function safeGitHubDetail(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value)
  const withoutUrlSecrets = raw.replace(/https?:\/\/[^\s/@:]+(?::[^\s/@]*)?@[^\s]+/giu, (match) => {
    try {
      const url = new URL(match)
      url.username = ''
      url.password = ''
      url.search = ''
      url.hash = ''
      return url.toString()
    } catch {
      return 'a GitHub remote'
    }
  })
  return (
    withoutUrlSecrets
      .replace(/[?#][^\s]*/gu, '')
      .trim()
      .slice(0, 500) || 'GitHub failed'
  )
}

function processErrorText(error: unknown): string {
  if (typeof error !== 'object' || error === null) return safeGitHubDetail(error)
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : ''
  return safeGitHubDetail(stderr || error)
}

function isMissingExecutable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function authSucceeded(text: string): boolean {
  try {
    const parsed = z.object({ hosts: z.record(z.unknown()) }).safeParse(JSON.parse(text))
    if (!parsed.success) return false
    return Object.values(parsed.data.hosts).some(
      (accounts) =>
        Array.isArray(accounts) &&
        accounts.some((account: unknown) => {
          if (typeof account !== 'object' || account === null) return false
          const fields = account as Record<string, unknown>
          return String(fields['state']).toLowerCase() === 'success'
        })
    )
  } catch {
    return false
  }
}

function isAuthenticationFailure(error: unknown): boolean {
  const detail = processErrorText(error).toLowerCase()
  return (
    detail.includes('gh auth login') ||
    detail.includes('not logged in') ||
    detail.includes('authentication failed') ||
    detail.includes('unauthorized') ||
    detail.includes('no oauth token')
  )
}

const defaultRun: ProcessRunner = async (command, args, options) => {
  const result = await exec(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout ?? TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    encoding: 'utf8'
  })
  return { stdout: result.stdout, stderr: result.stderr }
}

export function githubProcessLayer(options: GitHubOptions = {}): Layer.Layer<GitHubProcess> {
  const run = options.run ?? defaultRun
  return Layer.succeed(GitHubProcess, {
    execute: (command, args, cwd) =>
      Effect.tryPromise({
        try: () =>
          run(command, args, {
            cwd,
            timeout: TIMEOUT_MS,
            env:
              options.pathEnv === undefined
                ? process.env
                : { ...process.env, PATH: options.pathEnv }
          }),
        catch: (cause) => new GitHubCommandError({ cause })
      })
  })
}

export type GitHubReadiness =
  { status: 'ready' } | { status: 'unavailable' | 'unauthenticated' | 'unknown'; detail: string }

export interface PublishPullRequestCommand {
  checkout: string
  baseBranch: string
  title: string
  body: string
}

export interface GitHubClient {
  readiness(cwd: string): Effect.Effect<GitHubReadiness>
  defaultBranch(cwd: string): Effect.Effect<string | null>
  create(input: PublishPullRequestCommand): Effect.Effect<CreatePullRequestResult>
  get(cwd: string, reference: string): Effect.Effect<PullRequest | null>
}

/** Permanent GitHub transport: the person's `gh` credentials stay owned by `gh`. */
export class GitHubPullRequests implements GitHubClient {
  private constructor(private readonly process: GitHubProcessService) {}

  static readonly make = Effect.map(GitHubProcess, (process) => new GitHubPullRequests(process))

  static readonly live = GitHubPullRequests.make.pipe(Effect.provide(githubProcessLayer()))

  readiness(cwd: string): Effect.Effect<GitHubReadiness> {
    const auth = this.execute('gh', ['auth', 'status', '--json', 'hosts'], cwd).pipe(
      Effect.map((result): GitHubReadiness =>
        authSucceeded(result.stdout)
          ? { status: 'ready' }
          : {
              status: 'unauthenticated',
              detail: 'Run gh auth login in your terminal, then try again.'
            }
      ),
      Effect.catchAll((error) =>
        Effect.succeed(
          isAuthenticationFailure(error.cause)
            ? {
                status: 'unauthenticated' as const,
                detail: 'Run gh auth login in your terminal, then try again.'
              }
            : { status: 'unknown' as const, detail: processErrorText(error.cause) }
        )
      )
    )
    return this.execute('gh', ['--version'], cwd).pipe(
      Effect.flatMap(() => auth),
      Effect.catchAll((error) =>
        Effect.succeed(
          isMissingExecutable(error.cause)
            ? {
                status: 'unavailable' as const,
                detail: 'Install the GitHub CLI, then try again.'
              }
            : { status: 'unknown' as const, detail: processErrorText(error.cause) }
        )
      )
    )
  }

  defaultBranch(cwd: string): Effect.Effect<string | null> {
    return this.execute(
      'gh',
      ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
      cwd
    ).pipe(
      Effect.map((result) => result.stdout.trim() || null),
      Effect.catchAll(() => Effect.succeed(null))
    )
  }

  create(input: PublishPullRequestCommand): Effect.Effect<CreatePullRequestResult> {
    const execute = this.execute.bind(this)
    const list = this.list.bind(this)
    const get = this.get.bind(this)
    return Effect.gen(function* () {
      const branch = (yield* execute(
        'git',
        ['symbolic-ref', '--short', '--quiet', 'HEAD'],
        input.checkout
      )).stdout.trim()
      if (!branch) {
        return { status: 'failed' as const, detail: 'The Checkout has no branch to publish.' }
      }

      const dirty = (yield* execute('git', ['status', '--porcelain=v1', '-z'], input.checkout))
        .stdout.length
      if (dirty > 0) {
        yield* execute('git', ['add', '--all'], input.checkout)
        yield* execute('git', ['commit', '--message', input.title], input.checkout)
      }

      const hasUpstream = yield* execute(
        'git',
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        input.checkout
      ).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
      yield* execute(
        'git',
        hasUpstream ? ['push'] : ['push', '--set-upstream', 'origin', 'HEAD'],
        input.checkout
      )

      const existing = yield* list(input.checkout, branch, 'open')
      if (existing[0]) return { status: 'opened-existing' as const, pullRequest: existing[0] }

      return yield* Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => mkdtemp(join(tmpdir(), 'argos-pr-body-')),
          catch: (cause) => new GitHubCommandError({ cause })
        }),
        (directory) =>
          Effect.gen(function* () {
            const bodyFile = join(directory, 'body.md')
            yield* Effect.tryPromise({
              try: () => writeFile(bodyFile, input.body, { mode: 0o600 }),
              catch: (cause) => new GitHubCommandError({ cause })
            })
            const created = yield* execute(
              'gh',
              [
                'pr',
                'create',
                '--base',
                input.baseBranch,
                '--head',
                branch,
                '--title',
                input.title,
                '--body-file',
                bodyFile
              ],
              input.checkout
            )
            const reference = created.stdout.trim()
            const pullRequest = reference ? yield* get(input.checkout, reference) : null
            return pullRequest
              ? { status: 'created' as const, pullRequest }
              : {
                  status: 'failed' as const,
                  detail: 'GitHub created the PR but its details were unreadable.'
                }
          }),
        (directory) =>
          Effect.promise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.orDie)
      )
    }).pipe(
      Effect.catchAll((error) =>
        Effect.succeed({ status: 'failed' as const, detail: processErrorText(error.cause) })
      )
    )
  }

  get(cwd: string, reference: string): Effect.Effect<PullRequest | null> {
    return this.execute('gh', ['pr', 'view', reference, '--json', JSON_FIELDS], cwd).pipe(
      Effect.map((result) => decodePullRequest(result.stdout)),
      Effect.catchAll(() => Effect.succeed(null))
    )
  }

  list(cwd: string, head: string, state: 'open' | 'all'): Effect.Effect<PullRequest[]> {
    return this.execute(
      'gh',
      ['pr', 'list', '--head', head, '--state', state, '--limit', '20', '--json', JSON_FIELDS],
      cwd
    ).pipe(
      Effect.map((result) => decodePullRequests(result.stdout)),
      Effect.catchAll(() => Effect.succeed([]))
    )
  }

  private execute(
    command: string,
    args: string[],
    cwd: string
  ): Effect.Effect<ProcessResult, GitHubCommandError> {
    return this.process.execute(command, args, cwd)
  }
}
