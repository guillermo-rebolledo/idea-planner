import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import { mailboxSnapshotSchema, type SessionSummary } from '@shared/contract'
import {
  buildPullRequestBody,
  makePullRequestService,
  type PullRequestService,
  type PullRequestServiceDependenciesShape
} from './pull-request-service'

const localSession: SessionSummary = {
  id: 'session-local',
  projectRoot: '/project',
  checkout: { kind: 'local' },
  worktreeBootstrap: null,
  title: 'Add GitHub publishing',
  createdAt: '2026-08-07T12:00:00.000Z',
  updatedAt: '2026-08-07T12:00:00.000Z',
  pinned: false,
  archivedAt: null
}

function makeService(
  dependencies: PullRequestServiceDependenciesShape
): Promise<PullRequestService> {
  return Effect.runPromise(makePullRequestService(dependencies))
}

describe('the Session pull request workflow', () => {
  it('builds bounded fallback prose from recorded files and the person’s messages', () => {
    expect(
      buildPullRequestBody('Publish GitHub support', {
        changedFiles: [
          {
            path: 'app/src/github.ts',
            changeKind: 'changed'
          }
        ],
        unlisted: 2,
        messages: ['Please add GitHub support.']
      })
    ).toContain('- Changed `app/src/github.ts`\n- 2 more changed files not listed')
  })

  it('prepares a Local Checkout only with a reviewed safety token', async () => {
    const service = await makeService({
      github: {
        readiness: vi.fn(() => Effect.succeed({ status: 'ready' })),
        defaultBranch: vi.fn(() => Effect.succeed('main'))
      } as never,
      store: {} as never,
      observeState: vi.fn().mockResolvedValue({ status: 'observed', state: 'clean' }),
      readBranch: vi.fn().mockResolvedValue('feature/local')
    })

    await expect(
      Effect.runPromise(
        service.prepare(localSession, {
          changedFiles: [],
          unlisted: 0,
          messages: [],
          localSafety: {
            status: 'safe',
            expectedTree: '1111111111111111111111111111111111111111'
          }
        })
      )
    ).resolves.toMatchObject({
      status: 'ready',
      publishMode: 'local',
      expectedTree: '1111111111111111111111111111111111111111'
    })
  })

  it('prepares an editable draft only for a clean Worktree Checkout', async () => {
    const service = await makeService({
      github: {
        readiness: vi.fn(() => Effect.succeed({ status: 'ready' })),
        defaultBranch: vi.fn(() => Effect.succeed('main'))
      } as never,
      store: {} as never,
      observeState: vi.fn().mockResolvedValue({ status: 'observed', state: 'clean' }),
      readBranch: vi.fn().mockResolvedValue('feature/github')
    })

    await expect(
      Effect.runPromise(
        service.prepare({
          ...localSession,
          id: 'session-worktree',
          checkout: { kind: 'worktree', path: '/worktree' }
        })
      )
    ).resolves.toEqual({
      status: 'ready',
      publishMode: 'worktree',
      expectedTree: null,
      baseBranch: 'main',
      headBranch: 'feature/github',
      title: 'Add GitHub publishing',
      body: '## Summary\n\n- Add GitHub publishing\n\n## Testing\n\n- Not run'
    })
  })

  it('targets the base chosen when the isolated Checkout was created', async () => {
    const defaultBranch = vi.fn()
    const service = await makeService({
      github: {
        readiness: vi.fn(() => Effect.succeed({ status: 'ready' })),
        defaultBranch
      } as never,
      store: {} as never,
      observeState: vi.fn().mockResolvedValue({ status: 'observed', state: 'clean' }),
      readBranch: vi.fn().mockResolvedValue('feature/github')
    })

    const result = await Effect.runPromise(
      service.prepare({
        ...localSession,
        checkout: { kind: 'worktree', path: '/worktree', baseBranch: 'release' }
      })
    )

    expect(result).toMatchObject({ status: 'ready', baseBranch: 'release' })
    expect(defaultBranch).not.toHaveBeenCalled()
  })

  it('refreshes tracked PRs at most every two minutes and retains the last known state', async () => {
    let now = 1_000
    const stored = {
      number: 3,
      title: 'Tracked',
      url: 'https://github.com/example/argos/pull/3',
      state: 'open' as const
    }
    const fresh = { ...stored, title: 'Tracked remotely' }
    const get = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed(fresh))
      .mockReturnValue(Effect.succeed(null))
    const write = vi.fn().mockResolvedValue(undefined)
    const service = await makeService({
      github: { get } as never,
      store: { read: vi.fn().mockResolvedValue(stored), write } as never,
      now: () => now
    })
    const session = {
      ...localSession,
      checkout: { kind: 'worktree' as const, path: '/worktree' },
      dormant: false,
      status: 'idle' as const,
      waitingFor: null,
      pullRequest: null
    }
    const snapshot = mailboxSnapshotSchema.parse({
      view: 'active',
      total: 1,
      matched: 1,
      pinned: [],
      projects: [{ root: '/project', name: 'project', available: true, sessions: [session] }],
      archivedTotal: 0
    })

    const first = await Effect.runPromise(service.attachToMailbox(snapshot))
    now += 60_000
    const cached = await Effect.runPromise(service.attachToMailbox(snapshot))
    now += 61_000
    const afterFailure = await Effect.runPromise(service.attachToMailbox(snapshot))

    expect(first.projects[0]?.sessions[0]?.pullRequest?.title).toBe('Tracked remotely')
    expect(cached.projects[0]?.sessions[0]?.pullRequest?.title).toBe('Tracked remotely')
    expect(afterFailure.projects[0]?.sessions[0]?.pullRequest?.title).toBe('Tracked remotely')
    expect(get).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenCalledOnce()
  })
})
