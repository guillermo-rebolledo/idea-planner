import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Checkout } from '@shared/contract'
import { createCore, type Core } from './core'
import { finishRunLifecycle } from './run-lifecycle-test-support'

/**
 * Which Projects have a Run working in their Local Checkout right now — the
 * observation the New Session composer's Checkout default is decided from
 * (ADR 0010). It is answered from the Conversation projection, so what it
 * says and what the inbox says cannot come apart.
 */

let stateDir: string
let projectRoot: string
let otherRoot: string
let core: Core

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'active-local-runs-state-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'active-local-runs-project-'))
  otherRoot = await mkdtemp(join(tmpdir(), 'active-local-runs-other-'))
  let n = 0
  core = createCore({
    stateDirectory: stateDir,
    now: () => new Date('2026-08-10T12:00:00.000Z'),
    randomId: () => `active-local-runs-${String(++n).padStart(4, '0')}`
  })
  await core.addProject(projectRoot)
  await core.addProject(otherRoot)
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
  await rm(otherRoot, { recursive: true, force: true })
})

async function start(root: string, message: string, checkout?: Checkout) {
  return core.startSession({ projectRoot: root, message, ...(checkout ? { checkout } : {}) })
}

/** Puts a Session mid-Run, as developing one does. */
async function beginRun(sessionId: string, checkout: string): Promise<string> {
  const opened = await core.openRunLifecycle({
    submissionId: `submission-${sessionId}`,
    sessionId,
    prompt: 'Change the greeting',
    configuration: {
      harness: 'claude',
      executable: '/usr/local/bin/claude',
      executableHash: 'a'.repeat(64),
      harnessVersion: '2.1.220 (Claude Code)',
      model: 'default',
      effort: 'medium',
      skill: null,
      environment: {},
      checkout,
      permissionMode: 'ask'
    }
  })
  await core.recordRunEvent({
    sessionId,
    runId: opened.run.id,
    status: 'starting',
    kind: 'lifecycle',
    summary: 'Starting the Harness'
  })
  await core.recordRunEvent({
    sessionId,
    runId: opened.run.id,
    status: 'running',
    kind: 'lifecycle',
    summary: 'Harness process running'
  })
  return opened.run.id
}

it('names no Project while nothing is running', async () => {
  await start(projectRoot, 'Nothing under way')
  await expect(core.listProjectsWithActiveLocalRuns()).resolves.toEqual([])
})

it('names the Project a Local Run is working in, and stops the moment it ends', async () => {
  const session = await start(projectRoot, 'Rewrite the importer')
  const runId = await beginRun(session.id, projectRoot)

  await expect(core.listProjectsWithActiveLocalRuns()).resolves.toEqual([projectRoot])

  await finishRunLifecycle(core, {
    sessionId: session.id,
    runId,
    outcome: 'completed',
    category: null,
    summary: 'Harness process completed'
  })
  await expect(core.listProjectsWithActiveLocalRuns()).resolves.toEqual([])
})

it('leaves a Project out when the Run working in it has its own Checkout', async () => {
  const isolated = await start(projectRoot, 'Try the other approach', {
    kind: 'worktree',
    path: join(stateDir, 'worktrees', 'try-the-other-approach'),
    baseBranch: 'trunk'
  })
  await beginRun(isolated.id, join(stateDir, 'worktrees', 'try-the-other-approach'))

  await expect(core.listProjectsWithActiveLocalRuns()).resolves.toEqual([])
})

it('counts a Run blocked on an Approval Request: it stopped asking, not working', async () => {
  const session = await start(projectRoot, 'Clean the build directory')
  const runId = await beginRun(session.id, projectRoot)
  await core.applyHarnessEvent({
    sessionId: session.id,
    runId,
    event: {
      type: 'approval-request',
      id: 'toolu_1',
      tool: 'Bash',
      summary: 'rm -rf build',
      detail: '{}',
      proposedRule: null
    }
  })

  await expect(core.listProjectsWithActiveLocalRuns()).resolves.toEqual([projectRoot])
})

it('names each Project once, and only the ones being worked in', async () => {
  const first = await start(projectRoot, 'Rewrite the importer')
  const second = await start(projectRoot, 'Fix the crash')
  const elsewhere = await start(otherRoot, 'Different repository')
  await start(otherRoot, 'Idle over here')

  await beginRun(first.id, projectRoot)
  await beginRun(second.id, projectRoot)
  await beginRun(elsewhere.id, otherRoot)

  const working = await core.listProjectsWithActiveLocalRuns()
  expect([...working].sort()).toEqual([otherRoot, projectRoot].sort())
})

it('still answers when one Session in the Project is unreadable', async () => {
  const session = await start(projectRoot, 'Rewrite the importer')
  await beginRun(session.id, projectRoot)
  const damaged = await start(projectRoot, 'Broken record')
  await rm(join(stateDir, 'sessions', damaged.id), { recursive: true, force: true })

  await expect(core.listProjectsWithActiveLocalRuns()).resolves.toEqual([projectRoot])
})
