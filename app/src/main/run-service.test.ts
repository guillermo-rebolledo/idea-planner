import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  emptyUsage,
  type ConversationSnapshot,
  type ConversationStreamEvent,
  type HarnessEvent
} from '@shared/conversation'
import { runConfigurationSchema, type RunSnapshot } from '@shared/run'
import { PlanningPolicy } from './planning-policy'
import type { RunLaunch } from './run-process-broker'
import { RunService } from './run-service'

const temporaryDirectories: string[] = []

/** A ready Codex install with the verified Grill Me skill in place. */
async function readyProviderRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(root)
  await Promise.all([
    mkdir(join(root, '.agents', 'skills', 'grilling'), { recursive: true }),
    mkdir(join(root, '.codex'), { recursive: true })
  ])
  await Promise.all([
    writeFile(join(root, '.agents', 'skills', 'grilling', 'SKILL.md'), '# Grilling'),
    writeFile(join(root, 'codex'), '#!/bin/sh\n'),
    writeFile(join(root, '.codex', 'auth.json'), '{}')
  ])
  return root
}

async function readyClaudeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(root)
  await mkdir(join(root, '.claude', 'skills', 'wayfinder'), { recursive: true })
  await writeFile(join(root, '.claude', 'skills', 'wayfinder', 'SKILL.md'), '# Wayfinder')
  await writeFile(join(root, 'claude'), '#!/bin/sh\n')
  return root
}

interface FakeCore {
  send: ReturnType<typeof vi.fn>
  commands: string[]
  events: HarnessEvent[]
  conversation: ConversationSnapshot
}

let nextRunId = 0

function fakeCore(): FakeCore {
  const runId = `run-${++nextRunId}`
  const state: FakeCore = {
    send: vi.fn(),
    commands: [],
    events: [],
    conversation: {
      relativePath: 'idea',
      entries: [],
      usage: { run: null, idea: emptyUsage() },
      recovery: null,
      providerSessions: {},
      workflowCompletionSuggested: false,
      activeRunId: null
    }
  }
  const run: RunSnapshot = {
    id: runId,
    submissionId: 'submission-1',
    relativePath: 'idea',
    prompt: 'Grill me',
    configuration: runConfigurationSchema.parse({
      provider: 'codex',
      executable: '/usr/local/bin/codex',
      executableHash: 'a'.repeat(64),
      providerVersion: 'codex-cli 0.146.0',
      model: 'gpt-5-codex',
      effort: 'medium',
      workflow: 'grilling',
      skill: { name: 'grilling', path: '/skills/grilling', hash: 'b'.repeat(64) },
      environment: {},
      workingDirectory: '/library/idea',
      permissionMode: 'ask',
      permissionProfile: 'planning-v1'
    }),
    status: 'accepted',
    acceptedAt: '2026-07-31T12:00:00.000Z',
    updatedAt: '2026-07-31T12:00:00.000Z',
    activity: []
  }
  state.send.mockImplementation((command: { type: string }) => {
    state.commands.push(command.type)
    if (command.type === 'conversation/ingest') return Promise.resolve(state.events)
    if (command.type.startsWith('conversation/')) return Promise.resolve(state.conversation)
    if (command.type === 'run/accept') return Promise.resolve(run)
    return Promise.resolve({ ...run, status: 'running' })
  })
  return state
}

function fakeBroker(overrides: { start?: ReturnType<typeof vi.fn> } = {}): {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  stopAll: ReturnType<typeof vi.fn>
  activeRunIds: ReturnType<typeof vi.fn>
  needsRecovery: ReturnType<typeof vi.fn>
  launch?: RunLaunch
} {
  const broker = {
    start: vi.fn((launch: RunLaunch) => {
      broker.launch = launch
      return Promise.resolve()
    }),
    stop: vi.fn(() => Promise.resolve()),
    stopAll: vi.fn(() => Promise.resolve()),
    activeRunIds: vi.fn((): string[] => []),
    needsRecovery: vi.fn(() => false),
    launch: undefined as RunLaunch | undefined,
    ...overrides
  }
  return broker
}

function readyReadiness(executablePath: string): {
  refresh: ReturnType<typeof vi.fn>
} {
  return {
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
  }
}
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('Run service', () => {
  it('starts Claude Wayfinder with the documented stream protocol and native skill invocation', async () => {
    const root = await readyClaudeRoot('run-claude-')
    const core = fakeCore()
    const broker = fakeBroker()
    const service = new RunService({
      core,
      broker,
      readiness: {
        refresh: vi.fn(() =>
          Promise.resolve({
            providers: [
              {
                provider: 'claude',
                available: true,
                executablePath: join(root, 'claude'),
                version: '2.1.220 (Claude Code)'
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
      prompt: 'Develop this idea',
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'high',
      workflow: 'wayfinder',
      permissionMode: 'ask'
    })
    expect(broker.launch?.args).toEqual(
      expect.arrayContaining([
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--include-hook-events'
      ])
    )
    expect(broker.launch?.args).not.toContain('--input-format')
    expect(broker.launch?.args.at(-1)).toContain('/wayfinder Develop this idea')
    expect(broker.launch?.args).not.toContain('--disable-slash-commands')
  })

  it('gives Wayfinder its own managed planning tree', async () => {
    const root = await readyClaudeRoot('run-wayfinder-tree-')
    const broker = fakeBroker()
    const service = new RunService({
      core: fakeCore(),
      broker,
      readiness: {
        refresh: vi.fn(() =>
          Promise.resolve({
            providers: [
              {
                provider: 'claude',
                available: true,
                executablePath: join(root, 'claude'),
                version: '2.1.220 (Claude Code)'
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
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'medium',
      workflow: 'wayfinder',
      permissionMode: 'ask'
    })
    expect(broker.launch?.args.at(-1)).toContain('.scratch/idea-wayfinding')
  })

  it('resumes compatible Claude continuity but hands off local history when switching providers', async () => {
    const root = await readyClaudeRoot('run-claude-continuity-')
    const core = fakeCore()
    core.conversation = {
      ...core.conversation,
      providerSessions: { claude: 'saved-session' },
      entries: [
        {
          kind: 'boundary',
          id: 'boundary:old:started',
          at: '2026-07-31T12:00:00.000Z',
          runId: 'old',
          boundary: 'run-started',
          summary: 'Wayfinder via Claude',
          submissionId: 'old-submission',
          recovery: null,
          provider: 'claude',
          workflow: 'wayfinder',
          model: 'claude-sonnet-4-5'
        }
      ]
    }
    const projectKey = join(root, 'library', 'idea').replaceAll('/', '-')
    await mkdir(join(root, '.claude', 'projects', projectKey), { recursive: true })
    await writeFile(join(root, '.claude', 'projects', projectKey, 'saved-session.jsonl'), '{}\n')
    const broker = fakeBroker()
    const service = new RunService({
      core,
      broker,
      readiness: {
        refresh: vi.fn(() =>
          Promise.resolve({
            providers: [
              {
                provider: 'claude',
                available: true,
                executablePath: join(root, 'claude'),
                version: '2.1.220 (Claude Code)'
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
      prompt: 'Continue',
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'medium',
      workflow: 'wayfinder',
      permissionMode: 'ask'
    })
    expect(broker.launch?.args).toEqual(expect.arrayContaining(['--resume', 'saved-session']))
  })
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
        if (command.type === 'conversation/get') {
          return Promise.resolve({
            relativePath: 'idea',
            entries: [],
            usage: { run: null, idea: emptyUsage() },
            recovery: null,
            providerSessions: {},
            workflowCompletionSuggested: false,
            activeRunId: null
          })
        }
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

  it('accepts the message durably, then records the Run boundary, then contacts the provider', async () => {
    const root = await readyProviderRoot('run-develop-')
    const core = fakeCore()
    const service = new RunService({
      core,
      broker: fakeBroker(),
      readiness: readyReadiness(join(root, 'codex')),
      libraryPath: () => join(root, 'library'),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/planning-mcp-proxy.js'
    })
    await service.develop({
      relativePath: 'idea',
      submissionId: 'submission-1',
      text: 'Grill me',
      source: 'composer',
      workflow: 'grilling',
      provider: 'codex',
      model: 'gpt-5-codex',
      effort: 'medium',
      permissionMode: 'ask'
    })
    expect(core.commands.indexOf('conversation/submit')).toBeLessThan(
      core.commands.indexOf('run/accept')
    )
    expect(core.commands.indexOf('run/accept')).toBeLessThan(
      core.commands.indexOf('conversation/begin')
    )
  })

  it('refuses a workflow whose skill identity has not been verified', async () => {
    const root = await readyProviderRoot('run-unverified-')
    const service = new RunService({
      core: fakeCore(),
      broker: fakeBroker(),
      readiness: readyReadiness(join(root, 'codex')),
      libraryPath: () => join(root, 'library'),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/planning-mcp-proxy.js'
    })
    await expect(
      service.start({
        submissionId: 'submission-1',
        relativePath: 'idea',
        prompt: 'Develop this',
        provider: 'codex',
        model: 'gpt-5-codex',
        effort: 'medium',
        workflow: 'to-spec',
        permissionMode: 'ask'
      })
    ).rejects.toThrow('not a verified planning workflow')
  })

  it('streams normalized events to the window and keeps assistant text out of activity', async () => {
    const root = await readyProviderRoot('run-stream-')
    const core = fakeCore()
    core.events = [
      { type: 'assistant-message', id: 'item_0', text: 'Who is this for?', complete: true },
      { type: 'reasoning', summary: 'Reading the Idea first.' },
      { type: 'tool', name: 'planning.read_file', summary: 'Read file idea.md' }
    ]
    const broker = fakeBroker()
    const streamed: ConversationStreamEvent[] = []
    const service = new RunService({
      core,
      broker,
      readiness: readyReadiness(join(root, 'codex')),
      libraryPath: () => join(root, 'library'),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/planning-mcp-proxy.js',
      onConversationEvent: (event) => streamed.push(event)
    })
    await service.start({
      submissionId: 'submission-1',
      relativePath: 'idea',
      prompt: 'Grill me',
      provider: 'codex',
      model: 'gpt-5-codex',
      effort: 'medium',
      workflow: 'grilling',
      permissionMode: 'ask'
    })
    broker.launch?.onOutput?.('stdout', '{"type":"turn.started"}\n')
    await Promise.resolve()
    await broker.launch?.onBeforeCleanup?.()
    expect(streamed.map((entry) => entry.event.type)).toEqual([
      'assistant-message',
      'reasoning',
      'tool'
    ])
    const activity = (core.send.mock.calls as [{ type: string; input?: unknown }][])
      .filter(([command]) => command.type === 'run/event')
      .map(([command]) => command.input as { kind: string; summary: string })
    expect(activity.some((entry) => entry.summary.includes('Who is this for?'))).toBe(false)
    expect(activity).toContainEqual(
      expect.objectContaining({ kind: 'reasoning', summary: 'Reading the Idea first.' })
    )
    expect(activity).toContainEqual(
      expect.objectContaining({ kind: 'output', summary: 'planning.read_file: Read file idea.md' })
    )
  })

  it('keeps a correctness-critical protocol failure failed even when Claude exits zero', async () => {
    const root = await readyClaudeRoot('run-protocol-failure-')
    const core = fakeCore()
    core.events = [{ type: 'failed', category: 'protocol', summary: 'Unsupported Claude event' }]
    const broker = fakeBroker()
    const service = new RunService({
      core,
      broker,
      readiness: {
        refresh: vi.fn(() =>
          Promise.resolve({
            providers: [
              {
                provider: 'claude',
                available: true,
                executablePath: join(root, 'claude'),
                version: '2.1.220 (Claude Code)'
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
      prompt: 'Develop',
      provider: 'claude',
      model: 'default',
      effort: 'medium',
      workflow: 'wayfinder',
      permissionMode: 'ask'
    })
    broker.launch?.onOutput?.('stdout', '{"type":"system","subtype":"future"}\n')
    broker.launch?.onExit?.(0, null)
    await vi.waitFor(() => {
      const terminal = (core.send.mock.calls as [{ type: string; input?: { status?: string } }][])
        .filter(([command]) => command.type === 'run/event')
        .at(-1)?.[0].input
      expect(terminal?.status).toBe('failed')
    })
  })

  it('keeps the message and offers recovery when the provider is never contacted', async () => {
    const root = await readyProviderRoot('run-uncertain-')
    const core = fakeCore()
    core.conversation = {
      ...core.conversation,
      recovery: {
        category: 'uncertain-submission',
        summary: 'Provider process could not start',
        resumableSubmissionId: 'submission-1'
      }
    }
    const service = new RunService({
      core,
      broker: fakeBroker({
        start: vi.fn(() => Promise.reject(new Error('spawn failed')))
      }),
      readiness: readyReadiness(join(root, 'codex')),
      libraryPath: () => join(root, 'library'),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/planning-mcp-proxy.js'
    })
    const snapshot = await service.develop({
      relativePath: 'idea',
      submissionId: 'submission-1',
      text: 'Grill me',
      source: 'composer',
      workflow: 'grilling',
      provider: 'codex',
      model: 'gpt-5-codex',
      effort: 'medium',
      permissionMode: 'ask'
    })
    expect(core.commands).toContain('conversation/finalize')
    expect(snapshot.recovery).toMatchObject({
      category: 'uncertain-submission',
      resumableSubmissionId: 'submission-1'
    })
  })

  it('closes a Run the app no longer supervises when the Conversation is reopened', async () => {
    const root = await readyProviderRoot('run-interrupted-')
    const core = fakeCore()
    core.conversation = { ...core.conversation, activeRunId: 'run-from-a-previous-session' }
    const service = new RunService({
      core,
      broker: fakeBroker(),
      readiness: readyReadiness(join(root, 'codex')),
      libraryPath: () => join(root, 'library'),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/planning-mcp-proxy.js'
    })
    await service.conversation('idea')
    const finalize = (core.send.mock.calls as [{ type: string; input?: unknown }][]).find(
      ([command]) => command.type === 'conversation/finalize'
    )?.[0].input
    expect(finalize).toMatchObject({
      runId: 'run-from-a-previous-session',
      outcome: 'failed',
      category: 'process-crash'
    })
  })

  it('explains a failed Run with the provider’s own last diagnostic line', async () => {
    const root = await readyProviderRoot('run-diagnostic-')
    const core = fakeCore()
    const broker = fakeBroker()
    const service = new RunService({
      core,
      broker,
      readiness: readyReadiness(join(root, 'codex')),
      libraryPath: () => join(root, 'library'),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/planning-mcp-proxy.js'
    })
    await service.start({
      submissionId: 'submission-1',
      relativePath: 'idea',
      prompt: 'Grill me',
      provider: 'codex',
      model: 'default',
      effort: 'medium',
      workflow: 'grilling',
      permissionMode: 'ask'
    })
    broker.launch?.onOutput?.(
      'stderr',
      "sandbox-exec: execvp() of 'codex' failed: Operation not permitted\n"
    )
    broker.launch?.onExit?.(1, null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await broker.launch?.onBeforeCleanup?.()
    const finalize = (core.send.mock.calls as [{ type: string; input?: unknown }][]).find(
      ([command]) => command.type === 'conversation/finalize'
    )?.[0].input as { summary: string } | undefined
    expect(finalize?.summary).toContain('Operation not permitted')
  })

  it('surfaces an unready provider as an error rather than false recovery state', async () => {
    const root = await readyProviderRoot('run-unready-')
    const service = new RunService({
      core: fakeCore(),
      broker: fakeBroker(),
      readiness: {
        refresh: vi.fn(() =>
          Promise.resolve({
            providers: [
              { provider: 'codex', available: false, executablePath: null, version: null }
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
    await expect(
      service.develop({
        relativePath: 'idea',
        submissionId: 'submission-1',
        text: 'Grill me',
        source: 'composer',
        workflow: 'grilling',
        provider: 'codex',
        model: 'gpt-5-codex',
        effort: 'medium',
        permissionMode: 'ask'
      })
    ).rejects.toThrow('not ready for planning')
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
          launch: { executables: ['/usr/bin/true'], executableTrees: [], readRoots: [] },
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
          launch: { executables: ['/usr/bin/touch'], executableTrees: [], readRoots: [] },
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
          launch: { executables: ['/usr/bin/nc'], executableTrees: [], readRoots: [] },
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
