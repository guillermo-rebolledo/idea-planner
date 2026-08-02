import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runSnapshotSchema } from '@shared/run'
import { createCore, type Core } from './core'

let stateDir: string
let projectRoot: string
let core: Core

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'run-journal-state-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'run-journal-project-'))
  let id = 0
  core = createCore({
    stateDirectory: stateDir,
    now: () => new Date('2026-07-31T12:00:00.000Z'),
    randomId: () => `id-${++id}`
  })
  await core.addProject(projectRoot)
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

describe('durable Run acceptance', () => {
  it('accepts a stable submission once before Harness contact', async () => {
    const session = await core.startSession({ projectRoot, title: 'Sandbox' })
    const input = {
      submissionId: 'submission-1',
      sessionId: session.id,
      prompt: 'Help me develop this Session.',
      configuration: {
        harness: 'codex' as const,
        executable: '/opt/codex',
        executableHash: 'c'.repeat(64),
        harnessVersion: 'codex-cli 0.146.0',
        model: 'gpt-5',
        effort: 'high',
        skill: { name: 'grilling', path: '/skills/grilling', hash: 'a'.repeat(64) },
        environment: { LANG: 'en_US.UTF-8', PATH: '/usr/bin:/bin' },
        workingDirectory: projectRoot,
        permissionMode: 'ask' as const
      }
    }

    const accepted = await core.acceptRun(input)
    const duplicate = await core.acceptRun(input)

    expect(duplicate).toEqual(accepted)
    expect(accepted).toMatchObject({ submissionId: 'submission-1', status: 'accepted' })
    const persisted = runSnapshotSchema.parse(
      JSON.parse(
        await readFile(
          join(stateDir, 'sessions', session.id, 'runs', `${accepted.id}.json`),
          'utf8'
        )
      )
    )
    expect(persisted.configuration).toEqual(input.configuration)
    expect(persisted.prompt).toBe(input.prompt)

    await core.recordRunEvent({
      sessionId: session.id,
      runId: accepted.id,
      status: 'starting',
      kind: 'lifecycle',
      summary: 'Starting the Harness'
    })
    await core.recordRunEvent({
      sessionId: session.id,
      runId: accepted.id,
      status: 'running',
      kind: 'lifecycle',
      summary: 'Harness process running'
    })
    await expect(core.acceptRun(input)).resolves.toMatchObject({ status: 'running' })
  })

  it('rejects reuse of a submission identity with different content', async () => {
    const session = await core.startSession({ projectRoot, title: 'Stable identity' })
    const base = {
      submissionId: 'submission-1',
      sessionId: session.id,
      prompt: 'First',
      configuration: {
        harness: 'codex' as const,
        executable: '/opt/codex',
        executableHash: 'c'.repeat(64),
        harnessVersion: 'codex-cli 0.146.0',
        model: 'gpt-5',
        effort: 'high',
        skill: { name: 'grilling', path: '/skills/grilling', hash: 'b'.repeat(64) },
        environment: { LANG: 'en_US.UTF-8' },
        workingDirectory: projectRoot,
        permissionMode: 'auto' as const
      }
    }
    await core.acceptRun(base)
    await expect(core.acceptRun({ ...base, prompt: 'Changed' })).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
  })

  it('rejects invalid lifecycle transitions in durable state', async () => {
    const session = await core.startSession({ projectRoot, title: 'Transitions' })
    const accepted = await core.acceptRun({
      submissionId: 'submission-transition',
      sessionId: session.id,
      prompt: 'Plan safely',
      configuration: {
        harness: 'codex',
        executable: '/opt/codex',
        executableHash: 'd'.repeat(64),
        harnessVersion: 'codex-cli 0.146.0',
        model: 'gpt-5',
        effort: 'high',
        skill: { name: 'grilling', path: '/skills/grilling', hash: 'e'.repeat(64) },
        environment: { LANG: 'en_US.UTF-8' },
        workingDirectory: projectRoot,
        permissionMode: 'ask'
      }
    })

    await expect(
      core.recordRunEvent({
        sessionId: session.id,
        runId: accepted.id,
        status: 'completed',
        kind: 'lifecycle',
        summary: 'Impossible direct completion'
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('maps malformed event payloads to a typed Core error', async () => {
    const record = (input: unknown): Promise<unknown> =>
      (core.recordRunEvent as (value: unknown) => Promise<unknown>)(input)
    await expect(
      record({ sessionId: 'session', runId: 'run-1', kind: 'output', summary: '' })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
