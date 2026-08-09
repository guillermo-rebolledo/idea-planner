import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import {
  type GitHubOptions,
  GitHubPullRequests,
  decodePullRequests,
  githubProcessLayer
} from './github'
import { PullRequestStore } from './pull-request-store'

const scratch: string[] = []

function github(options: GitHubOptions): Promise<GitHubPullRequests> {
  return Effect.runPromise(
    GitHubPullRequests.make.pipe(Effect.provide(githubProcessLayer(options)))
  )
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('GitHub pull requests', () => {
  it('lists repositories for the authenticated account and tolerates missing descriptions', async () => {
    const client = await github({
      run: vi
        .fn()
        .mockResolvedValueOnce({ stdout: 'gh version 2.80.0\n', stderr: '' })
        .mockResolvedValueOnce({
          stdout: '{"hosts":{"github.com":[{"active":true,"state":"success"}]}}',
          stderr: ''
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            [
              {
                full_name: 'example/private-project',
                description: null,
                private: true,
                updated_at: '2026-08-09T12:00:00Z'
              }
            ]
          ]),
          stderr: ''
        })
    })

    await expect(Effect.runPromise(client.repositories('/home'))).resolves.toEqual({
      status: 'ready',
      repositories: [
        {
          nameWithOwner: 'example/private-project',
          description: '',
          private: true,
          updatedAt: '2026-08-09T12:00:00.000Z'
        }
      ]
    })
  })

  it('reports malformed repository output without crashing the GitHub client', async () => {
    const client = await github({
      run: vi
        .fn()
        .mockResolvedValueOnce({ stdout: 'gh version 2.80.0\n', stderr: '' })
        .mockResolvedValueOnce({
          stdout: '{"hosts":{"github.com":[{"state":"success"}]}}',
          stderr: ''
        })
        .mockResolvedValueOnce({ stdout: 'not json', stderr: '' })
    })

    await expect(Effect.runPromise(client.repositories('/home'))).resolves.toEqual({
      status: 'failed',
      detail: 'GitHub returned an unreadable repository list.'
    })
  })

  it('keeps valid gh list entries when another entry has drifted', () => {
    expect(
      decodePullRequests(
        JSON.stringify([
          { nope: true },
          {
            number: 7,
            title: 'A useful change',
            url: 'https://github.com/example/argos/pull/7',
            state: 'CLOSED',
            mergedAt: '2026-08-07T12:00:00Z'
          }
        ])
      )
    ).toEqual([
      {
        number: 7,
        title: 'A useful change',
        url: 'https://github.com/example/argos/pull/7',
        state: 'merged'
      }
    ])
  })

  it('distinguishes an unavailable gh executable from missing authentication', async () => {
    const unavailable = await github({
      run: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }))
    })
    await expect(Effect.runPromise(unavailable.readiness('/checkout'))).resolves.toEqual({
      status: 'unavailable',
      detail: 'Install the GitHub CLI, then try again.'
    })

    const unauthenticated = await github({
      run: vi
        .fn()
        .mockResolvedValueOnce({ stdout: 'gh version 2.80.0\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '{"hosts":{}}', stderr: '' })
    })
    await expect(Effect.runPromise(unauthenticated.readiness('/checkout'))).resolves.toEqual({
      status: 'unauthenticated',
      detail: 'Run gh auth login in your terminal, then try again.'
    })

    const brokenActiveAccount = await github({
      run: vi
        .fn()
        .mockResolvedValueOnce({ stdout: 'gh version 2.80.0\n', stderr: '' })
        .mockResolvedValueOnce({
          stdout: '{"hosts":{"github.com":[{"active":true,"state":"failure"}]}}',
          stderr: ''
        })
    })
    await expect(
      Effect.runPromise(brokenActiveAccount.readiness('/checkout'))
    ).resolves.toMatchObject({
      status: 'unauthenticated'
    })

    const unexpectedFailure = await github({
      run: vi
        .fn()
        .mockResolvedValueOnce({ stdout: 'gh version 2.80.0\n', stderr: '' })
        .mockRejectedValueOnce(Object.assign(new Error('timed out'), { stderr: '' }))
    })
    await expect(Effect.runPromise(unexpectedFailure.readiness('/checkout'))).resolves.toEqual({
      status: 'unknown',
      detail: 'timed out'
    })
  })

  it('commits, pushes, and creates with an ephemeral body file', async () => {
    const calls: { command: string; args: string[]; cwd: string }[] = []
    const client = await github({
      run: vi.fn(async (command: string, args: string[], options: { cwd: string }) => {
        await Promise.resolve()
        calls.push({ command, args, cwd: options.cwd })
        const signature = `${command} ${args.join(' ')}`
        if (signature === 'git symbolic-ref --short --quiet HEAD') {
          return { stdout: 'feature/github\n', stderr: '' }
        }
        if (signature === 'git status --porcelain=v1 -z') {
          return { stdout: ' M app.ts\0', stderr: '' }
        }
        if (signature === 'git write-tree') {
          return { stdout: '1111111111111111111111111111111111111111\n', stderr: '' }
        }
        if (signature.startsWith('git rev-parse --abbrev-ref')) {
          throw Object.assign(new Error('no upstream'), { stderr: 'fatal: no upstream' })
        }
        if (signature.startsWith('gh pr list')) return { stdout: '[]', stderr: '' }
        if (signature.startsWith('gh pr create')) {
          return { stdout: 'https://github.com/example/argos/pull/9\n', stderr: '' }
        }
        if (signature.startsWith('gh pr view')) {
          return {
            stdout:
              '{"number":9,"title":"Ship GitHub","url":"https://github.com/example/argos/pull/9","state":"OPEN","mergedAt":null}',
            stderr: ''
          }
        }
        return { stdout: '', stderr: '' }
      })
    })

    const result = await Effect.runPromise(
      client.create({
        checkout: '/worktree',
        baseBranch: 'main',
        title: 'Ship GitHub',
        body: '## Summary\n\n- Ship it\n\n## Testing\n\n- Unit tests',
        publishMode: 'worktree',
        expectedTree: null
      })
    )

    expect(result).toEqual({
      status: 'created',
      pullRequest: {
        number: 9,
        title: 'Ship GitHub',
        url: 'https://github.com/example/argos/pull/9',
        state: 'open'
      }
    })
    expect(calls.map(({ command, args }) => [command, ...args])).toContainEqual([
      'git',
      'push',
      '--set-upstream',
      'origin',
      'HEAD'
    ])
    const create = calls.find(
      ({ command, args }) => command === 'gh' && args[0] === 'pr' && args[1] === 'create'
    )
    expect(create?.args).toContain('--body-file')
    if (result.status === 'failed') throw new Error(result.detail)
    expect(create?.args).not.toContain(result.pullRequest.title + result.pullRequest.url)
  })

  it('unstages and refuses when a Local Checkout no longer matches the reviewed tree', async () => {
    const calls: string[] = []
    const client = await github({
      run: vi.fn(async (command: string, args: string[]) => {
        await Promise.resolve()
        const signature = `${command} ${args.join(' ')}`
        calls.push(signature)
        if (signature === 'git symbolic-ref --short --quiet HEAD') {
          return { stdout: 'feature/local\n', stderr: '' }
        }
        if (signature === 'git status --porcelain=v1 -z') {
          return { stdout: ' M app.ts\0', stderr: '' }
        }
        if (signature === 'git write-tree') {
          return { stdout: '2222222222222222222222222222222222222222\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      })
    })

    await expect(
      Effect.runPromise(
        client.create({
          checkout: '/local',
          baseBranch: 'main',
          title: 'Ship safely',
          body: 'Reviewed',
          publishMode: 'local',
          expectedTree: '1111111111111111111111111111111111111111'
        })
      )
    ).resolves.toEqual({
      status: 'failed',
      detail: 'The Local Checkout changed after this Pull Request was reviewed.'
    })
    expect(calls).toContain('git read-tree HEAD')
    expect(calls).not.toContain('git commit --message Ship safely')
    expect(calls.some((call) => call.startsWith('git push'))).toBe(false)
  })
})

describe('pull request persistence', () => {
  it('follows Session lifetime and rejects damaged records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pull-request-store-'))
    scratch.push(root)
    const store = new PullRequestStore(root)
    const pullRequest = {
      number: 12,
      title: 'Keep this',
      url: 'https://github.com/example/argos/pull/12',
      state: 'open' as const
    }

    await store.write('session/one', pullRequest)
    await expect(store.read('session/one')).resolves.toEqual(pullRequest)
    await store.write('orphan', { ...pullRequest, number: 13 })
    await store.pruneUnknown(new Set(['session/one']))
    await expect(store.read('orphan')).resolves.toBeNull()
    await store.forget('session/one')
    await expect(store.read('session/one')).resolves.toBeNull()
  })
})
