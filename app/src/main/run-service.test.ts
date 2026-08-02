import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  emptyUsage,
  type ConversationSnapshot,
  type ConversationStreamEvent,
  type HarnessEvent
} from '@shared/conversation'
import type { SessionSummary } from '@shared/contract'
import { runConfigurationSchema, type RunSnapshot } from '@shared/run'
import type { RunLaunch } from './run-process-broker'
import { RunService } from './run-service'

const temporaryDirectories: string[] = []

/** A ready Codex install with the verified Grill Me Skill in place. */
async function readyHarnessRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(root)
  await Promise.all([
    mkdir(join(root, '.agents', 'skills', 'grilling'), { recursive: true }),
    mkdir(join(root, '.claude', 'skills', 'grilling'), { recursive: true }),
    mkdir(join(root, '.codex'), { recursive: true })
  ])
  await Promise.all([
    writeFile(join(root, '.agents', 'skills', 'grilling', 'SKILL.md'), '# Grilling'),
    writeFile(join(root, '.claude', 'skills', 'grilling', 'SKILL.md'), '# Grilling'),
    writeFile(join(root, 'codex'), '#!/bin/sh\n'),
    writeFile(join(root, 'claude'), '#!/bin/sh\n'),
    writeFile(join(root, '.codex', 'auth.json'), '{}')
  ])
  return root
}

/** The dependencies a Claude Run needs, with a ready Harness on disk. */
function claudeDeps(root: string, broker: ReturnType<typeof fakeBroker>) {
  return {
    core: fakeCore(join(root, 'a-project')),
    broker,
    readiness: {
      refresh: vi.fn(() =>
        Promise.resolve({
          harnesses: [
            {
              harness: 'claude' as const,
              available: true,
              executablePath: join(root, 'claude'),
              version: '2.1.220 (Claude Code)'
            }
          ]
        })
      )
    },
    homeDirectory: root,
    privateRoot: join(root, 'private'),
    proxyExecutable: '/usr/bin/true',
    proxyScript: '/tmp/mcp-proxy.js',
    claudeOauthToken: fakeClaudeOauthToken
  }
}

function developInput() {
  return {
    submissionId: 'submission-1',
    sessionId: 'session',
    text: 'Rename the greeting',
    source: 'composer' as const,
    harness: 'claude' as const,
    model: 'claude-sonnet-4-5',
    effort: 'high',
    skill: 'wayfinder',
    permissionMode: 'auto' as const
  }
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

/** The Session the service reads its Checkout from: a Project on disk. */
function fakeSession(projectRoot: string): SessionSummary {
  return {
    id: 'session',
    projectRoot,
    title: 'Grill me',
    createdAt: '2026-07-31T12:00:00.000Z',
    updatedAt: '2026-07-31T12:00:00.000Z',
    pinned: false,
    archivedAt: null
  }
}

function fakeCore(projectRoot = '/a-project'): FakeCore {
  const runId = `run-${++nextRunId}`
  const state: FakeCore = {
    send: vi.fn(),
    commands: [],
    events: [],
    conversation: {
      sessionId: 'session',
      entries: [],
      usage: { run: null, session: emptyUsage() },
      recovery: null,
      harnessThreads: {},
      activeRunId: null
    }
  }
  const run: RunSnapshot = {
    id: runId,
    submissionId: 'submission-1',
    sessionId: 'session',
    prompt: 'Grill me',
    configuration: runConfigurationSchema.parse({
      harness: 'codex',
      executable: '/usr/local/bin/codex',
      executableHash: 'a'.repeat(64),
      harnessVersion: 'codex-cli 0.146.0',
      model: 'gpt-5-codex',
      effort: 'medium',
      skill: { name: 'grilling', path: '/skills/grilling', hash: 'b'.repeat(64) },
      environment: {},
      checkout: projectRoot,
      permissionMode: 'ask'
    }),
    status: 'accepted',
    acceptedAt: '2026-07-31T12:00:00.000Z',
    updatedAt: '2026-07-31T12:00:00.000Z',
    activity: []
  }
  state.send.mockImplementation((command: { type: string }) => {
    state.commands.push(command.type)
    if (command.type === 'session/get') return Promise.resolve(fakeSession(projectRoot))
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
        harnesses: [
          {
            harness: 'claude' as const,
            available: true,
            executablePath,
            version: '2.1.220 (Claude Code)'
          }
        ]
      })
    )
  }
}

const fakeClaudeOauthToken = (): Promise<string> => Promise.resolve('test-oauth-token')
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('Run service', () => {
  it('starts Claude Wayfinder with the documented stream protocol and native skill invocation', async () => {
    const root = await readyClaudeRoot('run-claude-')
    const core = fakeCore(join(root, 'a-project'))
    const broker = fakeBroker()
    const service = new RunService({
      core,
      broker,
      readiness: {
        refresh: vi.fn(() =>
          Promise.resolve({
            harnesses: [
              {
                harness: 'claude',
                available: true,
                executablePath: join(root, 'claude'),
                version: '2.1.220 (Claude Code)'
              }
            ]
          })
        )
      },
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js',
      claudeOauthToken: fakeClaudeOauthToken
    })
    await service.start({
      submissionId: 'submission-1',
      sessionId: 'session',
      prompt: 'Develop this Session',
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'high',
      skill: 'wayfinder',
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
    expect(broker.launch?.args).toEqual(expect.arrayContaining(['--setting-sources', 'user']))
    expect(broker.launch?.args.at(-1)).toContain('/wayfinder Develop this Session')
    expect(broker.launch?.args).not.toContain('--disable-slash-commands')
    const mcpConfigPath = broker.launch?.args[broker.launch.args.indexOf('--mcp-config') + 1]
    if (!mcpConfigPath) throw new Error('Claude launch did not include an MCP config')
    const mcpConfig = JSON.parse(await readFile(mcpConfigPath, 'utf8')) as {
      mcpServers: { app: Record<string, unknown> }
    }
    expect(mcpConfig.mcpServers.app).not.toHaveProperty('args')
    // The Skill comes from the person's own installed Skills, which readiness
    // already requires and the Run configuration already hashes.
    const args = broker.launch?.args ?? []
    const settingsPath = args[args.indexOf('--settings') + 1]
    if (!settingsPath) throw new Error('Claude launch did not include a settings file')
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toMatchObject({
      permissions: { defaultMode: 'bypassPermissions' }
    })
  })

  it('resumes compatible Claude continuity but hands off local history when switching Harnesses', async () => {
    const root = await readyClaudeRoot('run-claude-continuity-')
    const core = fakeCore(join(root, 'a-project'))
    core.conversation = {
      ...core.conversation,
      harnessThreads: { claude: 'saved-thread' },
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
          harness: 'claude',
          skill: 'wayfinder',
          model: 'claude-sonnet-4-5'
        }
      ]
    }
    const projectKey = join(root, 'a-project').replaceAll('/', '-')
    await mkdir(join(root, '.claude', 'projects', projectKey), { recursive: true })
    await writeFile(join(root, '.claude', 'projects', projectKey, 'saved-thread.jsonl'), '{}\n')
    const broker = fakeBroker()
    const service = new RunService({
      core,
      broker,
      readiness: {
        refresh: vi.fn(() =>
          Promise.resolve({
            harnesses: [
              {
                harness: 'claude',
                available: true,
                executablePath: join(root, 'claude'),
                version: '2.1.220 (Claude Code)'
              }
            ]
          })
        )
      },
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js',
      claudeOauthToken: fakeClaudeOauthToken
    })
    await service.start({
      submissionId: 'submission-1',
      sessionId: 'session',
      prompt: 'Continue',
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'medium',
      skill: 'wayfinder',
      permissionMode: 'ask'
    })
    expect(broker.launch?.args).toEqual(expect.arrayContaining(['--resume', 'saved-thread']))
  })
  it('persists acceptance before starting Harness contact and freezes provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'run-service-'))
    temporaryDirectories.push(root)
    const skillPath = join(root, '.claude', 'skills', 'grilling', 'SKILL.md')
    const executablePath = join(root, 'claude')
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
        if (command.type === 'session/get') {
          return Promise.resolve(fakeSession(join(root, 'a-project')))
        }
        if (command.type === 'conversation/get') {
          return Promise.resolve({
            sessionId: 'session',
            entries: [],
            usage: { run: null, session: emptyUsage() },
            recovery: null,
            harnessThreads: {},
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
        order.push('harness/start')
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
            harnesses: [
              {
                harness: 'claude',
                available: true,
                executablePath,
                version: '2.1.220 (Claude Code)'
              }
            ]
          })
        )
      },
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js'
    })
    await service.start({
      submissionId: 'submission-1',
      sessionId: 'session',
      prompt: 'Develop this',
      harness: 'claude',
      model: 'gpt-5',
      effort: 'high',
      skill: 'grilling',
      permissionMode: 'ask'
    })
    expect(order.indexOf('run/accept')).toBeLessThan(order.indexOf('harness/start'))
    const accept = core.send.mock.calls.find(([command]) => command.type === 'run/accept')?.[0]
    expect(accept).toBeDefined()
    const acceptance = accept as { input: { configuration: unknown } }
    const configuration = runConfigurationSchema.parse(acceptance.input.configuration)
    expect(configuration).toMatchObject({
      executable: executablePath,
      harnessVersion: '2.1.220 (Claude Code)',
      skill: { name: 'grilling', path: join(root, '.claude', 'skills', 'grilling') }
    })
    expect(configuration.executableHash).toMatch(/^[a-f0-9]{64}$/)
    const launch = broker.start.mock.calls[0]?.[0]
    expect(launch).toBeDefined()
    for (const argument of ['--print', '--output-format', 'stream-json']) {
      expect(launch?.args).toContain(argument)
    }
  })

  it('accepts the message durably, then records the Run boundary, then contacts the Harness', async () => {
    const root = await readyHarnessRoot('run-develop-')
    const core = fakeCore(join(root, 'a-project'))
    const service = new RunService({
      core,
      broker: fakeBroker(),
      readiness: readyReadiness(join(root, 'claude')),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js'
    })
    await service.develop({
      sessionId: 'session',
      submissionId: 'submission-1',
      text: 'Grill me',
      source: 'composer',
      skill: 'grilling',
      harness: 'claude',
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

  it('refuses a Skill whose identity has not been verified', async () => {
    const root = await readyHarnessRoot('run-unverified-')
    const service = new RunService({
      core: fakeCore(join(root, 'a-project')),
      broker: fakeBroker(),
      readiness: readyReadiness(join(root, 'claude')),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js'
    })
    await expect(
      service.start({
        submissionId: 'submission-1',
        sessionId: 'session',
        prompt: 'Develop this',
        harness: 'claude',
        model: 'gpt-5-codex',
        effort: 'medium',
        skill: 'to-spec',
        permissionMode: 'ask'
      })
    ).rejects.toThrow('is not a verified Skill')
  })

  it('streams normalized events to the window and keeps assistant text out of activity', async () => {
    const root = await readyHarnessRoot('run-stream-')
    const core = fakeCore(join(root, 'a-project'))
    core.events = [
      { type: 'assistant-message', id: 'item_0', text: 'Who is this for?', complete: true },
      { type: 'reasoning', summary: 'Reading the Session first.' },
      { type: 'tool', name: 'app.read_file', summary: 'Read file session.md' }
    ]
    const broker = fakeBroker()
    const streamed: ConversationStreamEvent[] = []
    const service = new RunService({
      core,
      broker,
      readiness: readyReadiness(join(root, 'claude')),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js',
      onConversationEvent: (event) => streamed.push(event)
    })
    await service.start({
      submissionId: 'submission-1',
      sessionId: 'session',
      prompt: 'Grill me',
      harness: 'claude',
      model: 'gpt-5-codex',
      effort: 'medium',
      skill: 'grilling',
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
      expect.objectContaining({ kind: 'reasoning', summary: 'Reading the Session first.' })
    )
    expect(activity).toContainEqual(
      expect.objectContaining({ kind: 'output', summary: 'app.read_file: Read file session.md' })
    )
  })

  it('keeps a correctness-critical protocol failure failed even when Claude exits zero', async () => {
    const root = await readyClaudeRoot('run-protocol-failure-')
    const core = fakeCore(join(root, 'a-project'))
    core.events = [{ type: 'failed', category: 'protocol', summary: 'Unsupported Claude event' }]
    const broker = fakeBroker()
    const service = new RunService({
      core,
      broker,
      readiness: {
        refresh: vi.fn(() =>
          Promise.resolve({
            harnesses: [
              {
                harness: 'claude',
                available: true,
                executablePath: join(root, 'claude'),
                version: '2.1.220 (Claude Code)'
              }
            ]
          })
        )
      },
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js'
    })
    await service.start({
      submissionId: 'submission-1',
      sessionId: 'session',
      prompt: 'Develop',
      harness: 'claude',
      model: 'default',
      effort: 'medium',
      skill: 'wayfinder',
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

  it('keeps the message and offers recovery when the Harness is never contacted', async () => {
    const root = await readyHarnessRoot('run-uncertain-')
    const core = fakeCore(join(root, 'a-project'))
    core.conversation = {
      ...core.conversation,
      recovery: {
        category: 'uncertain-submission',
        summary: 'The Harness process could not start',
        resumableSubmissionId: 'submission-1'
      }
    }
    const service = new RunService({
      core,
      broker: fakeBroker({
        start: vi.fn(() => Promise.reject(new Error('spawn failed')))
      }),
      readiness: readyReadiness(join(root, 'claude')),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js'
    })
    const snapshot = await service.develop({
      sessionId: 'session',
      submissionId: 'submission-1',
      text: 'Grill me',
      source: 'composer',
      skill: 'grilling',
      harness: 'claude',
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
    const root = await readyHarnessRoot('run-interrupted-')
    const core = fakeCore(join(root, 'a-project'))
    core.conversation = { ...core.conversation, activeRunId: 'run-from-a-previous-session' }
    const service = new RunService({
      core,
      broker: fakeBroker(),
      readiness: readyReadiness(join(root, 'claude')),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js'
    })
    await service.conversation('session')
    const finalize = (core.send.mock.calls as [{ type: string; input?: unknown }][]).find(
      ([command]) => command.type === 'conversation/finalize'
    )?.[0].input
    expect(finalize).toMatchObject({
      runId: 'run-from-a-previous-session',
      outcome: 'failed',
      category: 'process-crash'
    })
  })

  it('explains a failed Run with the Harness’s own last diagnostic line', async () => {
    const root = await readyHarnessRoot('run-diagnostic-')
    const core = fakeCore(join(root, 'a-project'))
    const broker = fakeBroker()
    const service = new RunService({
      core,
      broker,
      readiness: readyReadiness(join(root, 'claude')),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js'
    })
    await service.start({
      submissionId: 'submission-1',
      sessionId: 'session',
      prompt: 'Grill me',
      harness: 'claude',
      model: 'default',
      effort: 'medium',
      skill: 'grilling',
      permissionMode: 'ask'
    })
    broker.launch?.onOutput?.('stderr', 'codex: cannot open .git/HEAD: Operation not permitted\n')
    broker.launch?.onExit?.(1, null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await broker.launch?.onBeforeCleanup?.()
    const finalize = (core.send.mock.calls as [{ type: string; input?: unknown }][]).find(
      ([command]) => command.type === 'conversation/finalize'
    )?.[0].input as { summary: string } | undefined
    expect(finalize?.summary).toContain('Operation not permitted')
  })

  it('surfaces an unready Harness as an error rather than false recovery state', async () => {
    const root = await readyHarnessRoot('run-unready-')
    const service = new RunService({
      core: fakeCore(join(root, 'a-project')),
      broker: fakeBroker(),
      readiness: {
        refresh: vi.fn(() =>
          Promise.resolve({
            harnesses: [
              { harness: 'claude', available: false, executablePath: null, version: null }
            ]
          })
        )
      },
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js'
    })
    await expect(
      service.develop({
        sessionId: 'session',
        submissionId: 'submission-1',
        text: 'Grill me',
        source: 'composer',
        skill: 'grilling',
        harness: 'claude',
        model: 'gpt-5-codex',
        effort: 'medium',
        permissionMode: 'ask'
      })
    ).rejects.toThrow('is not ready')
  })
})

describe('Claude launch', () => {
  it('gives Claude its native tools and the Full access permission mode', async () => {
    const root = await readyClaudeRoot('run-claude-native-')
    const broker = fakeBroker()
    const service = new RunService(claudeDeps(root, broker))

    await service.develop(developInput())
    const args = broker.launch?.args ?? []

    // The muzzle is gone: an allow-list naming only the app's MCP tool is what
    // left Claude with no native tools at all.
    expect(args).not.toContain('--allowedTools')
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']))
    // Per-Run configuration is a staged settings file. CLAUDE_CONFIG_DIR is a
    // dead end: a staged directory reports the person as not logged in.
    expect(args).toEqual(
      expect.arrayContaining(['--settings', expect.stringContaining('settings.json')])
    )
    expect(Object.keys(broker.launch?.environment ?? {})).not.toContain('CLAUDE_CONFIG_DIR')
  })

  it("sends the person's request and the Skill, and nothing else", async () => {
    const root = await readyClaudeRoot('run-claude-prompt-')
    const broker = fakeBroker()
    const service = new RunService(claudeDeps(root, broker))

    await service.develop(developInput())

    // The whole prompt, not an absence of particular words: an instruction
    // about tools the app no longer owns is one the model would act on, and
    // asserting it is gone by name would pass again if it came back reworded.
    expect((broker.launch?.args ?? []).at(-1)).toBe('/wayfinder Rename the greeting')
  })
})
