import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  emptyUsage,
  type ConversationSnapshot,
  type ConversationStreamEvent,
  type HarnessEvent,
  type QueuedSubmission
} from '@shared/conversation'
import { LOCAL_CHECKOUT, startingSubmissionId, type SessionSummary } from '@shared/contract'
import { runConfigurationSchema, type RunSnapshot } from '@shared/run'
import type { RunLaunch } from './run-process-broker'
import { snapshotCheckout } from './git'
import { testGit as git } from './git-test-support'
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
    worktreeBootstrap: null,
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
      pendingApprovalId: null,
      queue: { paused: true, items: [], outcome: null }
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
    if (command.type === 'session/start') return Promise.resolve(fakeSession(projectRoot))
    if (command.type === 'session/list') return Promise.resolve([fakeSession(projectRoot)])
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
    if (command.type === 'conversation/queue-launch-observed') {
      return Promise.resolve({ continueDraining: false })
    }
    if (command.type === 'run/lifecycle-open') {
      return Promise.resolve({ run, conversation: state.conversation })
    }
    if (command.type === 'run/lifecycle-complete') {
      const input = command as { input?: { observation?: { type?: string } } }
      const completed = { ...run, status: statusForObservation(input.input?.observation?.type) }
      state.conversation = { ...state.conversation, activeRunId: null }
      return Promise.resolve({
        run: completed,
        conversation: state.conversation,
        queueDisposition: completed.status === 'completed' ? 'advance' : 'pause'
      })
    }
    if (command.type.startsWith('conversation/')) return Promise.resolve(state.conversation)
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
        if (command.type === 'run/lifecycle-open') {
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
        const next = {
          ...accepted,
          status:
            command.type === 'run/lifecycle-open' ? ('accepted' as const) : ('starting' as const)
        }
        return Promise.resolve(
          command.type === 'run/lifecycle-open'
            ? {
                run: next,
                conversation: {
                  sessionId: 'session',
                  entries: [],
                  usage: { run: null, session: emptyUsage() },
                  recovery: null,
                  harnessThreads: {},
                  changedFiles: [],
                  activeRunId: next.id,
                  pendingApprovalId: null,
                  queue: { paused: true, items: [] }
                }
              }
            : next
        )
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
    expect(order.indexOf('run/lifecycle-open')).toBeLessThan(order.indexOf('harness/start'))
    const accept = core.send.mock.calls.find(
      ([command]) => command.type === 'run/lifecycle-open'
    )?.[0]
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

  it('opens the durable lifecycle once before contacting the Harness', async () => {
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
    expect(core.commands.filter((command) => command === 'run/lifecycle-open')).toHaveLength(1)
  })

  it('does not contact a Harness when a Project Skill loses trust before launch', async () => {
    const root = await readyClaudeRoot('run-skill-recheck-')
    const projectRoot = join(root, 'a-project')
    await mkdir(join(projectRoot, '.claude', 'skills', 'grilling'), { recursive: true })
    await writeFile(join(projectRoot, '.claude', 'skills', 'grilling', 'SKILL.md'), '# Project')
    const core = fakeCore(projectRoot)
    const broker = fakeBroker()
    let reads = 0
    const service = new RunService({
      core,
      broker,
      readiness: readyReadiness(join(root, 'claude')),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js',
      skills: (requestedRoot, harness) => {
        reads += 1
        return discoverSkills({
          homeDirectory: root,
          projectRoot: requestedRoot,
          harness,
          projectTrusted: reads === 1
        })
      }
    })

    await expect(
      service.start({
        submissionId: 'submission-1',
        sessionId: 'session',
        prompt: 'Use the Project Skill',
        harness: 'claude',
        model: 'claude-sonnet-4-5',
        effort: 'high',
        skill: 'grilling',
        permissionMode: 'auto'
      })
    ).rejects.toThrow('Project Skill trust changed')

    expect(reads).toBe(2)
    expect(broker.start).not.toHaveBeenCalled()
  })

  it('starts a Session by answering the message that created it, in one Run', async () => {
    const root = await readyHarnessRoot('run-start-session-')
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

    const started = await service.startSession({
      input: {
        projectRoot: join(root, 'a-project'),
        message: 'Grill me',
        checkout: LOCAL_CHECKOUT
      },
      run: {
        harness: 'claude',
        model: 'gpt-5-codex',
        effort: 'medium',
        permissionMode: 'ask'
      }
    })

    expect(started).toMatchObject({ session: { id: 'session' }, runStarted: true })
    expect(core.commands.indexOf('session/start')).toBeLessThan(
      core.commands.indexOf('conversation/submit')
    )
    // The Run answers the starting message rather than adding a second one:
    // Core deduplicates by submission identity, and this is that identity.
    const sent = core.send.mock.calls.flat() as { type: string; input?: unknown }[]
    const submit = sent.find((command) => command.type === 'conversation/submit')
    expect(submit?.input).toMatchObject({
      submissionId: startingSubmissionId('session'),
      text: 'Grill me'
    })
    expect(broker.start).toHaveBeenCalled()
  })

  it('leaves the starting message unanswered when no Run was configured', async () => {
    const root = await readyHarnessRoot('run-start-quiet-')
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

    const started = await service.startSession({
      input: {
        projectRoot: join(root, 'a-project'),
        message: 'Grill me',
        checkout: LOCAL_CHECKOUT
      },
      run: undefined
    })

    expect(started.runStarted).toBe(false)
    expect(core.commands).toContain('session/start')
    expect(broker.start).not.toHaveBeenCalled()
  })

  it('keeps a Session whose first Run could not start, message and all', async () => {
    const root = await readyHarnessRoot('run-start-unready-')
    const core = fakeCore(join(root, 'a-project'))
    const service = new RunService({
      core,
      broker: fakeBroker(),
      // No Harness this machine can run, which is what makes the Run fail.
      readiness: { refresh: vi.fn(() => Promise.resolve({ harnesses: [] })) },
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js',
      skills: fakeSkills(root)
    })

    // The Session exists and holds the message: it was created before the Run
    // was attempted, and losing it would lose what the person typed. That the
    // Run never started is reported rather than swallowed, so the surface that
    // opens the Session can say it is not working on anything yet.
    const started = await service.startSession({
      input: {
        projectRoot: join(root, 'a-project'),
        message: 'Grill me',
        checkout: LOCAL_CHECKOUT
      },
      run: {
        harness: 'claude',
        model: 'gpt-5-codex',
        effort: 'medium',
        permissionMode: 'ask'
      }
    })

    expect(started).toMatchObject({ session: { id: 'session' }, runStarted: false })
    expect(core.commands).toContain('conversation/submit')
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
      'started',
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

  it('reports the end of a Run, so surfaces that only listen stop saying it runs', async () => {
    // The Conversation re-reads itself while a Run is in flight and would find
    // out anyway. The inbox never re-reads: it is told, and a status dot
    // nobody updates goes on claiming a Session is working when it stopped.
    const root = await readyHarnessRoot('run-end-')
    const core = fakeCore(join(root, 'a-project'))
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

    // The process dies without the Harness ever saying why, which is the case
    // the Conversation cannot report on its own.
    broker.launch?.onExit?.(1, null)

    await vi.waitFor(() => {
      expect(streamed.at(-1)?.event).toMatchObject({ type: 'failed' })
    })
    // And it is said only once Core has written it, so a listener that reacts
    // by re-reading finds the ending already durable.
    expect(core.commands).toContain('run/lifecycle-complete')
    const terminal = (
      core.send.mock.calls as [
        { type: string; input?: { checkoutObservation?: { status?: string } } }
      ][]
    ).find(([command]) => command.type === 'run/lifecycle-complete')?.[0]
    expect(terminal?.input?.checkoutObservation).toEqual({ status: 'unavailable' })
  })

  it('publishes the terminal outcome Core confirmed, not the one Main proposed', async () => {
    const root = await readyHarnessRoot('run-core-outcome-')
    const core = fakeCore(join(root, 'a-project'))
    const send = core.send.getMockImplementation() as (command: {
      type: string
    }) => Promise<unknown>
    core.send.mockImplementation(async (command: { type: string }) => {
      const result = await send(command)
      if (command.type !== 'run/lifecycle-complete') return result
      const completed = result as { run: RunSnapshot; conversation: ConversationSnapshot }
      return { ...completed, run: { ...completed.run, status: 'stopped' } }
    })
    const broker = fakeBroker()
    const streamed: ConversationStreamEvent[] = []
    const service = new RunService({
      ...claudeDeps(root, broker),
      core,
      onConversationEvent: (event) => streamed.push(event)
    })
    await service.start({ ...startInput(), skill: 'grilling' })

    broker.launch?.onExit?.(0, null)

    await vi.waitFor(() => {
      expect(streamed.at(-1)?.event).toEqual({ type: 'stopped' })
    })
  })

  it('keeps a correctness-critical protocol failure failed even when Claude exits zero', async () => {
    const root = await readyClaudeRoot('run-protocol-failure-')
    const core = fakeCore(join(root, 'a-project'))
    core.events = [{ type: 'failed', category: 'protocol', summary: 'Unsupported Claude event' }]
    const broker = fakeBroker()
    const streamed: ConversationStreamEvent[] = []
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
      skills: fakeSkills(root),
      onConversationEvent: (event) => streamed.push(event)
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
      const terminal = (
        core.send.mock.calls as [{ type: string; input?: { observation?: { type?: string } } }][]
      )
        .filter(([command]) => command.type === 'run/lifecycle-complete')
        .at(-1)?.[0].input
      expect(terminal?.observation?.type).toBe('harness-failed')
    })
    expect(streamed.filter(({ event }) => event.type === 'failed')).toHaveLength(1)
    expect(core.commands).toContain('run/lifecycle-complete')
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
    expect(core.commands).toContain('run/lifecycle-complete')
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
    const terminal = (core.send.mock.calls as [{ type: string; input?: unknown }][]).find(
      ([command]) => command.type === 'run/lifecycle-complete'
    )?.[0].input
    expect(terminal).toMatchObject({
      runId: 'run-from-a-previous-session',
      observation: { type: 'harness-failed' },
      checkoutObservation: { status: 'unavailable' }
    })
    expect(core.commands).not.toContain('conversation/finalize')
  })

  it('does not report its own Run as crashed while the Harness process is still starting', async () => {
    const root = await readyClaudeRoot('run-starting-refresh-')
    const core = fakeCore(join(root, 'a-project'))
    const broker = fakeBroker({
      start: vi.fn(async (launch: RunLaunch) => {
        core.conversation = { ...core.conversation, activeRunId: launch.id }
        await service.conversation('session')
      })
    })
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

    await service.start(startInput())

    expect(core.commands).not.toContain('conversation/finalize')
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
      ([command]) => command.type === 'run/lifecycle-complete'
    )?.[0].input as { observation?: { summary?: string } } | undefined
    expect(finalize?.observation?.summary).toContain('Operation not permitted')
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

  it('pauses every Session queue before stopping Harnesses for shutdown', async () => {
    const root = await readyClaudeRoot('run-service-shutdown-')
    const broker = fakeBroker()
    const core = fakeCore(join(root, 'a-project'))
    const service = new RunService({ ...claudeDeps(root, broker), core })

    await service.stopAll('quit')

    const pauseIndex = core.commands.indexOf('conversation/queue-change')
    expect(pauseIndex).toBeGreaterThanOrEqual(0)
    expect(broker.stopAll).toHaveBeenCalledWith('quit')
    expect(core.commands.at(pauseIndex)).toBe('conversation/queue-change')
  })

  it('does not create a retry attempt when a claimed queue item recovers a terminal Run', async () => {
    const root = await readyClaudeRoot('run-service-claimed-recovery-')
    const broker = fakeBroker()
    const core = fakeCore(join(root, 'a-project'))
    const original = core.send.getMockImplementation()
    if (!original) throw new Error('Fake Core implementation missing')
    const accepted = ((await original({ type: 'run/lifecycle-open' })) as { run: RunSnapshot }).run
    core.commands.length = 0
    let acceptCalls = 0
    core.send.mockImplementation(async (command: { type: string }): Promise<unknown> => {
      if (command.type === 'run/lifecycle-open') {
        acceptCalls += 1
        return {
          run: { ...accepted, status: 'failed' },
          conversation: core.conversation
        }
      }
      return await Promise.resolve(original(command) as unknown)
    })
    const service = new RunService({ ...claudeDeps(root, broker), core })

    const recovered = await service.start(startInput(), false)

    expect(recovered.status).toBe('failed')
    expect(acceptCalls).toBe(1)
    expect(broker.start).not.toHaveBeenCalled()
  })

  it('reconciles a recovered claim against the newest derived attempt', async () => {
    const root = await readyClaudeRoot('run-service-newest-queue-attempt-')
    const broker = fakeBroker()
    const core = fakeCore(join(root, 'a-project'))
    const original = core.send.getMockImplementation()
    if (!original) throw new Error('Fake Core implementation missing')
    const base = ((await original({ type: 'run/lifecycle-open' })) as { run: RunSnapshot }).run
    core.commands.length = 0
    const item: QueuedSubmission = {
      kind: 'queued-submission',
      id: 'queued:submission-1',
      at: '2026-08-05T00:00:00.000Z',
      submissionId: 'submission-1',
      text: 'Latest edited prompt',
      source: 'composer',
      harness: base.configuration.harness,
      model: base.configuration.model,
      effort: base.configuration.effort,
      skill: base.configuration.skill?.name ?? null,
      permissionMode: base.configuration.permissionMode,
      reviewAttachments: [],
      status: 'claimed',
      position: 0
    }
    const newest = {
      ...base,
      id: 'run-attempt-2',
      submissionId: 'submission-1:attempt-2',
      prompt: item.text,
      status: 'failed' as const
    }
    core.send.mockImplementation(async (command: { type: string }): Promise<unknown> => {
      if (command.type === 'run/list') return [newest, { ...base, status: 'failed' }]
      if (command.type === 'conversation/queue-next') {
        return null
      }
      return await Promise.resolve(original(command) as unknown)
    })
    const service = new RunService({ ...claudeDeps(root, broker), core })

    await service.resumeConversationQueue('session')

    expect(core.commands.filter((command) => command === 'run/lifecycle-open')).toHaveLength(0)
    expect(core.commands).not.toContain('conversation/queue-launch-observed')
    expect(broker.start).not.toHaveBeenCalled()
  })

  it('retries a queued instruction after trust is restored instead of marking it sent', async () => {
    const root = await readyClaudeRoot('run-service-trust-restored-')
    const broker = fakeBroker()
    const core = fakeCore(join(root, 'a-project'))
    const original = core.send.getMockImplementation()
    if (!original) throw new Error('Fake Core implementation missing')
    const base = ((await original({ type: 'run/lifecycle-open' })) as { run: RunSnapshot }).run
    const item: QueuedSubmission = {
      kind: 'queued-submission',
      id: 'queued:submission-1',
      at: '2026-08-05T00:00:00.000Z',
      submissionId: 'submission-1',
      text: 'Rename the greeting',
      source: 'composer',
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'high',
      skill: 'wayfinder',
      permissionMode: 'auto',
      reviewAttachments: [],
      status: 'claimed',
      position: 0
    }
    const trustFailure = {
      ...base,
      prompt: item.text,
      status: 'failed' as const,
      configuration: {
        ...base.configuration,
        harness: item.harness,
        model: item.model,
        effort: item.effort,
        skill: { name: 'wayfinder', path: '/skills/wayfinder', hash: 'b'.repeat(64) }
      },
      activity: [
        {
          id: 'activity-trust',
          at: '2026-08-05T00:00:00.000Z',
          kind: 'error' as const,
          summary: 'Project Skill trust changed before the Harness was contacted'
        }
      ]
    }
    let claims = 0
    const acceptedSubmissions: string[] = []
    core.send.mockImplementation(async (command: { type: string; input?: unknown }) => {
      if (command.type === 'run/list') return [trustFailure]
      if (command.type === 'conversation/queue-next') {
        claims += 1
        return claims === 1
          ? {
              sessionId: 'session',
              item,
              runSubmissionId: 'submission-1:attempt-2',
              prompt: item.text
            }
          : null
      }
      if (command.type === 'run/lifecycle-open') {
        const input = command.input as { submissionId: string }
        acceptedSubmissions.push(input.submissionId)
        if (input.submissionId === item.submissionId) {
          throw new Error('Submission identity was already used')
        }
        return {
          run: {
            ...trustFailure,
            submissionId: input.submissionId,
            status: 'accepted',
            activity: []
          },
          conversation: core.conversation
        }
      }
      return await Promise.resolve(original(command) as unknown)
    })
    const service = new RunService({ ...claudeDeps(root, broker), core })

    await service.resumeConversationQueue('session')

    expect(acceptedSubmissions).toEqual(['submission-1:attempt-2'])
    expect(broker.start).toHaveBeenCalledTimes(1)
  })
})

function statusForObservation(type: string | undefined): RunSnapshot['status'] {
  switch (type) {
    case 'harness-completed':
      return 'completed'
    case 'person-stopped':
      return 'stopped'
    case 'policy-violation':
      return 'policy-violation'
    case 'supervision-failed':
      return 'supervision-failed'
    case 'harness-failed':
    case undefined:
    default:
      return 'failed'
  }
}

describe('a Run the app never got to finish', () => {
  /** A Project with one commit, as any Checkout would be. */
  async function project(root: string): Promise<string> {
    const checkout = join(root, 'a-project')
    await mkdir(checkout, { recursive: true })
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
    deps.core.unfinished = [{ sessionId: 'session', runId: 'run-abandoned' }]

    const service = new RunService(deps)
    await service.recoverUnfinishedWork()

    const terminal = deps.core.send.mock.calls
      .map(
        ([command]) =>
          command as {
            type: string
            input?: {
              runId?: string
              checkoutObservation?: { status: string; changes?: { path: string }[] }
            }
          }
      )
      .find((command) => command.type === 'run/lifecycle-complete')
    expect(terminal?.input?.runId).toBe('run-abandoned')
    expect(terminal?.input?.checkoutObservation).toMatchObject({ status: 'observed' })
    expect(terminal?.input?.checkoutObservation?.changes?.map((file) => file.path)).toEqual([
      'tracked.ts'
    ])
    expect(deps.core.commands).not.toContain('conversation/checkout-changes')
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

  it('keeps Checkout evidence when Core cannot confirm the recovered ending', async () => {
    const root = await readyClaudeRoot('run-service-recovery-failed-')
    const checkout = await project(root)
    const deps = claudeDeps(root, fakeBroker())
    const abandoned = join(deps.privateRoot, 'checkout-snapshots', 'run-key')
    const snapshot = await snapshotCheckout(checkout, abandoned)
    await writeFile(
      join(abandoned, 'baseline.json'),
      JSON.stringify({ sessionId: 'session', runId: 'run-abandoned', checkout, snapshot })
    )
    deps.core.unfinished = [{ sessionId: 'session', runId: 'run-abandoned' }]
    const send = deps.core.send.getMockImplementation() as (command: {
      type: string
    }) => Promise<unknown>
    deps.core.send.mockImplementation((command: { type: string }) =>
      command.type === 'run/lifecycle-complete'
        ? Promise.reject(new Error('Core unavailable'))
        : send(command)
    )

    await new RunService(deps).recoverUnfinishedWork()

    await expect(readdir(join(deps.privateRoot, 'checkout-snapshots'))).resolves.toEqual([
      'run-key'
    ])
  })

  it('keeps Checkout evidence when Core cannot list recovery work', async () => {
    const root = await readyClaudeRoot('run-service-recovery-query-failed-')
    const checkout = await project(root)
    const deps = claudeDeps(root, fakeBroker())
    const abandoned = join(deps.privateRoot, 'checkout-snapshots', 'run-key')
    const snapshot = await snapshotCheckout(checkout, abandoned)
    await writeFile(
      join(abandoned, 'baseline.json'),
      JSON.stringify({ sessionId: 'session', runId: 'run-abandoned', checkout, snapshot })
    )
    const send = deps.core.send.getMockImplementation() as (command: {
      type: string
    }) => Promise<unknown>
    deps.core.send.mockImplementation((command: { type: string }) =>
      command.type === 'conversation/unfinished'
        ? Promise.reject(new Error('Core unavailable'))
        : send(command)
    )

    await expect(new RunService(deps).recoverUnfinishedWork()).rejects.toThrow('Core unavailable')

    await expect(readdir(join(deps.privateRoot, 'checkout-snapshots'))).resolves.toEqual([
      'run-key'
    ])
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
      .map(
        ([command]) =>
          command as { type: string; input?: { runId?: string; observation?: { type?: string } } }
      )
      .find((command) => command.type === 'run/lifecycle-complete')
    expect(finalized?.input).toMatchObject({
      runId: 'run-open',
      observation: { type: 'harness-failed' }
    })
  })

  it('lets startup recovery own the terminal observation when a window reads concurrently', async () => {
    const root = await readyClaudeRoot('run-service-recovery-race-')
    const deps = claudeDeps(root, fakeBroker())
    deps.core.unfinished = [{ sessionId: 'session', runId: 'run-open' }]
    deps.core.conversation = { ...deps.core.conversation, activeRunId: 'run-open' }
    const service = new RunService(deps)

    await Promise.all([service.recoverUnfinishedWork(), service.conversation('session')])

    expect(
      deps.core.commands.filter((command) => command === 'run/lifecycle-complete')
    ).toHaveLength(1)
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

    expect(deps.core.commands).not.toContain('run/lifecycle-complete')
  })

  it('leaves a Run the broker is still running alone', async () => {
    const root = await readyClaudeRoot('run-service-still-going-')
    const broker = fakeBroker()
    broker.activeRunIds.mockReturnValue(['run-going'])
    const deps = claudeDeps(root, broker)
    deps.core.unfinished = [{ sessionId: 'session', runId: 'run-going' }]

    const service = new RunService(deps)
    await service.recoverUnfinishedWork()

    expect(deps.core.commands).not.toContain('run/lifecycle-complete')
  })
})
