import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunSnapshot } from '@shared/run'
import { PlanningPolicy } from './planning-policy'
import { RunService } from './run-service'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('Run service', () => {
  it('persists acceptance before starting provider contact and freezes provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'run-service-'))
    temporaryDirectories.push(root)
    const skillPath = join(root, '.agents', 'skills', 'grilling', 'SKILL.md')
    await mkdir(join(skillPath, '..'), { recursive: true })
    await writeFile(skillPath, '# Grilling')
    const order: string[] = []
    let accepted: RunSnapshot | undefined
    const core = {
      send: vi.fn((command: { type: string; input?: unknown }) => {
        order.push(command.type)
        if (command.type === 'run/accept') {
          const input = command.input as Omit<
            RunSnapshot,
            'id' | 'status' | 'acceptedAt' | 'updatedAt' | 'activity'
          >
          accepted = {
            ...input,
            id: 'run-1',
            status: 'accepted',
            acceptedAt: '2026-07-31T12:00:00.000Z',
            updatedAt: '2026-07-31T12:00:00.000Z',
            activity: []
          }
        }
        return Promise.resolve({
          ...accepted,
          status: command.type === 'run/accept' ? 'accepted' : 'starting'
        })
      })
    }
    const broker = {
      start: vi.fn(() => {
        order.push('provider/start')
        return Promise.resolve()
      }),
      stop: vi.fn(() => Promise.resolve()),
      stopAll: vi.fn(() => Promise.resolve()),
      activeRunIds: vi.fn((): string[] => []),
      needsRecovery: vi.fn(() => false)
    }
    const service = new RunService({
      core,
      broker,
      readiness: {
        refresh: vi.fn(() =>
          Promise.resolve({
            providers: [{ provider: 'codex', available: true, executablePath: '/opt/codex' }]
          })
        )
      },
      libraryPath: () => join(root, 'library'),
      homeDirectory: root,
      privateRoot: join(root, 'private')
    })
    await service.start({
      submissionId: 'submission-1',
      relativePath: 'idea',
      prompt: 'Develop this',
      provider: 'codex',
      model: 'gpt-5',
      effort: 'high',
      workflow: 'grilling',
      permissionMode: 'ask'
    })
    expect(order.indexOf('run/accept')).toBeLessThan(order.indexOf('provider/start'))
    const accept = core.send.mock.calls.find(([command]) => command.type === 'run/accept')?.[0]
    expect(accept).toBeDefined()
    const acceptance = accept as { input: { configuration: unknown } }
    expect(acceptance.input.configuration).toMatchObject({
      executable: '/opt/codex',
      permissionProfile: 'planning-v1',
      skill: { name: 'grilling', path: join(root, '.agents', 'skills', 'grilling') }
    })
  })

  it.skipIf(process.platform !== 'darwin')(
    'generates a profile accepted by the native sandbox',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sandbox-profile-'))
      temporaryDirectories.push(root)
      const planningDirectory = join(root, '.scratch', 'idea')
      const runDirectory = join(root, 'run')
      await Promise.all([
        mkdir(planningDirectory, { recursive: true }),
        mkdir(runDirectory, { recursive: true })
      ])
      const profile = join(runDirectory, 'planning.sb')
      await writeFile(
        profile,
        new PlanningPolicy({ workingDirectory: root, planningDirectory }).renderSandboxProfile({
          runDirectory,
          executable: '/usr/bin/true',
          homeDirectory: root,
          skillDirectory: join(root, '.agents', 'skills', 'grilling')
        })
      )
      await expect(
        promisify(execFile)('/usr/bin/sandbox-exec', ['-f', profile, '/usr/bin/true'])
      ).resolves.toBeDefined()
    }
  )

  it.skipIf(process.platform !== 'darwin')(
    'enforces managed writes and secret-path denial in the native sandbox',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sandbox-enforcement-'))
      temporaryDirectories.push(root)
      const planningDirectory = join(root, '.scratch', 'idea')
      const runDirectory = join(root, 'run')
      await Promise.all([
        mkdir(planningDirectory, { recursive: true }),
        mkdir(runDirectory, { recursive: true }),
        writeFile(join(root, '.env'), 'SECRET=value'),
        writeFile(join(root, 'README.md'), 'safe')
      ])
      const profile = join(runDirectory, 'planning.sb')
      await writeFile(
        profile,
        new PlanningPolicy({ workingDirectory: root, planningDirectory }).renderSandboxProfile({
          runDirectory,
          executable: '/bin/sh',
          homeDirectory: root,
          skillDirectory: join(root, '.agents', 'skills', 'grilling')
        })
      )
      const sandbox = (script: string) =>
        promisify(execFile)('/usr/bin/sandbox-exec', ['-f', profile, '/bin/sh', '-c', script])
      await expect(
        sandbox(`printf allowed > ${join(planningDirectory, 'draft.md')}`)
      ).resolves.toBeDefined()
      await expect(sandbox(`printf blocked > ${join(root, 'source.ts')}`)).rejects.toBeDefined()
      await expect(sandbox(`IFS= read -r value < ${join(root, '.env')}`)).rejects.toBeDefined()
    }
  )
})
