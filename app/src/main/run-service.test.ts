import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  emptyUsage,
  type CompactionPlan,
  type ConversationSnapshot,
  type ConversationStreamEvent,
  type HarnessEvent,
  type QueuedSubmission
} from '@shared/conversation'
import { LOCAL_CHECKOUT, startingSubmissionId, type SessionSummary } from '@shared/contract'
import { runConfigurationSchema, type RunSnapshot } from '@shared/run'
import type { RunLaunch } from './run-process-broker'
import { SessionSnapshotStore } from './snapshot-store'
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
    snapshots: new SessionSnapshotStore(join(root, 'private')),
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
  /** What Core would answer a compaction plan with, or nothing to refuse it. */
  compactionPlan?: CompactionPlan
  submitDisposition: 'accepted' | 'visible-replay' | 'rewound-replay'
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
      journalPosition: 0,
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
    unfinished: [],
    compactionPlan: undefined,
    submitDisposition: 'accepted'
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
      return Promise.resolve({
        events: state.events,
        outgoing: [],
        journalPositions: state.events.map(() => state.conversation.journalPosition)
      })
    }
    if (command.type === 'conversation/apply') {
      return Promise.resolve(state.conversation.journalPosition)
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
    if (command.type === 'conversation/compaction-plan') {
      if (!state.compactionPlan) return Promise.reject(new Error('nothing to compact'))
      return Promise.resolve(state.compactionPlan)
    }
    if (command.type === 'conversation/compact') return Promise.resolve(state.conversation)
    if (command.type === 'conversation/submit') {
      return Promise.resolve({
        snapshot: state.conversation,
        disposition: state.submitDisposition
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
 * What the Run asked its Harness to work on. Claude takes it as a launch
 * payload rather than as an argument, because the frame it becomes is written
 * to a stream that then stays open for the person's next message.
 */
function launchPrompt(core: FakeCore): string {
  const opened = core.send.mock.calls
    .map(([command]) => command as { type: string; launch?: { prompt?: string } })
    .findLast((command) => command.type === 'harness/open')
  return opened?.launch?.prompt ?? ''
}

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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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
    expect(broker.launch?.args).toEqual(
      expect.arrayContaining(['--input-format', 'stream-json', '--replay-user-messages'])
    )
    expect(broker.launch?.args).toEqual(expect.arrayContaining(['--setting-sources', 'user']))
    // The prompt is not on the command line at all: it is the first frame.
    expect(broker.launch?.args.some((argument) => argument.includes('Develop this Session'))).toBe(
      false
    )
    expect(launchPrompt(core)).toContain('/wayfinder Develop this Session')
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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

  it('seeds the Harness from local history when the saved Thread is gone', async () => {
    const root = await readyClaudeRoot('run-claude-lost-thread-')
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
        },
        {
          kind: 'message',
          id: 'message:1',
          at: '2026-07-31T12:00:01.000Z',
          runId: 'old',
          role: 'user',
          text: 'Where did we get to?',
          completeness: 'complete',
          source: 'composer',
          submissionId: 'old-submission',
          reviewAttachments: [],
          suggestedResponses: [],
          plainOptions: false
        }
      ]
    }
    // The rollout behind `saved-thread` is deliberately not on disk.
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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
    const args = broker.launch?.args ?? []
    expect(args).not.toContain('--resume')
    expect(launchPrompt(core)).toBe(
      '/wayfinder Continue\n\nDeterministic handoff from the Conversation so far:\nSkill: wayfinder\nRecent turns:\nUser: Where did we get to?'
    )
  })

  /** A service whose Harness answers one bounded request with `answer`. */
  function compactingService(
    core: FakeCore,
    root: string,
    answer: string
  ): { service: RunService; prompts: string[] } {
    const prompts: string[] = []
    const service = new RunService({
      core,
      broker: fakeBroker(),
      readiness: readyReadiness(join(root, 'claude')),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      snapshots: new SessionSnapshotStore(join(root, 'private')),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js',
      claudeOauthToken: fakeClaudeOauthToken,
      skills: fakeSkills(root),
      runBounded: (request) => {
        prompts.push(request.stdin)
        return Promise.resolve(answer)
      }
    })
    return { service, prompts }
  }

  it('writes the summary a compaction carries through one bounded Harness request', async () => {
    const root = await readyClaudeRoot('run-claude-compaction-')
    const core = fakeCore(join(root, 'a-project'))
    core.compactionPlan = {
      sessionId: 'session',
      runId: 'run-old',
      tailFromEntryId: 'message:tail',
      previousSummary: null,
      material: 'User: set up receipts\nAssistant: done',
      harness: 'claude'
    }
    const { service, prompts } = compactingService(
      core,
      root,
      '  Receipts are offline-first; the tests are green.\n'
    )

    await service.compact({ sessionId: 'session' })

    // Asked as prose, and told not to touch anything while it answers.
    expect(prompts[0]).toContain('Do not use any tools')
    expect(prompts[0]).toContain('User: set up receipts')
    const recorded = core.send.mock.calls
      .map(([command]) => command as { type: string; input?: Record<string, unknown> })
      .find((command) => command.type === 'conversation/compact')
    expect(recorded?.input).toMatchObject({
      sessionId: 'session',
      runId: 'run-old',
      tailFromEntryId: 'message:tail',
      summary: 'Receipts are offline-first; the tests are green.',
      native: false
    })
  })

  it('rewinds through Core without touching the Checkout, snapshots, or Harness process', async () => {
    const root = await readyClaudeRoot('run-claude-rewind-')
    const projectRoot = join(root, 'a-project')
    await mkdir(projectRoot, { recursive: true })
    await writeFile(join(projectRoot, 'kept.ts'), 'export const kept = true\n')
    const core = fakeCore(projectRoot)
    const broker = fakeBroker()
    const service = new RunService({
      core,
      broker,
      readiness: readyReadiness(join(root, 'claude')),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      snapshots: new SessionSnapshotStore(join(root, 'private')),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js',
      claudeOauthToken: fakeClaudeOauthToken,
      skills: fakeSkills(root)
    })

    await service.rewind({
      sessionId: 'session',
      operationId: 'rewind-1',
      targetEntryId: 'user:submission-1'
    })

    expect(core.commands).toEqual(['conversation/rewind'])
    expect(broker.start).not.toHaveBeenCalled()
    expect(broker.stop).not.toHaveBeenCalled()
    expect(broker.write).not.toHaveBeenCalled()
    expect(await readFile(join(projectRoot, 'kept.ts'), 'utf8')).toBe('export const kept = true\n')
  })

  it('returns Core idempotently when a restored rewind message is sent unchanged', async () => {
    const root = await readyClaudeRoot('run-claude-rewind-replay-')
    const core = fakeCore(join(root, 'a-project'))
    core.submitDisposition = 'rewound-replay'
    const broker = fakeBroker()
    const readiness = readyReadiness(join(root, 'claude'))
    const service = new RunService({
      core,
      broker,
      readiness,
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      snapshots: new SessionSnapshotStore(join(root, 'private')),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js',
      claudeOauthToken: fakeClaudeOauthToken,
      skills: fakeSkills(root)
    })

    await service.develop({
      sessionId: 'session',
      submissionId: 'submission-original',
      text: 'The original message',
      source: 'composer',
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'medium',
      permissionMode: 'auto'
    })

    expect(core.commands).toContain('conversation/submit')
    expect(core.commands).not.toContain('run/lifecycle-open')
    expect(readiness.refresh).not.toHaveBeenCalled()
    expect(broker.start).not.toHaveBeenCalled()
  })

  it('hands a second compaction the summary in force, to be rewritten rather than nested', async () => {
    const root = await readyClaudeRoot('run-claude-recompaction-')
    const core = fakeCore(join(root, 'a-project'))
    core.compactionPlan = {
      sessionId: 'session',
      runId: 'run-old',
      tailFromEntryId: 'message:tail',
      previousSummary: 'Receipts render offline.',
      material: 'User: now make them printable\nAssistant: done',
      harness: 'claude'
    }
    const { service, prompts } = compactingService(core, root, 'One summary, brought up to date.')

    await service.compact({ sessionId: 'session' })

    expect(prompts[0]).toContain('Receipts render offline.')
    expect(prompts[0]).toContain('Do not produce a summary of the summary')
  })

  it('holds the next Run until a compaction the person asked for has landed', async () => {
    const root = await readyClaudeRoot('run-claude-compaction-ordering-')
    const core = fakeCore(join(root, 'a-project'))
    core.compactionPlan = {
      sessionId: 'session',
      runId: 'run-old',
      tailFromEntryId: 'message:tail',
      previousSummary: null,
      material: 'User: a long session\nAssistant: indeed',
      harness: 'claude'
    }
    // A summary that takes its time, as a real Harness request does.
    let finishSummary = (): void => undefined
    const summarized = new Promise<string>((resolve) => {
      finishSummary = () => {
        resolve('What this Session established.')
      }
    })
    const service = new RunService({
      core,
      broker: fakeBroker(),
      readiness: readyReadiness(join(root, 'claude')),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      snapshots: new SessionSnapshotStore(join(root, 'private')),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js',
      claudeOauthToken: fakeClaudeOauthToken,
      skills: fakeSkills(root),
      runBounded: () => summarized
    })

    const compacting = service.compact({ sessionId: 'session' })
    // The composer stays live while a summary is written, so this is exactly
    // what a person sending their next message in that window does.
    let started = false
    const run = service
      .start({
        submissionId: 'submission-1',
        sessionId: 'session',
        prompt: 'Continue',
        harness: 'claude',
        model: 'claude-sonnet-4-5',
        effort: 'medium',
        permissionMode: 'auto'
      })
      .then((snapshot) => {
        started = true
        return snapshot
      })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // A Run that began here would resume the very Thread being retired, and
    // the boundary landing afterwards would retire its Thread for nothing.
    expect(started).toBe(false)
    expect(core.commands).not.toContain('run/lifecycle-open')

    finishSummary()
    await compacting
    await run
    expect(core.commands).toContain('conversation/compact')
    expect(core.commands.indexOf('conversation/compact')).toBeLessThan(
      core.commands.indexOf('run/lifecycle-open')
    )
  })

  it('compacts a Session whose latest Run left it no room, without being asked', async () => {
    const root = await readyClaudeRoot('run-claude-auto-compaction-')
    const core = fakeCore(join(root, 'a-project'))
    core.conversation = {
      ...core.conversation,
      usage: {
        run: { ...emptyUsage(), contextWindow: 200_000, contextUsed: 190_000 },
        session: emptyUsage()
      }
    }
    core.compactionPlan = {
      sessionId: 'session',
      runId: 'run-old',
      tailFromEntryId: 'message:tail',
      previousSummary: null,
      material: 'User: a long session\nAssistant: indeed',
      harness: 'claude'
    }
    const { service } = compactingService(core, root, 'What this Session established.')

    await service.start({
      submissionId: 'submission-1',
      sessionId: 'session',
      prompt: 'Continue',
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'medium',
      permissionMode: 'auto'
    })
    await service.stop(core.conversation.activeRunId ?? 'run-1', 'session')

    // Written beside the Run that ended rather than inside it: pressing Stop
    // does not wait on a Harness being asked for prose.
    await vi.waitFor(() => {
      expect(core.commands).toContain('conversation/compact')
    })
  })

  it('leaves a Session with room to spare alone', async () => {
    const root = await readyClaudeRoot('run-claude-room-to-spare-')
    const core = fakeCore(join(root, 'a-project'))
    core.conversation = {
      ...core.conversation,
      usage: {
        run: { ...emptyUsage(), contextWindow: 200_000, contextUsed: 20_000 },
        session: emptyUsage()
      }
    }
    core.compactionPlan = {
      sessionId: 'session',
      runId: 'run-old',
      tailFromEntryId: 'message:tail',
      previousSummary: null,
      material: 'User: short\nAssistant: yes',
      harness: 'claude'
    }
    const { service } = compactingService(core, root, 'Never asked for.')

    await service.start({
      submissionId: 'submission-1',
      sessionId: 'session',
      prompt: 'Continue',
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'medium',
      permissionMode: 'auto'
    })
    await service.stop(core.conversation.activeRunId ?? 'run-1', 'session')
    // The next Run waits on any compaction in flight, so starting one is how
    // this test proves there was never one to wait for.
    await service.start({
      submissionId: 'submission-2',
      sessionId: 'session',
      prompt: 'Carry on',
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'medium',
      permissionMode: 'auto'
    })

    expect(core.commands).not.toContain('conversation/compact')
  })

  it('starts a fresh Thread from the summary and the tail after a compaction', async () => {
    const root = await readyClaudeRoot('run-claude-compacted-')
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
        },
        {
          kind: 'message',
          id: 'message:answer',
          at: '2026-07-31T12:00:01.000Z',
          runId: 'old',
          role: 'assistant',
          text: 'Receipts render offline now',
          completeness: 'complete',
          source: 'harness',
          submissionId: null,
          reviewAttachments: [],
          suggestedResponses: [],
          plainOptions: false
        },
        {
          kind: 'boundary',
          id: 'boundary:compacted:compaction-1',
          at: '2026-07-31T12:00:02.000Z',
          runId: 'old',
          boundary: 'compacted',
          summary: 'Compacted',
          submissionId: null,
          recovery: null,
          compaction: {
            summary: 'Receipts are offline-first; the tests are green.',
            tailFromEntryId: 'message:tail',
            native: false
          }
        },
        {
          kind: 'message',
          id: 'message:tail',
          at: '2026-07-31T12:00:03.000Z',
          runId: null,
          role: 'user',
          text: 'Where did we get to?',
          completeness: 'complete',
          source: 'composer',
          submissionId: null,
          reviewAttachments: [],
          suggestedResponses: [],
          plainOptions: false
        }
      ]
    }
    // The rollout behind `saved-thread` is on disk and still resumable; the
    // compaction is what declines it.
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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

    const args = broker.launch?.args ?? []
    // The compacted Thread is not resumed, however resumable it still is.
    expect(args).not.toContain('--resume')
    const prompt = launchPrompt(core)
    expect(prompt).toContain('Summary of this Conversation up to the turns below:')
    expect(prompt).toContain('Receipts are offline-first; the tests are green.')
    expect(prompt).toContain('User: Where did we get to?')
    // The turns the summary stands in for are not sent again beside it.
    expect(prompt).not.toContain('Receipts render offline now')
  })

  it('starts a fresh Thread from the tail alone after a rewind', async () => {
    const root = await readyClaudeRoot('run-claude-rewound-')
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
        },
        {
          kind: 'message',
          id: 'message:old',
          at: '2026-07-31T12:00:01.000Z',
          runId: 'old',
          role: 'assistant',
          text: 'Discarded understanding',
          completeness: 'complete',
          source: 'harness',
          submissionId: null,
          reviewAttachments: [],
          suggestedResponses: [],
          plainOptions: false
        },
        {
          kind: 'message',
          id: 'message:tail',
          at: '2026-07-31T12:00:02.000Z',
          runId: null,
          role: 'user',
          text: 'The part that remains',
          completeness: 'complete',
          source: 'composer',
          submissionId: 'tail-submission',
          reviewAttachments: [],
          suggestedResponses: [],
          plainOptions: false
        },
        {
          kind: 'boundary',
          id: 'boundary:rewound:rewind-1',
          at: '2026-07-31T12:00:03.000Z',
          runId: 'old',
          boundary: 'rewound',
          summary: 'Rewound',
          submissionId: null,
          recovery: null,
          rewind: {
            rewoundToEntryId: 'message:discarded-prompt',
            tailFromEntryId: 'message:tail'
          }
        },
        {
          kind: 'message',
          id: 'user:submission-1',
          at: '2026-07-31T12:00:04.000Z',
          runId: null,
          role: 'user',
          text: 'Continue',
          completeness: 'complete',
          source: 'composer',
          submissionId: 'submission-1',
          reviewAttachments: [],
          suggestedResponses: [],
          plainOptions: false
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
      readiness: readyReadiness(join(root, 'claude')),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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

    const args = broker.launch?.args ?? []
    expect(args).not.toContain('--resume')
    const prompt = launchPrompt(core)
    expect(prompt).toContain('User: The part that remains')
    expect(prompt.match(/Continue/g)).toHaveLength(1)
    expect(prompt).not.toContain('Discarded understanding')
    expect(prompt).not.toContain('Summary of this Conversation')
  })

  it('freezes executable and Skill provenance into the durable lifecycle', async () => {
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
    let accepted: RunSnapshot | undefined
    const core = {
      send: vi.fn((command: { type: string; input?: unknown }) => {
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
            journalPosition: 0,
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
                  journalPosition: 0,
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
      start: vi.fn(async (launch: { args: string[]; onBeforeCleanup?: () => Promise<void> }) => {
        await launch.onBeforeCleanup?.()
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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

  it('delivers an admitted Codex correction to the active Run', async () => {
    const root = await readyHarnessRoot('run-steer-')
    const core = fakeCore(join(root, 'a-project'))
    const original = core.send.getMockImplementation()
    if (!original) throw new Error('Fake Core implementation missing')
    core.send.mockImplementation(async (command: { type: string }): Promise<unknown> => {
      if (command.type === 'conversation/admit-steer') {
        return { delivery: 'steer', conversation: core.conversation }
      }
      if (command.type === 'harness/steer') {
        return { steered: true, outgoing: ['steer-frame'], conversation: null }
      }
      return await Promise.resolve(original(command) as unknown)
    })
    const broker = fakeBroker()
    const service = new RunService({
      core,
      broker,
      readiness: {
        refresh: vi.fn(() =>
          Promise.resolve({
            harnesses: [
              {
                harness: 'codex',
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js',
      skills: fakeSkills(root)
    })
    await service.develop({
      sessionId: 'session',
      submissionId: 'submission-1',
      text: 'Start here',
      source: 'composer',
      harness: 'codex',
      model: 'gpt-5-codex',
      effort: 'medium',
      permissionMode: 'auto'
    })
    const runId = broker.launch?.id
    if (!runId) throw new Error('Run did not launch')
    core.commands.length = 0
    core.send.mockClear()

    await service.develop({
      sessionId: 'session',
      submissionId: 'correction-1',
      text: 'Keep the API compatible',
      source: 'composer',
      harness: 'codex',
      model: 'gpt-5-codex',
      effort: 'medium',
      permissionMode: 'auto',
      delivery: { type: 'steer', runId }
    })

    const commands = core.send.mock.calls.map(([command]) => (command as { type: string }).type)
    expect(commands).toContain('conversation/admit-steer')
    expect(commands).toContain('harness/steer')
    expect(broker.written).toContain('steer-frame')
    expect(commands).not.toContain('run/lifecycle-open')
  })

  it('delivers an admitted Claude correction into the turn already running', async () => {
    const root = await readyClaudeRoot('run-steer-claude-')
    const core = fakeCore(join(root, 'a-project'))
    const original = core.send.getMockImplementation()
    if (!original) throw new Error('Fake Core implementation missing')
    core.send.mockImplementation(async (command: { type: string }): Promise<unknown> => {
      if (command.type === 'conversation/admit-steer') {
        return { delivery: 'steer', conversation: core.conversation }
      }
      if (command.type === 'harness/steer') {
        return { steered: true, outgoing: ['steer-frame'], conversation: null }
      }
      if (command.type === 'harness/open') {
        return { events: [], outgoing: ['prompt-frame'] }
      }
      return await Promise.resolve(original(command) as unknown)
    })
    const broker = fakeBroker()
    const service = new RunService({
      core,
      broker,
      readiness: readyReadiness(join(root, 'claude')),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      snapshots: new SessionSnapshotStore(join(root, 'private')),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js',
      claudeOauthToken: fakeClaudeOauthToken,
      skills: fakeSkills(root)
    })
    await service.develop({
      sessionId: 'session',
      submissionId: 'submission-1',
      text: 'Start here',
      source: 'composer',
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'high',
      permissionMode: 'auto'
    })
    const runId = broker.launch?.id
    if (!runId) throw new Error('Run did not launch')
    // The Harness is spoken to rather than only read: what the Run is for
    // reaches it as a frame, and its stdin stays open afterwards.
    expect(broker.launch?.answersProtocol).toBe(true)
    expect(broker.written).toContain('prompt-frame')
    core.send.mockClear()

    await service.develop({
      sessionId: 'session',
      submissionId: 'correction-1',
      text: 'Keep the API compatible',
      source: 'composer',
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'high',
      permissionMode: 'auto',
      delivery: { type: 'steer', runId }
    })

    const commands = core.send.mock.calls.map(([command]) => (command as { type: string }).type)
    expect(commands).toContain('conversation/admit-steer')
    expect(commands).toContain('harness/steer')
    expect(broker.written).toContain('steer-frame')
    // A correction is not a second Run.
    expect(commands).not.toContain('run/lifecycle-open')
  })

  it('keeps an ended-Run correction queued when Core rejects the target', async () => {
    const root = await readyHarnessRoot('run-steer-race-')
    const core = fakeCore(join(root, 'a-project'))
    const original = core.send.getMockImplementation()
    if (!original) throw new Error('Fake Core implementation missing')
    core.send.mockImplementation(async (command: { type: string }): Promise<unknown> => {
      if (command.type === 'conversation/admit-steer') {
        return { delivery: 'queue', conversation: core.conversation }
      }
      return await Promise.resolve(original(command) as unknown)
    })
    const broker = fakeBroker()
    const service = new RunService({
      core,
      broker,
      readiness: {
        refresh: vi.fn(() =>
          Promise.resolve({
            harnesses: [
              {
                harness: 'codex',
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js',
      skills: fakeSkills(root)
    })
    await service.develop({
      sessionId: 'session',
      submissionId: 'submission-1',
      text: 'Start here',
      source: 'composer',
      harness: 'codex',
      model: 'gpt-5-codex',
      effort: 'medium',
      permissionMode: 'auto'
    })
    const runId = broker.launch?.id
    if (!runId) throw new Error('Run did not launch')
    core.commands.length = 0
    core.send.mockClear()

    await service.develop({
      sessionId: 'session',
      submissionId: 'correction-1',
      text: 'Keep the API compatible',
      source: 'composer',
      harness: 'codex',
      model: 'gpt-5-codex',
      effort: 'medium',
      permissionMode: 'auto',
      delivery: { type: 'steer', runId }
    })

    const commands = core.send.mock.calls.map(([command]) => (command as { type: string }).type)
    expect(commands).toContain('conversation/admit-steer')
    expect(commands).not.toContain('harness/steer')
    expect(commands).not.toContain('run/lifecycle-open')
  })

  it('honors queue delivery without asking an unsupported Harness to steer', async () => {
    const root = await readyHarnessRoot('run-delivery-queue-')
    const core = fakeCore(join(root, 'a-project'))
    const service = new RunService({
      core,
      broker: fakeBroker(),
      readiness: readyReadiness(join(root, 'claude')),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      snapshots: new SessionSnapshotStore(join(root, 'private')),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js',
      skills: fakeSkills(root)
    })

    await service.develop({
      sessionId: 'session',
      submissionId: 'correction-1',
      text: 'Keep the API compatible',
      source: 'composer',
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'high',
      permissionMode: 'auto',
      delivery: { type: 'queue' }
    })

    expect(core.commands).toContain('conversation/queue-change')
    expect(core.commands).not.toContain('harness/steer')
    expect(core.commands).not.toContain('run/lifecycle-open')
  })

  it('queues a steer intent when Main holds no Adapter for the named Run', async () => {
    const root = await readyHarnessRoot('run-steer-unknown-')
    const core = fakeCore(join(root, 'a-project'))
    const service = new RunService({
      core,
      broker: fakeBroker(),
      readiness: readyReadiness(join(root, 'claude')),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      snapshots: new SessionSnapshotStore(join(root, 'private')),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js',
      skills: fakeSkills(root)
    })

    await service.develop({
      sessionId: 'session',
      submissionId: 'correction-1',
      text: 'Keep the API compatible',
      source: 'composer',
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'high',
      permissionMode: 'auto',
      delivery: { type: 'steer', runId: 'active-claude-run' }
    })

    // Nothing here knows what that Run is doing, and a correction offered to a
    // Harness this app is not holding open is a correction that goes nowhere.
    expect(core.commands).toContain('conversation/queue-change')
    expect(core.commands).not.toContain('conversation/admit-steer')
    expect(core.commands).not.toContain('harness/steer')
  })

  it('sends reviewed code to the Harness while the Conversation keeps the prose', async () => {
    const root = await readyHarnessRoot('run-develop-attached-')
    const core = fakeCore(join(root, 'a-project'))
    const service = new RunService({
      core,
      broker: fakeBroker(),
      readiness: readyReadiness(join(root, 'claude')),
      homeDirectory: root,
      privateRoot: join(root, 'private'),
      snapshots: new SessionSnapshotStore(join(root, 'private')),
      proxyExecutable: '/usr/bin/true',
      proxyScript: '/tmp/mcp-proxy.js',
      skills: fakeSkills(root)
    })
    const attachment = {
      id: 'file-change:run-1:1:hunk-0',
      path: 'src/greeting.ts',
      runId: 'run-1',
      entryId: 'file-change:run-1:1',
      scope: 'hunk' as const,
      hunkIndex: 0,
      startLine: 1,
      endLine: 1,
      lines: ['+const greeting = "goodbye"'],
      shortened: false,
      capturedAt: '2026-08-07T10:00:00.000Z'
    }

    await service.develop({
      sessionId: 'session',
      submissionId: 'submission-1',
      text: 'Make this shorter',
      source: 'composer',
      reviewAttachments: [attachment],
      harness: 'claude',
      model: 'gpt-5-codex',
      effort: 'medium',
      permissionMode: 'auto'
    })

    const submitted = core.send.mock.calls
      .map(([command]) => command as { type: string; input?: Record<string, unknown> })
      .find((command) => command.type === 'conversation/submit')
    expect(submitted?.input).toMatchObject({
      text: 'Make this shorter',
      reviewAttachments: [attachment]
    })
    const opened = core.send.mock.calls
      .map(([command]) => command as { type: string; input?: { prompt?: string } })
      .find((command) => command.type === 'run/lifecycle-open')
    expect(opened?.input?.prompt).toContain('Make this shorter')
    expect(opened?.input?.prompt).toContain('<reviewed-code count="1">')
    expect(opened?.input?.prompt).toContain('+const greeting = "goodbye"')
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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
    core.conversation = { ...core.conversation, journalPosition: 42 }
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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
    expect(streamed.map((entry) => entry.invalidation)).toEqual(['mailbox', 'none', 'none', 'none'])
    expect(streamed.map((entry) => entry.journalPosition)).toEqual([42, 42, 42, 42])
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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
    expect(streamed.at(-1)?.invalidation).toBe('mailbox')
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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
      // The first ending is the one that counts, and it is the failure the
      // Harness reported: Claude's stream now ends the Run, so the process is
      // stopped by the app rather than waited on, and Core keeps the ending it
      // already wrote whatever a later exit code says.
      const terminal = (
        core.send.mock.calls as [{ type: string; input?: { observation?: { type?: string } } }][]
      ).find(([command]) => command.type === 'run/lifecycle-complete')?.[0].input
      expect(terminal?.observation?.type).toBe('harness-failed')
    })
    expect(broker.stop).toHaveBeenCalled()
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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
      snapshots: new SessionSnapshotStore(join(root, 'private')),
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

    expect(core.commands).toContain('conversation/queue-change')
    expect(broker.stopAll).toHaveBeenCalledWith('quit')
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

  /** A Run that started and never concluded: the app was quit, or it crashed. */
  async function abandon(
    deps: ReturnType<typeof claudeDeps>,
    checkout: string,
    sessionId = 'session'
  ): Promise<SessionSnapshotStore> {
    const snapshots = new SessionSnapshotStore(deps.privateRoot)
    await snapshots.capture({ sessionId, runId: 'run-abandoned', checkout, phase: 'before' })
    return snapshots
  }

  it('reports what it changed on the next start, and keeps the snapshot for undo', async () => {
    const root = await readyClaudeRoot('run-service-abandoned-')
    const checkout = await project(root)
    const deps = claudeDeps(root, fakeBroker())
    const snapshots = await abandon(deps, checkout)
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
    // Both halves are now on record, so the recovered Run can still be undone
    // (ADR 0006). Recovery observed and recorded; it applied nothing.
    const record = await snapshots.read('session', 'run-abandoned')
    expect(record?.before).toEqual(expect.any(String))
    expect(record?.after).toEqual(expect.any(String))
    await expect(readFile(join(checkout, 'tracked.ts'), 'utf8')).resolves.toBe(
      'changed by the agent\n'
    )
  })

  it('keeps a Session’s snapshots and removes only stores no Session claims', async () => {
    const root = await readyClaudeRoot('run-service-rubbish-')
    const checkout = await project(root)
    const deps = claudeDeps(root, fakeBroker())
    const snapshots = await abandon(deps, checkout)
    await snapshots.capture({
      sessionId: 'a-session-since-deleted',
      runId: 'run-gone',
      checkout,
      phase: 'before'
    })

    await new RunService(deps).recoverUnfinishedWork()

    expect(await snapshots.read('session', 'run-abandoned')).not.toBeNull()
    expect(await snapshots.read('a-session-since-deleted', 'run-gone')).toBeNull()
  })

  it('keeps the snapshots of a damaged Session rather than pruning it as gone', async () => {
    const root = await readyClaudeRoot('run-service-damaged-')
    const checkout = await project(root)
    const deps = claudeDeps(root, fakeBroker())
    const snapshots = await abandon(deps, checkout, 'damaged-session')
    // Core reports a Session whose record could not be read separately, so it
    // can be shown rather than inferred. It is not a Session that has gone.
    const send = deps.core.send.getMockImplementation() as (command: {
      type: string
    }) => Promise<unknown>
    deps.core.send.mockImplementation((command: { type: string }) =>
      command.type === 'session/list-damaged' ? Promise.resolve(['damaged-session']) : send(command)
    )

    await new RunService(deps).recoverUnfinishedWork()

    expect(await snapshots.read('damaged-session', 'run-abandoned')).not.toBeNull()
  })

  it('keeps Checkout evidence when Core cannot confirm the recovered ending', async () => {
    const root = await readyClaudeRoot('run-service-recovery-failed-')
    const checkout = await project(root)
    const deps = claudeDeps(root, fakeBroker())
    const snapshots = await abandon(deps, checkout)
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

    expect((await snapshots.read('session', 'run-abandoned'))?.before).toEqual(expect.any(String))
  })

  it('keeps Checkout evidence when Core cannot list recovery work', async () => {
    const root = await readyClaudeRoot('run-service-recovery-query-failed-')
    const checkout = await project(root)
    const deps = claudeDeps(root, fakeBroker())
    const snapshots = await abandon(deps, checkout)
    const send = deps.core.send.getMockImplementation() as (command: {
      type: string
    }) => Promise<unknown>
    deps.core.send.mockImplementation((command: { type: string }) =>
      command.type === 'conversation/unfinished'
        ? Promise.reject(new Error('Core unavailable'))
        : send(command)
    )

    await expect(new RunService(deps).recoverUnfinishedWork()).rejects.toThrow('Core unavailable')

    expect((await snapshots.read('session', 'run-abandoned'))?.before).toEqual(expect.any(String))
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
