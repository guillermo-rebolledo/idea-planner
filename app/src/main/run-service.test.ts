import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runConfigurationSchema, type RunSnapshot } from '@shared/run'
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
    const executablePath = join(root, 'codex')
    await Promise.all([
      mkdir(join(skillPath, '..'), { recursive: true }),
      mkdir(join(root, '.codex'), { recursive: true })
    ])
    await writeFile(skillPath, '# Grilling')
    await writeFile(executablePath, '#!/bin/sh\n')
    await writeFile(join(root, '.codex', 'auth.json'), '{}')
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
      start: vi.fn(async (_launch: { args: string[]; onBeforeCleanup?: () => Promise<void> }) => {
        order.push('provider/start')
        await _launch.onBeforeCleanup?.()
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
            providers: [
              {
                provider: 'codex',
                available: true,
                executablePath,
                version: 'codex-cli 0.146.0'
              }
            ]
          })
        )
      },
      libraryPath: () => join(root, 'library'),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/planning-mcp-proxy.js'
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
    const configuration = runConfigurationSchema.parse(acceptance.input.configuration)
    expect(configuration).toMatchObject({
      executable: executablePath,
      providerVersion: 'codex-cli 0.146.0',
      permissionProfile: 'planning-v1',
      skill: { name: 'grilling', path: join(root, '.agents', 'skills', 'grilling') }
    })
    expect(configuration.executableHash).toMatch(/^[a-f0-9]{64}$/)
    const launch = broker.start.mock.calls[0]?.[0]
    expect(launch).toBeDefined()
    for (const argument of [
      '--ephemeral',
      '--ignore-rules',
      '--disable',
      'shell_tool',
      'unified_exec'
    ]) {
      expect(launch?.args).toContain(argument)
    }
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
          proxyExecutable: '/usr/bin/true',
          proxyScript: join(root, 'proxy.js'),
          socketPath: join(runDirectory, 'planning.sock')
        })
      )
      await expect(
        promisify(execFile)('/usr/bin/sandbox-exec', ['-f', profile, '/usr/bin/true'])
      ).resolves.toBeDefined()
    }
  )

  it.skipIf(process.platform !== 'darwin')(
    'denies direct provider writes and secret-path reads in the native sandbox',
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
      const policy = new PlanningPolicy({ workingDirectory: root, planningDirectory })
      await writeFile(
        profile,
        policy.renderSandboxProfile({
          runDirectory,
          executable: '/usr/bin/touch',
          proxyExecutable: '/usr/bin/true',
          proxyScript: join(root, 'proxy.js'),
          socketPath: join(runDirectory, 'planning.sock')
        })
      )
      const sandbox = (executable: string, ...args: string[]) =>
        promisify(execFile)('/usr/bin/sandbox-exec', ['-f', profile, executable, ...args])
      await expect(
        sandbox('/usr/bin/touch', join(planningDirectory, 'draft.md'))
      ).rejects.toBeDefined()
      await expect(sandbox('/usr/bin/touch', join(root, 'source.ts'))).rejects.toBeDefined()
      await expect(sandbox('/usr/bin/head', join(root, '.env'))).rejects.toBeDefined()
    }
  )

  it.skipIf(process.platform !== 'darwin')(
    'allows only the capability socket through the native sandbox',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sandbox-socket-'))
      temporaryDirectories.push(root)
      const runDirectory = join(root, 'run')
      const planningDirectory = join(root, '.scratch', 'idea')
      await Promise.all([
        mkdir(runDirectory, { recursive: true }),
        mkdir(planningDirectory, { recursive: true })
      ])
      const allowedSocket = join(root, 'allowed.sock')
      const deniedSocket = join(root, 'denied.sock')
      const allowedServer = createServer((connection) => connection.end('ok'))
      const deniedServer = createServer((connection) => connection.end('unexpected'))
      await Promise.all([
        new Promise<void>((resolve) => allowedServer.listen(allowedSocket, resolve)),
        new Promise<void>((resolve) => deniedServer.listen(deniedSocket, resolve))
      ])
      const profile = join(runDirectory, 'planning.sb')
      await writeFile(
        profile,
        new PlanningPolicy({ workingDirectory: root, planningDirectory }).renderSandboxProfile({
          runDirectory,
          executable: '/usr/bin/nc',
          proxyExecutable: '/usr/bin/true',
          proxyScript: join(root, 'proxy.js'),
          socketPath: allowedSocket
        })
      )
      const connect = (path: string) =>
        promisify(execFile)('/usr/bin/sandbox-exec', ['-f', profile, '/usr/bin/nc', '-U', path])
      try {
        await expect(connect(allowedSocket)).resolves.toMatchObject({ stdout: 'ok' })
        await expect(connect(deniedSocket)).rejects.toBeDefined()
      } finally {
        allowedServer.close()
        deniedServer.close()
      }
    }
  )
})
