import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
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
import { snapshotCheckout } from './git'
import { RunService } from './run-service'
import { discoverSkills } from './skills'

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
    claudeOauthToken: fakeClaudeOauthToken,
    skills: fakeSkills(root)
  }
}

function startInput() {
  return {
    submissionId: 'submission-1',
    sessionId: 'session',
    prompt: 'Rename the greeting',
    harness: 'claude' as const,
    model: 'claude-sonnet-4-5',
    effort: 'high',
    skill: 'wayfinder',
    permissionMode: 'auto' as const
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
  /** What the Project has already permanently allowed. */
  standingRules: string[]
  /** Runs whose Conversation still has them open, as a restart would find. */
  unfinished: { sessionId: string; runId: string }[]
}

let nextRunId = 0

/** The Session the service reads its Checkout from: a Project on disk. */
function fakeSession(projectRoot: string): SessionSummary {
  return {
    id: 'session',
    projectRoot,
    checkout: { kind: 'local' },
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
      changedFiles: [],
      activeRunId: null,
      pendingApprovalId: null
    },
    standingRules: [],
    unfinished: []
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
      permissionMode: 'auto'
    }),
    status: 'accepted',
    acceptedAt: '2026-07-31T12:00:00.000Z',
    updatedAt: '2026-07-31T12:00:00.000Z',
    activity: []
  }
  state.send.mockImplementation((command: { type: string }) => {
    state.commands.push(command.type)
    if (command.type === 'session/get') return Promise.resolve(fakeSession(projectRoot))
    if (command.type === 'approval/rules') return Promise.resolve(state.standingRules)
    if (command.type === 'approval/grant') return Promise.resolve(undefined)
    if (command.type === 'harness/open') return Promise.resolve({ events: [], outgoing: [] })
    if (command.type === 'harness/interrupt') return Promise.resolve([])
    if (command.type === 'harness/answer') {
      return Promise.resolve({ answered: true, outgoing: ['{"id":7,"result":{}}'] })
    }
    if (command.type === 'conversation/ingest') {
      return Promise.resolve({ events: state.events, outgoing: [] })
    }
    if (command.type === 'conversation/unfinished') return Promise.resolve(state.unfinished)
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
  write: ReturnType<typeof vi.fn>
  written: string[]
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
    /** Frames the app wrote back to the Harness, in order. */
    write: vi.fn((_runId: string, frame: string) => {
      broker.written.push(frame)
    }),
    written: [] as string[],
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

/**
 * Discovery, as Main injects it. Tests install Skills on disk in the Harness's
 * own documented directory, so this reads them the way the app does.
 */
function fakeSkills(root: string) {
  return (projectRoot: string, harness: 'codex' | 'claude') =>
    discoverSkills({ homeDirectory: root, projectRoot, harness, projectTrusted: true })
}
/** Connections a test opened to a Run's MCP socket, closed with the test. */
const openSockets: Socket[] = []

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.destroy()
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
      claudeOauthToken: fakeClaudeOauthToken,
      skills: fakeSkills(root)
    })
    await service.start({
      submissionId: 'submission-1',
      sessionId: 'session',
      prompt: 'Develop this Session',
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'high',
      skill: 'wayfinder',
      permissionMode: 'auto'
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
      claudeOauthToken: fakeClaudeOauthToken,
      skills: fakeSkills(root)
    })
    await service.start({
      submissionId: 'submission-1',
      sessionId: 'session',
      prompt: 'Continue',
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'medium',
      skill: 'wayfinder',
      permissionMode: 'auto'
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
        if (command.type === 'approval/rules') return Promise.resolve([])
        if (command.type === 'harness/open') return Promise.resolve({ events: [], outgoing: [] })
        if (command.type === 'harness/interrupt') return Promise.resolve([])
        if (command.type === 'harness/interrupt') return Promise.resolve([])
        if (command.type === 'harness/answer') {
          return Promise.resolve({ answered: true, outgoing: ['{"id":7,"result":{}}'] })
        }
        if (command.type === 'conversation/get') {
          return Promise.resolve({
            sessionId: 'session',
            entries: [],
            usage: { run: null, session: emptyUsage() },
            recovery: null,
            harnessThreads: {},
            changedFiles: [],
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
      needsRecovery: vi.fn(() => false),
      write: vi.fn()
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
      proxyScript: '/tmp/mcp-proxy.js',
      skills: fakeSkills(root)
    })
    await service.start({
      submissionId: 'submission-1',
      sessionId: 'session',
      prompt: 'Develop this',
      harness: 'claude',
      model: 'gpt-5',
      effort: 'high',
      skill: 'grilling',
      permissionMode: 'auto'
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
      proxyScript: '/tmp/mcp-proxy.js',
      skills: fakeSkills(root)
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
      permissionMode: 'auto'
    })
    expect(core.commands.indexOf('conversation/submit')).toBeLessThan(
      core.commands.indexOf('run/accept')
    )
    expect(core.commands.indexOf('run/accept')).toBeLessThan(
      core.commands.indexOf('conversation/begin')
    )
  })

  it('refuses a Skill that is not installed for this Harness', async () => {
    const root = await readyHarnessRoot('run-unverified-')
    const service = new RunService({
      core: fakeCore(join(root, 'a-project')),
      broker: fakeBroker(),
      readiness: readyReadiness(join(root, 'claude')),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js',
      skills: fakeSkills(root)
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
        permissionMode: 'auto'
      })
      // Discovery is the only list: a name it does not return is a name the
      // Harness would not find either.
    ).rejects.toThrow('is not an installed Skill')
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
      skills: fakeSkills(root),
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
      permissionMode: 'auto'
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
      proxyScript: '/tmp/mcp-proxy.js',
      skills: fakeSkills(root)
    })
    await service.start({
      submissionId: 'submission-1',
      sessionId: 'session',
      prompt: 'Develop',
      harness: 'claude',
      model: 'default',
      effort: 'medium',
      skill: 'wayfinder',
      permissionMode: 'auto'
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
      proxyScript: '/tmp/mcp-proxy.js',
      skills: fakeSkills(root)
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
      permissionMode: 'auto'
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
      proxyScript: '/tmp/mcp-proxy.js',
      skills: fakeSkills(root)
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
      proxyScript: '/tmp/mcp-proxy.js',
      skills: fakeSkills(root)
    })
    await service.start({
      submissionId: 'submission-1',
      sessionId: 'session',
      prompt: 'Grill me',
      harness: 'claude',
      model: 'default',
      effort: 'medium',
      skill: 'grilling',
      permissionMode: 'auto'
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
      proxyScript: '/tmp/mcp-proxy.js',
      skills: fakeSkills(root)
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
        permissionMode: 'auto'
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

describe('staged settings', () => {
  it('refuses to start rather than spawning with settings the Harness would ignore', async () => {
    const root = await readyClaudeRoot('run-claude-settings-')
    const broker = fakeBroker()
    const service = new RunService({
      ...claudeDeps(root, broker),
      // Stands in for a settings file this app could generate wrongly. The
      // Harness ignores invalid settings in silence, so a permission rule that
      // never loaded is indistinguishable from one that did.
      stageSettings: () => ({ permissions: { defaultMode: 'not-a-mode' } })
    })

    await expect(service.start(startInput())).rejects.toThrow(/settings/i)
    expect(broker.start).not.toHaveBeenCalled()
  })
})

describe('Codex on the app-server protocol', () => {
  function codexDeps(root: string, broker: ReturnType<typeof fakeBroker>, core: FakeCore) {
    return {
      core,
      broker,
      readiness: {
        refresh: vi.fn(() =>
          Promise.resolve({
            harnesses: [
              {
                harness: 'codex' as const,
                available: true,
                executablePath: join(root, 'codex'),
                version: 'codex-cli 0.146.0'
              }
            ]
          })
        )
      },
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js',
      skills: fakeSkills(root)
    }
  }

  function codexInput() {
    return { ...startInput(), harness: 'codex' as const, skill: 'grilling', model: 'gpt-5-codex' }
  }

  it('launches the app-server and carries the Run over the protocol, not argv', async () => {
    const root = await readyHarnessRoot('run-codex-appserver-')
    const broker = fakeBroker()
    const core = fakeCore(join(root, 'a-project'))
    const service = new RunService(codexDeps(root, broker, core))

    await service.start(codexInput())

    // The whole of `exec --json` is gone: no prompt, no policy, no model.
    expect(broker.launch?.args).toEqual(['app-server'])
    const open = (core.send.mock.calls as [{ type: string; launch?: unknown }][]).find(
      ([command]) => command.type === 'harness/open'
    )?.[0]
    expect(open?.launch).toMatchObject({
      cwd: join(root, 'a-project'),
      // Full access, as `docs/harness-permission-mapping.md` maps it.
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      model: 'gpt-5-codex',
      effort: 'high',
      prompt: 'Rename the greeting'
    })
  })

  it('writes the frames Core hands back, and only after there is a process', async () => {
    const root = await readyHarnessRoot('run-codex-frames-')
    const broker = fakeBroker()
    const core = fakeCore(join(root, 'a-project'))
    core.send.mockImplementation((command: { type: string }) => {
      core.commands.push(command.type)
      if (command.type === 'session/get')
        return Promise.resolve(fakeSession(join(root, 'a-project')))
      if (command.type === 'approval/rules') return Promise.resolve([])
      if (command.type === 'harness/open') {
        return Promise.resolve({ events: [], outgoing: ['{"id":1,"method":"initialize"}'] })
      }
      if (command.type === 'conversation/ingest') {
        return Promise.resolve({ events: [], outgoing: ['{"id":2,"method":"thread/start"}'] })
      }
      if (command.type.startsWith('conversation/')) return Promise.resolve(core.conversation)
      return Promise.resolve({
        id: 'run-codex',
        submissionId: 'submission-1',
        sessionId: 'session',
        prompt: 'Rename the greeting',
        configuration: runConfigurationSchema.parse({
          harness: 'codex',
          executable: join(root, 'codex'),
          executableHash: 'a'.repeat(64),
          harnessVersion: 'codex-cli 0.146.0',
          model: 'gpt-5-codex',
          effort: 'high',
          skill: { name: 'grilling', path: '/skills/grilling', hash: 'b'.repeat(64) },
          environment: {},
          checkout: join(root, 'a-project'),
          permissionMode: 'auto'
        }),
        status: command.type === 'run/accept' ? 'accepted' : 'running',
        acceptedAt: '2026-07-31T12:00:00.000Z',
        updatedAt: '2026-07-31T12:00:00.000Z',
        activity: []
      })
    })
    const service = new RunService(codexDeps(root, broker, core))

    await service.start(codexInput())
    // Codex says nothing until it is spoken to, so the opening frame goes out
    // the moment there is something to speak to.
    expect(broker.written).toEqual(['{"id":1,"method":"initialize"}'])

    broker.launch?.onOutput?.('stdout', '{"id":1,"result":{}}\n')
    await vi.waitFor(() => {
      expect(broker.written).toEqual([
        '{"id":1,"method":"initialize"}',
        '{"id":2,"method":"thread/start"}'
      ])
    })
  })

  it('ends the Run when the turn ends, because an app-server never exits', async () => {
    const root = await readyHarnessRoot('run-codex-turn-')
    const broker = fakeBroker()
    const core = fakeCore(join(root, 'a-project'))
    core.events = [{ type: 'completed' }]
    const service = new RunService(codexDeps(root, broker, core))

    await service.start(codexInput())
    broker.launch?.onOutput?.('stdout', '{"method":"turn/completed","params":{}}\n')

    await vi.waitFor(() => {
      const terminal = (core.send.mock.calls as [{ type: string; input?: { status?: string } }][])
        .filter(([command]) => command.type === 'run/event')
        .at(-1)?.[0].input
      expect(terminal?.status).toBe('completed')
    })
    // And the process is stopped rather than left waiting for a turn nobody
    // will ask for. Stopping through the broker suppresses the exit path, so
    // the Run is not concluded a second time as stopped.
    expect(broker.stop).toHaveBeenCalledWith(expect.any(String), 'quit')
  })

  it('leaves stdin closed for a Harness nobody answers', async () => {
    const root = await readyClaudeRoot('run-claude-stdin-')
    const broker = fakeBroker()
    const service = new RunService(claudeDeps(root, broker))

    await service.develop(developInput())

    // Claude is read, never answered, and a Harness that reads an open stdin
    // nothing writes to would wait on it forever.
    expect(broker.launch?.answersProtocol).not.toBe(true)
  })

  it('asks the turn to end before killing it, and lets it end itself', async () => {
    const root = await readyHarnessRoot('run-codex-stop-')
    const broker = fakeBroker()
    const core = fakeCore(join(root, 'a-project'))
    core.send.mockImplementation((command: { type: string }) => {
      core.commands.push(command.type)
      if (command.type === 'session/get') {
        return Promise.resolve(fakeSession(join(root, 'a-project')))
      }
      if (command.type === 'approval/rules') return Promise.resolve([])
      if (command.type === 'harness/open') return Promise.resolve({ events: [], outgoing: [] })
      // The Adapter knows the turn, so there is something to ask.
      if (command.type === 'harness/interrupt') {
        return Promise.resolve(['{"id":4,"method":"turn/interrupt"}'])
      }
      if (command.type === 'conversation/ingest') {
        return Promise.resolve({ events: [], outgoing: [] })
      }
      if (command.type.startsWith('conversation/')) return Promise.resolve(core.conversation)
      return Promise.resolve({
        id: 'run-codex-stop',
        submissionId: 'submission-1',
        sessionId: 'session',
        prompt: 'Rename the greeting',
        configuration: runConfigurationSchema.parse({
          harness: 'codex',
          executable: join(root, 'codex'),
          executableHash: 'a'.repeat(64),
          harnessVersion: 'codex-cli 0.146.0',
          model: 'gpt-5-codex',
          effort: 'high',
          skill: { name: 'grilling', path: '/skills/grilling', hash: 'b'.repeat(64) },
          environment: {},
          checkout: join(root, 'a-project'),
          permissionMode: 'auto'
        }),
        status: command.type === 'run/accept' ? 'accepted' : 'running',
        acceptedAt: '2026-07-31T12:00:00.000Z',
        updatedAt: '2026-07-31T12:00:00.000Z',
        activity: []
      })
    })
    // The Harness ends its own turn, so the Run is already gone when asked.
    broker.activeRunIds.mockReturnValue([])
    const service = new RunService({ ...codexDeps(root, broker, core), interruptGraceMs: 50 })
    const run = await service.start(codexInput())

    await service.stop(run.id, 'session')

    expect(broker.written).toContain('{"id":4,"method":"turn/interrupt"}')
    // Asked, not made: nothing was killed, because it stopped itself.
    expect(broker.stop).not.toHaveBeenCalled()
  })

  it('stages a Codex home that reaches the person’s credential without copying it', async () => {
    const root = await readyHarnessRoot('run-codex-home-')
    const broker = fakeBroker()
    const service = new RunService(codexDeps(root, broker, fakeCore(join(root, 'a-project'))))

    await service.start(codexInput())

    const [runKey] = await readdir(join(root, 'private'))
    const auth = join(root, 'private', runKey ?? '', 'codex-home', 'auth.json')
    // A link, so the token stays the person's: this app never holds one.
    expect(await realpath(auth)).toBe(await realpath(join(root, '.codex', 'auth.json')))
  })
})

describe('Ask mode', () => {
  it('runs Claude in the mode that asks, pointed at the app’s own approval tool', async () => {
    const root = await readyClaudeRoot('run-claude-ask-')
    const broker = fakeBroker()
    const service = new RunService(claudeDeps(root, broker))

    await service.start({ ...startInput(), permissionMode: 'ask' })

    const args = broker.launch?.args ?? []
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'default']))
    expect(args).toEqual(
      expect.arrayContaining(['--permission-prompt-tool', 'mcp__app__approval_request'])
    )
    const settingsPath = args[args.indexOf('--settings') + 1] ?? ''
    // Ask gates every tool, the app's own included. Being asked whether the app
    // may offer you a menu is not a decision anybody has, so those alone are
    // allowed outright — and nothing the agent does to the Checkout is.
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toMatchObject({
      permissions: {
        defaultMode: 'default',
        allow: ['mcp__app__offer_response_options', 'mcp__app__approval_request']
      }
    })
  })

  it('blocks the Run on a request, and resumes it when the person approves', async () => {
    const root = await readyClaudeRoot('run-claude-approve-')
    const broker = fakeBroker()
    const core = fakeCore(join(root, 'a-project'))
    const streamed: ConversationStreamEvent[] = []
    const service = new RunService({
      ...claudeDeps(root, broker),
      core,
      onConversationEvent: (event) => streamed.push(event)
    })
    const run = await service.start({ ...startInput(), permissionMode: 'ask' })

    const { answer } = await requestApproval(root, {
      tool_name: 'Bash',
      input: { command: 'pnpm test' },
      tool_use_id: 'toolu_1'
    })
    await vi.waitFor(() => {
      expect(streamed.map((entry) => entry.event.type)).toContain('approval-request')
    })
    // The Run is blocked while the request stands, and the Conversation is
    // where the person reads what is being asked for.
    expect(applied(core, 'approval-request')).toMatchObject({
      id: 'toolu_1',
      tool: 'Bash',
      summary: 'pnpm test'
    })
    expect(latestStatus(core)).toBe('waiting')

    await service.resolveApproval({
      sessionId: 'session',
      runId: run.id,
      approvalId: 'toolu_1',
      decision: 'allow',
      message: ''
    })

    expect(JSON.parse(await answer)).toMatchObject({ behavior: 'allow' })
    expect(applied(core, 'approval-resolved')).toMatchObject({ decision: 'allowed' })
    expect(latestStatus(core)).toBe('running')
  })

  it('hands a denial’s message back to the agent and lets the Run carry on', async () => {
    const root = await readyClaudeRoot('run-claude-deny-')
    const broker = fakeBroker()
    const core = fakeCore(join(root, 'a-project'))
    const service = new RunService({ ...claudeDeps(root, broker), core })
    const run = await service.start({ ...startInput(), permissionMode: 'ask' })

    const { answer } = await requestApproval(root, {
      tool_name: 'Bash',
      input: { command: 'rm -rf /' },
      tool_use_id: 'toolu_2'
    })
    await vi.waitFor(() => expect(applied(core, 'approval-request')).toBeDefined())

    await service.resolveApproval({
      sessionId: 'session',
      runId: run.id,
      approvalId: 'toolu_2',
      decision: 'deny',
      message: 'Run the unit tests instead'
    })

    expect(JSON.parse(await answer)).toEqual({
      behavior: 'deny',
      message: 'Run the unit tests instead'
    })
    expect(applied(core, 'approval-resolved')).toMatchObject({
      decision: 'denied',
      message: 'Run the unit tests instead'
    })
    // Denied, not stopped: the agent was told, and goes on working.
    expect(latestStatus(core)).toBe('running')
  })

  it('declines what is outstanding when the Run ends, and leaves nothing to answer', async () => {
    const root = await readyClaudeRoot('run-claude-outstanding-')
    const broker = fakeBroker()
    const core = fakeCore(join(root, 'a-project'))
    const service = new RunService({ ...claudeDeps(root, broker), core })
    const run = await service.start({ ...startInput(), permissionMode: 'ask' })

    const { answer } = await requestApproval(root, {
      tool_name: 'Bash',
      input: { command: 'pnpm test' },
      tool_use_id: 'toolu_3'
    })
    await vi.waitFor(() => expect(applied(core, 'approval-request')).toBeDefined())

    // Quitting the app stops the Run, which is what closing this Run's tool
    // host means. The Harness is told rather than left blocked on a socket.
    await service.stop(run.id, 'session')
    await broker.launch?.onBeforeCleanup?.()

    expect(JSON.parse(await answer)).toMatchObject({ behavior: 'deny' })
    expect(core.commands).toContain('conversation/finalize')
    await expect(
      service.resolveApproval({
        sessionId: 'session',
        runId: run.id,
        approvalId: 'toolu_3',
        decision: 'allow'
      })
    ).rejects.toThrow(/no longer waiting/)
  })

  it('offers the rule that would stop the same thing being asked again', async () => {
    const root = await readyClaudeRoot('run-claude-propose-')
    const broker = fakeBroker()
    const core = fakeCore(join(root, 'a-project'))
    const service = new RunService({ ...claudeDeps(root, broker), core })
    await service.start({ ...startInput(), permissionMode: 'ask' })

    await requestApproval(root, {
      tool_name: 'Bash',
      input: { command: 'pnpm test --watch' },
      tool_use_id: 'toolu_propose'
    })

    await vi.waitFor(() => {
      // Narrow by construction: the rule names this command, not the family
      // `pnpm` belongs to. Once stored there is no interception point left.
      expect(applied(core, 'approval-request')).toMatchObject({
        proposedRule: { kind: 'command', toolName: 'Bash', content: 'pnpm test:*' }
      })
    })
  })

  it('grants the Standing Approval before the agent is told, and stops asking', async () => {
    const root = await readyClaudeRoot('run-claude-remember-')
    const broker = fakeBroker()
    const core = fakeCore(join(root, 'a-project'))
    const service = new RunService({ ...claudeDeps(root, broker), core })
    const run = await service.start({ ...startInput(), permissionMode: 'ask' })

    const first = await requestApproval(root, {
      tool_name: 'Bash',
      input: { command: 'pnpm test' },
      tool_use_id: 'toolu_remember'
    })
    await vi.waitFor(() => expect(applied(core, 'approval-request')).toBeDefined())
    await service.resolveApproval({
      sessionId: 'session',
      runId: run.id,
      approvalId: 'toolu_remember',
      decision: 'allow',
      remember: true
    })

    expect(JSON.parse(await first.answer)).toMatchObject({ behavior: 'allow' })
    const grant = (core.send.mock.calls as [{ type: string; input?: unknown }][])
      .filter(([command]) => command.type === 'approval/grant')
      .at(-1)?.[0].input
    // Scoped to the Session's Project, and durable before the agent acts on it.
    expect(grant).toMatchObject({
      projectRoot: join(root, 'a-project'),
      kind: 'command',
      toolName: 'Bash',
      content: 'pnpm test:*'
    })
    expect(applied(core, 'approval-resolved')).toMatchObject({ remembered: true })

    // This Run's settings were staged before the grant existed, so the rule
    // rides back on the answer and the Harness adds it to the Thread it is
    // already running — measured on 2.1.220, that is what stops the next
    // matching request being asked at all. Nothing in this app decides what it
    // covers; the Harness's own matcher does, exactly as it will next Run.
    expect(JSON.parse(await first.answer)).toMatchObject({
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'pnpm test:*' }],
          behavior: 'allow',
          // Never the person's own repository or home configuration.
          destination: 'session'
        }
      ]
    })
  })

  it('adds nothing to the running Thread when the person only allows once', async () => {
    const root = await readyClaudeRoot('run-claude-once-')
    const broker = fakeBroker()
    const core = fakeCore(join(root, 'a-project'))
    const service = new RunService({ ...claudeDeps(root, broker), core })
    const run = await service.start({ ...startInput(), permissionMode: 'ask' })

    const { answer } = await requestApproval(root, {
      tool_name: 'Bash',
      input: { command: 'pnpm test' },
      tool_use_id: 'toolu_once'
    })
    await vi.waitFor(() => expect(applied(core, 'approval-request')).toBeDefined())
    await service.resolveApproval({
      sessionId: 'session',
      runId: run.id,
      approvalId: 'toolu_once',
      decision: 'allow'
    })

    expect(JSON.parse(await answer)).not.toHaveProperty('updatedPermissions')
    expect(core.commands).not.toContain('approval/grant')
  })

  it('writes an edit rule from the Project root the Harness will compare against', async () => {
    // Measured on 2.1.220: working through a symlinked root, a rule naming
    // that root was not consulted and a rule naming its target was — the
    // Harness resolves a path before it checks any rule. A rule written from
    // the path the person sees would go on asking.
    const real = await readyClaudeRoot('run-claude-real-')
    const link = join(await mkdtemp(join(tmpdir(), 'run-claude-link-')), 'project')
    temporaryDirectories.push(link)
    await mkdir(join(real, 'a-project'), { recursive: true })
    await symlink(join(real, 'a-project'), link)
    const broker = fakeBroker()
    const core = fakeCore(link)
    const service = new RunService({ ...claudeDeps(real, broker), core })
    await service.start({ ...startInput(), permissionMode: 'ask' })

    await requestApproval(real, {
      tool_name: 'Edit',
      // The path arrives resolved, which is why the rule has to be.
      input: { file_path: join(await realpath(link), 'src', 'app.ts') },
      tool_use_id: 'toolu_symlink'
    })

    const resolved = await realpath(link)
    await vi.waitFor(() => {
      expect(applied(core, 'approval-request')).toMatchObject({
        proposedRule: { kind: 'edit', content: `/${resolved}/**` }
      })
    })
    // The Project as the person knows it is not what the rule names.
    expect(resolved).not.toBe(link)
  })

  it('refuses to remember what it could not narrow into a rule', async () => {
    const root = await readyClaudeRoot('run-claude-unnarrowable-')
    const broker = fakeBroker()
    const core = fakeCore(join(root, 'a-project'))
    const service = new RunService({ ...claudeDeps(root, broker), core })
    const run = await service.start({ ...startInput(), permissionMode: 'ask' })

    await requestApproval(root, {
      tool_name: 'Bash',
      // Every subcommand must match a rule independently, so no single rule
      // covers this one.
      input: { command: 'pnpm test && rm -rf /' },
      tool_use_id: 'toolu_compound'
    })
    await vi.waitFor(() => expect(applied(core, 'approval-request')).toBeDefined())

    await expect(
      service.resolveApproval({
        sessionId: 'session',
        runId: run.id,
        approvalId: 'toolu_compound',
        decision: 'allow',
        remember: true
      })
    ).rejects.toThrow(/Standing Approval/)
    expect(core.commands).not.toContain('approval/grant')
  })

  it("stages the Project's Standing Approvals as the Harness's own rules", async () => {
    const root = await readyClaudeRoot('run-claude-standing-')
    const broker = fakeBroker()
    const core = fakeCore(join(root, 'a-project'))
    core.standingRules = ['Bash(pnpm test:*)', `Edit(/${join(root, 'a-project')}/**)`]

    const service = new RunService({ ...claudeDeps(root, broker), core })

    await service.start({ ...startInput(), permissionMode: 'ask' })

    const args = broker.launch?.args ?? []
    const settingsPath = args[args.indexOf('--settings') + 1] ?? ''
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toMatchObject({
      permissions: {
        allow: [
          'mcp__app__offer_response_options',
          'mcp__app__approval_request',
          'Bash(pnpm test:*)',
          `Edit(/${join(root, 'a-project')}/**)`
        ]
      }
    })
  })

  it('runs Codex in Ask under the policy that escalates by rule, not by model', async () => {
    const root = await readyHarnessRoot('run-codex-ask-')
    const broker = fakeBroker()
    const core = fakeCore(join(root, 'a-project'))
    const service = new RunService({
      core,
      broker,
      readiness: {
        refresh: vi.fn(() =>
          Promise.resolve({
            harnesses: [
              {
                harness: 'codex' as const,
                available: true,
                executablePath: join(root, 'codex'),
                version: 'codex-cli 0.146.0'
              }
            ]
          })
        )
      },
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js',
      skills: fakeSkills(root)
    })

    await service.start({
      ...startInput(),
      harness: 'codex',
      skill: 'grilling',
      permissionMode: 'ask'
    })

    const open = (core.send.mock.calls as [{ type: string; launch?: unknown }][]).find(
      ([command]) => command.type === 'harness/open'
    )?.[0]
    // `on-request` would let the model decide when to ask, so somebody who
    // chose Ask could silently get no prompts. `untrusted` cannot.
    expect(open?.launch).toMatchObject({
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write'
    })
  })
})

/** The latest Run status this service asked Core to record. */
function latestStatus(core: FakeCore): string | undefined {
  return (core.send.mock.calls as [{ type: string; input?: { status?: string } }][])
    .filter(([command]) => command.type === 'run/event' && command.input?.status !== undefined)
    .at(-1)?.[0].input?.status
}

/** The event of that type this service applied to the Conversation. */
function applied(core: FakeCore, type: string): Record<string, unknown> | undefined {
  return (core.send.mock.calls as [{ type: string; event?: Record<string, unknown> }][])
    .filter(
      ([command]) => command.type === 'conversation/apply' && command.event?.['type'] === type
    )
    .at(-1)?.[0].event
}

/**
 * Asks for permission the way the Harness does: over the app's own MCP socket,
 * found where the Run's staged configuration points the proxy at it. The
 * request stays outstanding, so its answer is handed back unawaited — the
 * point of the test is that nothing comes back until the person decides.
 */
async function requestApproval(
  root: string,
  args: Record<string, unknown>
): Promise<{ answer: Promise<string> }> {
  const runsRoot = join(root, 'private')
  const [runKey] = await readdir(runsRoot)
  if (!runKey) throw new Error('The Run staged no private directory')
  const config = JSON.parse(await readFile(join(runsRoot, runKey, 'mcp.json'), 'utf8')) as {
    mcpServers: { app: { env: { APP_MCP_SOCKET: string; APP_MCP_CAPABILITY: string } } }
  }
  const { APP_MCP_SOCKET, APP_MCP_CAPABILITY } = config.mcpServers.app.env
  const socket = createConnection(APP_MCP_SOCKET)
  openSockets.push(socket)
  await new Promise<void>((resolve) => socket.once('connect', resolve))
  socket.write(`${JSON.stringify({ appCapability: APP_MCP_CAPABILITY })}\n`)
  const answer = new Promise<string>((resolve) => {
    let pending = ''
    socket.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      const boundary = pending.indexOf('\n')
      if (boundary < 0) return
      const response = JSON.parse(pending.slice(0, boundary)) as {
        result?: { content?: { text?: string }[] }
      }
      resolve(response.result?.content?.[0]?.text ?? '')
    })
  })
  socket.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'approval_request', arguments: args }
    })}\n`
  )
  return { answer }
}

describe('a Run the app never got to finish', () => {
  /** A Project with one commit, as any Checkout would be. */
  async function project(root: string): Promise<string> {
    const checkout = join(root, 'a-project')
    await mkdir(checkout, { recursive: true })
    const git = promisify(execFile)
    await git('git', ['init', '--quiet'], { cwd: checkout })
    await writeFile(join(checkout, 'tracked.ts'), 'a\n')
    await git('git', ['add', '-A'], { cwd: checkout })
    await git(
      'git',
      ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'init'],
      { cwd: checkout }
    )
    return checkout
  }

  it('reports what it changed on the next start, and cleans up after itself', async () => {
    const root = await readyClaudeRoot('run-service-abandoned-')
    const checkout = await project(root)
    const deps = claudeDeps(root, fakeBroker())
    // A Run that started, changed something, and never concluded: the app was
    // quit or it crashed, so nothing compared its Checkout.
    const abandoned = join(deps.privateRoot, 'checkout-snapshots', 'run-key')
    const snapshot = await snapshotCheckout(checkout, abandoned)
    await writeFile(
      join(abandoned, 'baseline.json'),
      JSON.stringify({ sessionId: 'session', runId: 'run-abandoned', checkout, snapshot })
    )
    await writeFile(join(checkout, 'tracked.ts'), 'changed by the agent\n')

    const service = new RunService(deps)
    await service.recoverUnfinishedWork()

    expect(deps.core.commands).toContain('conversation/checkout-changes')
    const recorded = deps.core.send.mock.calls
      .map(
        ([command]) =>
          command as { type: string; input?: { runId?: string; files?: { path: string }[] } }
      )
      .find((command) => command.type === 'conversation/checkout-changes')
    expect(recorded?.input?.runId).toBe('run-abandoned')
    expect(recorded?.input?.files?.map((file) => file.path)).toEqual(['tracked.ts'])
    await expect(readdir(join(deps.privateRoot, 'checkout-snapshots'))).resolves.toEqual([])
  })

  it('throws away a snapshot it cannot make sense of, rather than keeping it forever', async () => {
    const root = await readyClaudeRoot('run-service-rubbish-')
    const deps = claudeDeps(root, fakeBroker())
    const rubbish = join(deps.privateRoot, 'checkout-snapshots', 'run-key')
    await mkdir(rubbish, { recursive: true })
    await writeFile(join(rubbish, 'baseline.json'), 'not json at all')

    const service = new RunService(deps)
    await service.recoverUnfinishedWork()

    expect(deps.core.commands).not.toContain('conversation/checkout-changes')
    await expect(readdir(join(deps.privateRoot, 'checkout-snapshots'))).resolves.toEqual([])
  })
})

describe('a Run nobody closed', () => {
  it('closes a Run left open by a quit, and says the message can be sent again', async () => {
    const root = await readyClaudeRoot('run-service-open-')
    const deps = claudeDeps(root, fakeBroker())
    deps.core.unfinished = [{ sessionId: 'session', runId: 'run-open' }]

    const service = new RunService(deps)
    await service.recoverUnfinishedWork()

    const finalized = deps.core.send.mock.calls
      .map(([command]) => command as { type: string; input?: { runId?: string; outcome?: string } })
      .find((command) => command.type === 'conversation/finalize')
    expect(finalized?.input).toMatchObject({ runId: 'run-open', outcome: 'failed' })
  })

  it('leaves a Run this process just accepted alone, before the broker knows it', async () => {
    // The window the broker cannot cover: a Run is durably open from the
    // moment its boundary is written, and its process does not exist yet.
    const root = await readyClaudeRoot('run-service-starting-')
    const broker = fakeBroker({
      // The Run is open in its Conversation and has no process yet, which is
      // exactly where the recovery pass could take it for abandoned.
      start: vi.fn(async (launch: RunLaunch) => {
        deps.core.unfinished = [{ sessionId: 'session', runId: launch.id }]
        await service.recoverUnfinishedWork()
      })
    })
    const deps = claudeDeps(root, broker)
    const service = new RunService(deps)

    await service.start(startInput())

    expect(deps.core.commands).not.toContain('conversation/finalize')
  })

  it('leaves a Run the broker is still running alone', async () => {
    const root = await readyClaudeRoot('run-service-still-going-')
    const broker = fakeBroker()
    broker.activeRunIds.mockReturnValue(['run-going'])
    const deps = claudeDeps(root, broker)
    deps.core.unfinished = [{ sessionId: 'session', runId: 'run-going' }]

    const service = new RunService(deps)
    await service.recoverUnfinishedWork()

    expect(deps.core.commands).not.toContain('conversation/finalize')
  })
})
