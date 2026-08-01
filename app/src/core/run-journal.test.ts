import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runSnapshotSchema } from '@shared/run'
import { createCore, type Core } from './core'

let libraryDir: string
let core: Core

beforeEach(async () => {
  libraryDir = await mkdtemp(join(tmpdir(), 'run-journal-'))
  let id = 0
  core = createCore({
    now: () => new Date('2026-07-31T12:00:00.000Z'),
    randomId: () => `id-${++id}`
  })
  await core.openLibrary(libraryDir)
})

afterEach(async () => rm(libraryDir, { recursive: true, force: true }))

describe('durable Run acceptance', () => {
  it('accepts a stable submission once before provider contact', async () => {
    const idea = await core.captureIdea({ kind: 'software', title: 'Sandbox', notes: '' })
    const input = {
      submissionId: 'submission-1',
      relativePath: idea.relativePath,
      prompt: 'Help me develop this Idea.',
      configuration: {
        provider: 'codex' as const,
        executable: '/opt/codex',
        executableHash: 'c'.repeat(64),
        providerVersion: 'codex-cli 0.146.0',
        model: 'gpt-5',
        effort: 'high',
        workflow: 'grilling' as const,
        skill: { name: 'grilling', path: '/skills/grilling', hash: 'a'.repeat(64) },
        environment: { LANG: 'en_US.UTF-8', PATH: '/usr/bin:/bin' },
        workingDirectory: join(libraryDir, idea.relativePath),
        permissionMode: 'ask' as const,
        permissionProfile: 'planning-v1' as const
      }
    }

    const accepted = await core.acceptRun(input)
    const duplicate = await core.acceptRun(input)

    expect(duplicate).toEqual(accepted)
    expect(accepted).toMatchObject({ submissionId: 'submission-1', status: 'accepted' })
    const persisted = runSnapshotSchema.parse(
      JSON.parse(
        await readFile(
          join(libraryDir, idea.relativePath, '.idea', 'runs', `${accepted.id}.json`),
          'utf8'
        )
      )
    )
    expect(persisted.configuration).toEqual(input.configuration)
    expect(persisted.prompt).toBe(input.prompt)

    await core.recordRunEvent({
      relativePath: idea.relativePath,
      runId: accepted.id,
      status: 'starting',
      kind: 'lifecycle',
      summary: 'Starting provider'
    })
    await core.recordRunEvent({
      relativePath: idea.relativePath,
      runId: accepted.id,
      status: 'running',
      kind: 'lifecycle',
      summary: 'Provider process running'
    })
    await expect(core.acceptRun(input)).resolves.toMatchObject({ status: 'running' })
  })

  it('rejects reuse of a submission identity with different content', async () => {
    const idea = await core.captureIdea({ kind: 'software', title: 'Stable identity', notes: '' })
    const base = {
      submissionId: 'submission-1',
      relativePath: idea.relativePath,
      prompt: 'First',
      configuration: {
        provider: 'codex' as const,
        executable: '/opt/codex',
        executableHash: 'c'.repeat(64),
        providerVersion: 'codex-cli 0.146.0',
        model: 'gpt-5',
        effort: 'high',
        workflow: 'grilling' as const,
        skill: { name: 'grilling', path: '/skills/grilling', hash: 'b'.repeat(64) },
        environment: { LANG: 'en_US.UTF-8' },
        workingDirectory: join(libraryDir, idea.relativePath),
        permissionMode: 'auto' as const,
        permissionProfile: 'planning-v1' as const
      }
    }
    await core.acceptRun(base)
    await expect(core.acceptRun({ ...base, prompt: 'Changed' })).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
  })

  it('rejects invalid lifecycle transitions in durable state', async () => {
    const idea = await core.captureIdea({ kind: 'software', title: 'Transitions', notes: '' })
    const accepted = await core.acceptRun({
      submissionId: 'submission-transition',
      relativePath: idea.relativePath,
      prompt: 'Plan safely',
      configuration: {
        provider: 'codex',
        executable: '/opt/codex',
        executableHash: 'd'.repeat(64),
        providerVersion: 'codex-cli 0.146.0',
        model: 'gpt-5',
        effort: 'high',
        workflow: 'grilling',
        skill: { name: 'grilling', path: '/skills/grilling', hash: 'e'.repeat(64) },
        environment: { LANG: 'en_US.UTF-8' },
        workingDirectory: join(libraryDir, idea.relativePath),
        permissionMode: 'ask',
        permissionProfile: 'planning-v1'
      }
    })

    await expect(
      core.recordRunEvent({
        relativePath: idea.relativePath,
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
      record({ relativePath: 'idea', runId: 'run-1', kind: 'output', summary: '' })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
