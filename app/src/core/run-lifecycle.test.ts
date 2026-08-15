import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type Core } from './core'

let stateDirectory: string
let projectRoot: string
let core: Core

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'run-lifecycle-state-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'run-lifecycle-project-'))
  let id = 0
  core = createCore({
    stateDirectory,
    now: () => new Date('2026-08-06T12:00:00.000Z'),
    randomId: () => `id-${++id}`
  })
  await core.addProject(projectRoot)
})

afterEach(async () => {
  await rm(stateDirectory, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

function opening(sessionId: string) {
  return {
    submissionId: 'submission-1',
    sessionId,
    prompt: 'Implement the durable lifecycle',
    configuration: {
      harness: 'codex' as const,
      executable: '/opt/codex',
      executableHash: 'c'.repeat(64),
      harnessVersion: 'codex-cli 0.146.0',
      model: 'gpt-5',
      effort: 'high',
      skill: null,
      environment: { LANG: 'en_US.UTF-8' },
      checkout: projectRoot,
      permissionMode: 'ask' as const
    },
    askedPermissionMode: 'on-request'
  }
}

describe('durable Run lifecycle', () => {
  it('opens one Run and Conversation boundary under duplicate delivery', async () => {
    const session = await core.startSession({ projectRoot, message: 'Start here' })

    const first = await core.openRunLifecycle(opening(session.id))
    const duplicate = await core.openRunLifecycle(opening(session.id))

    expect(duplicate).toEqual(first)
    expect(first.run).toMatchObject({ status: 'accepted', submissionId: 'submission-1' })
    expect(
      first.conversation.entries.filter(
        (entry) => entry.kind === 'boundary' && entry.boundary === 'run-started'
      )
    ).toHaveLength(1)
  })

  it('opens a Run in the isolated Checkout its Session was fixed to', async () => {
    const worktree = join(stateDirectory, 'worktrees', 'implement-the-lifecycle')
    const session = await core.startSession({
      projectRoot,
      message: 'Start here',
      checkout: { kind: 'worktree', path: worktree, baseBranch: 'trunk' }
    })

    const opened = await core.openRunLifecycle({
      ...opening(session.id),
      configuration: { ...opening(session.id).configuration, checkout: worktree }
    })

    expect(opened.run.configuration.checkout).toBe(worktree)
    // And still only its own: the Project's working copy is a directory this
    // Session was deliberately kept out of.
    await expect(core.openRunLifecycle(opening(session.id))).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
  })

  it('repairs a derived Run after interruption behind the canonical opening boundary', async () => {
    const session = await core.startSession({ projectRoot, message: 'Start here' })
    const runsPath = join(stateDirectory, 'sessions', session.id, 'runs')
    await writeFile(runsPath, 'blocks the derived Run write')

    await expect(core.openRunLifecycle(opening(session.id))).rejects.toMatchObject({
      code: 'IO_ERROR'
    })
    await rm(runsPath)

    const repaired = await core.openRunLifecycle(opening(session.id))
    expect(
      repaired.conversation.entries.filter(
        (entry) => entry.kind === 'boundary' && entry.boundary === 'run-started'
      )
    ).toHaveLength(1)
  })

  it('completes Run, Conversation, Checkout observation, and queue decision durably', async () => {
    const session = await core.startSession({ projectRoot, message: 'Start here' })
    await core.changeQueuedSubmissions({
      type: 'enqueue',
      input: {
        sessionId: session.id,
        submissionId: 'submission-queued',
        text: 'Continue with the next task',
        source: 'composer',
        harness: 'codex',
        model: 'gpt-5',
        effort: 'high',
        permissionMode: 'ask',
        reviewAttachments: []
      }
    })
    const opened = await core.openRunLifecycle(opening(session.id))
    await core.recordRunEvent({
      sessionId: session.id,
      runId: opened.run.id,
      status: 'starting',
      kind: 'lifecycle',
      summary: 'Starting the Harness'
    })
    await core.recordRunEvent({
      sessionId: session.id,
      runId: opened.run.id,
      status: 'running',
      kind: 'lifecycle',
      summary: 'Harness process running'
    })

    const input = {
      sessionId: session.id,
      runId: opened.run.id,
      observation: {
        type: 'harness-completed' as const,
        kind: 'lifecycle' as const,
        summary: 'Harness completed the turn'
      },
      checkoutObservation: {
        status: 'observed' as const,
        changes: [
          {
            path: 'src/example.ts',
            changeKind: 'added' as const,
            diff: '@@ -0,0 +1 @@\n+export const answer = 42\n'
          }
        ]
      }
    }

    const [completed, duplicate] = await Promise.all([
      core.completeRunLifecycle(input),
      core.completeRunLifecycle(input)
    ])

    expect(duplicate).toEqual(completed)
    expect(completed.run.status).toBe('completed')
    expect(completed.conversation.activeRunId).toBeNull()
    expect(completed.conversation.changedFiles).toEqual([
      expect.objectContaining({ path: 'src/example.ts', reported: false })
    ])
    expect(completed.queueDisposition).toBe('advance')
    expect(
      completed.conversation.entries.filter(
        (entry) => entry.kind === 'boundary' && entry.boundary === 'run-completed'
      )
    ).toHaveLength(1)
    const endingIndex = completed.conversation.entries.findIndex(
      (entry) => entry.kind === 'boundary' && entry.id === `boundary:${opened.run.id}:ended`
    )
    const checkoutIndex = completed.conversation.entries.findIndex(
      (entry) => entry.kind === 'file-change' && entry.runId === opened.run.id
    )
    expect(endingIndex).toBeLessThan(checkoutIndex)
    await expect(
      core.completeRunLifecycle({
        ...input,
        observation: { ...input.observation, summary: 'A contradictory duplicate' }
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it.each([
    ['failed', 'error', 'Harness process failed'],
    ['stopped', 'lifecycle', 'The person stopped the Harness'],
    ['policy-violation', 'blocked', 'Run stopped by policy'],
    ['supervision-failed', 'error', 'Native supervision failed']
  ] as const)(
    'concludes %s through one durable ending and pauses the queue',
    async (status, kind, summary) => {
      const session = await core.startSession({ projectRoot, message: 'Start here' })
      await core.changeQueuedSubmissions({
        type: 'enqueue',
        input: {
          sessionId: session.id,
          submissionId: 'submission-queued',
          text: 'Continue with the next task',
          source: 'composer',
          harness: 'codex',
          model: 'gpt-5',
          effort: 'high',
          permissionMode: 'ask',
          reviewAttachments: []
        }
      })
      const opened = await core.openRunLifecycle(opening(session.id))
      await core.recordRunEvent({
        sessionId: session.id,
        runId: opened.run.id,
        status: 'starting',
        kind: 'lifecycle',
        summary: 'Starting the Harness'
      })
      await core.recordRunEvent({
        sessionId: session.id,
        runId: opened.run.id,
        status: 'running',
        kind: 'lifecycle',
        summary: 'Harness process running'
      })
      const input = {
        sessionId: session.id,
        runId: opened.run.id,
        observation:
          status === 'failed'
            ? ({ type: 'harness-failed', kind, summary, category: 'process-crash' } as const)
            : status === 'stopped'
              ? ({ type: 'person-stopped', kind, summary } as const)
              : ({ type: status, kind, summary } as const),
        checkoutObservation: { status: 'unavailable' as const }
      }

      const concluded = await core.completeRunLifecycle(input)
      const duplicate = await core.completeRunLifecycle(input)

      expect(duplicate).toEqual(concluded)
      expect(concluded.run.status).toBe(status)
      expect(concluded.queueDisposition).toBe('pause')
      expect(concluded.conversation.queue.paused).toBe(true)
      expect(
        concluded.conversation.entries.filter(
          (entry) => entry.kind === 'boundary' && entry.id === `boundary:${opened.run.id}:ended`
        )
      ).toHaveLength(1)
      expect(
        concluded.conversation.entries.find(
          (entry) => entry.kind === 'boundary' && entry.id === `boundary:${opened.run.id}:ended`
        )
      ).toMatchObject({ checkoutObservation: 'unavailable', terminalOutcome: status })
    }
  )
})
