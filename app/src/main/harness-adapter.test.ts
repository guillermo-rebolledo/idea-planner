import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createHarnessAdapter,
  harnessAdapterLayer,
  type HarnessAdapterDeps
} from './harness-adapter'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

function dependencies(root: string): HarnessAdapterDeps & {
  commands: { type: string; [key: string]: unknown }[]
} {
  const commands: { type: string; [key: string]: unknown }[] = []
  return {
    commands,
    core: {
      send: vi.fn((command: { type: string; [key: string]: unknown }) => {
        commands.push(command)
        if (command.type === 'harness/open') {
          return Promise.resolve({ events: [], outgoing: ['opening-frame'] })
        }
        if (command.type === 'harness/interrupt') return Promise.resolve(['interrupt-frame'])
        if (command.type === 'harness/answer') {
          return Promise.resolve({ answered: true, outgoing: ['approval-frame'] })
        }
        return Promise.resolve(undefined)
      })
    },
    homeDirectory: root,
    proxyExecutable: '/usr/bin/true',
    proxyScript: '/tmp/mcp-proxy.js',
    claudeOauthToken: vi.fn(() => Promise.resolve('oauth-token')),
    validateExecpolicy: vi.fn(() => Promise.resolve()),
    randomId: vi.fn(() => 'generated-id'),
    writeFrame: vi.fn()
  }
}

const configuration = {
  permissionMode: 'ask' as const,
  model: 'model-1',
  effort: 'high' as const,
  skill: { name: 'grilling', path: '/skills/grilling', hash: 'a'.repeat(64) }
}

describe('Harness adapter contract', () => {
  it('puts Codex preparation, continuity, protocol launch, interruption, and completion behind one adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-adapter-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, '.codex', 'sessions', '2026', '08', '06'), { recursive: true })
    await writeFile(join(root, '.codex', 'auth.json'), '{}')
    await writeFile(
      join(root, '.codex', 'sessions', '2026', '08', '06', 'rollout-thread-1.jsonl'),
      '{}\n'
    )
    const deps = dependencies(root)
    const adapter = createHarnessAdapter('codex', harnessAdapterLayer(deps))
    const runDirectory = join(root, 'run')
    await mkdir(runDirectory)

    expect(await Effect.runPromise(adapter.threadExists('/project', 'thread-1'))).toBe(true)
    await Effect.runPromise(
      adapter.prepare({
        runDirectory,
        socketPath: '/tmp/app.sock',
        capabilityToken: 'secret',
        permissionMode: 'ask',
        standingRules: ['prefix_rule(pattern=["pnpm", "test"], decision="allow")'],
        executable: '/opt/codex'
      })
    )
    expect(await realpath(join(runDirectory, 'codex-home', 'auth.json'))).toBe(
      await realpath(join(root, '.codex', 'auth.json'))
    )
    expect(await readFile(join(runDirectory, 'codex-home', 'config.toml'), 'utf8')).toContain(
      '[mcp_servers.app.tools.session_diff]\napproval_mode = "approve"'
    )
    expect(await readFile(join(runDirectory, 'codex-home', 'config.toml'), 'utf8')).not.toContain(
      'default_tools_approval_mode'
    )
    expect(await Effect.runPromise(adapter.environment('/opt/codex', runDirectory))).toMatchObject({
      CODEX_HOME: join(runDirectory, 'codex-home')
    })
    expect(
      await Effect.runPromise(
        adapter.arguments({ ...configuration, prompt: 'Rename it' }, runDirectory)
      )
    ).toEqual(['app-server'])

    const opened = await Effect.runPromise(
      adapter.open({
        runId: 'run-1',
        checkout: '/project',
        configuration,
        prompt: 'Rename it',
        skillInstructions: '# Grilling',
        resumeThreadId: 'thread-1'
      })
    )
    expect(opened.outgoing).toEqual(['opening-frame'])
    expect(deps.commands.find((command) => command.type === 'harness/open')).toMatchObject({
      harness: 'codex',
      launch: {
        approvalPolicy: 'untrusted',
        sandbox: 'workspace-write',
        resumeThreadId: 'thread-1'
      }
    })
    expect(await Effect.runPromise(adapter.interrupt('run-1'))).toBe(true)
    expect(deps.writeFrame).toHaveBeenCalledWith('run-1', 'interrupt-frame')
    expect(
      await Effect.runPromise(
        adapter.answerApproval({
          sessionId: 'session-1',
          runId: 'run-1',
          approvalId: 'approval-1',
          allowed: true,
          remembered: false,
          reason: undefined,
          proposal: {
            projectRoot: '/project',
            harness: 'codex',
            proposed: null,
            summary: 'pnpm test',
            continuation: {
              harness: 'codex',
              model: 'model-1',
              effort: 'high',
              skill: 'grilling',
              permissionMode: 'ask'
            }
          }
        })
      )
    ).toBe(true)
    expect(deps.writeFrame).toHaveBeenCalledWith('run-1', 'approval-frame')
    expect(adapter.terminalFact({ type: 'completed' })).toEqual({
      status: 'completed',
      kind: 'lifecycle',
      summary: 'Harness completed the turn'
    })
  })

  it('queues a bounded, redacted denial instruction when Codex cannot attach feedback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-denial-'))
    temporaryDirectories.push(root)
    const deps = dependencies(root)
    const adapter = createHarnessAdapter('codex', harnessAdapterLayer(deps))

    expect(
      await Effect.runPromise(
        adapter.answerApproval({
          sessionId: 'session-1',
          runId: 'run-1',
          approvalId: 'approval-1',
          allowed: false,
          remembered: false,
          reason: 'Run tests with token=secret-value instead',
          proposal: {
            projectRoot: '/project',
            harness: 'codex',
            proposed: null,
            summary: 'rm -rf build',
            continuation: {
              harness: 'codex',
              model: 'model-1',
              effort: 'high',
              skill: null,
              permissionMode: 'ask'
            }
          }
        })
      )
    ).toBe(true)
    expect(
      deps.commands.find((command) => command.type === 'conversation/queue-change')
    ).toMatchObject({
      input: {
        type: 'enqueue',
        input: {
          sessionId: 'session-1',
          text: 'Run tests with token=[REDACTED: credential] instead',
          source: 'composer',
          harness: 'codex',
          model: 'model-1',
          effort: 'high',
          permissionMode: 'ask',
          reviewAttachments: []
        }
      }
    })
  })

  it('puts Claude settings, credentials, native permissions, continuity, and approval transport behind the same seam', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-adapter-'))
    temporaryDirectories.push(root)
    const checkout = join(root, 'project')
    const projectKey = checkout.replaceAll('/', '-')
    await mkdir(join(root, '.claude', 'projects', projectKey), { recursive: true })
    await writeFile(join(root, '.claude', 'projects', projectKey, 'thread-1.jsonl'), '{}\n')
    const deps = dependencies(root)
    const adapter = createHarnessAdapter('claude', harnessAdapterLayer(deps))
    const runDirectory = join(root, 'run')
    await mkdir(runDirectory)

    expect(await Effect.runPromise(adapter.threadExists(checkout, 'thread-1'))).toBe(true)
    await Effect.runPromise(
      adapter.prepare({
        runDirectory,
        socketPath: '/tmp/app.sock',
        capabilityToken: 'secret',
        permissionMode: 'ask',
        standingRules: ['Bash(pnpm test:*)'],
        executable: '/opt/claude'
      })
    )
    const stagedSettings = JSON.parse(
      await readFile(join(runDirectory, 'settings.json'), 'utf8')
    ) as unknown
    expect(stagedSettings).toEqual({
      permissions: {
        defaultMode: 'default',
        allow: [
          'mcp__app__offer_response_options',
          'mcp__app__session_diff',
          'mcp__app__approval_request',
          'Bash(pnpm test:*)'
        ]
      }
    })
    expect(
      await Effect.runPromise(adapter.launchEnvironment('/opt/claude', runDirectory))
    ).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' })
    expect(
      await Effect.runPromise(
        adapter.arguments(
          {
            ...configuration,
            prompt: 'Rename it',
            skill: { ...configuration.skill, name: 'wayfinder' }
          },
          runDirectory,
          'Earlier turn',
          'thread-1'
        )
      )
    ).toEqual(expect.arrayContaining(['--permission-mode', 'default', '--resume', 'thread-1']))
    expect(adapter.terminalFact({ type: 'completed' })).toBeNull()
    expect(await Effect.runPromise(adapter.interrupt('run-1'))).toBe(false)
    expect(
      await Effect.runPromise(
        adapter.open({
          runId: 'run-1',
          checkout,
          configuration,
          prompt: 'Rename it',
          skillInstructions: ''
        })
      )
    ).toEqual({ events: [], outgoing: ['opening-frame'] })

    const host = {
      hasOutstandingApproval: vi.fn(() => true),
      resolveApproval: vi.fn(() => true)
    }
    const proposal = {
      projectRoot: checkout,
      harness: 'claude' as const,
      proposed: {
        harness: 'claude' as const,
        kind: 'command' as const,
        toolName: 'Bash',
        content: 'pnpm test:*'
      },
      summary: 'pnpm test',
      continuation: {
        harness: 'claude' as const,
        model: 'model-1',
        effort: 'high',
        skill: 'grilling' as const,
        permissionMode: 'ask' as const
      }
    }
    expect(
      await Effect.runPromise(
        adapter.answerApproval({
          sessionId: 'session-1',
          runId: 'run-1',
          approvalId: 'approval-1',
          allowed: true,
          remembered: true,
          reason: undefined,
          proposal,
          host
        })
      )
    ).toBe(true)
    expect(host.resolveApproval).toHaveBeenCalledWith(
      'approval-1',
      expect.objectContaining({ behavior: 'allow' })
    )
    await Effect.runPromise(
      adapter.answerApproval({
        sessionId: 'session-1',
        runId: 'run-1',
        approvalId: 'approval-2',
        allowed: false,
        remembered: false,
        reason: 'Run the focused tests instead',
        proposal,
        host
      })
    )
    expect(host.resolveApproval).toHaveBeenLastCalledWith('approval-2', {
      behavior: 'deny',
      message: 'Run the focused tests instead'
    })
  })

  it('keeps a Codex denial with no instruction on the existing fast path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-plain-denial-'))
    temporaryDirectories.push(root)
    const deps = dependencies(root)
    const adapter = createHarnessAdapter('codex', harnessAdapterLayer(deps))

    await Effect.runPromise(
      adapter.answerApproval({
        sessionId: 'session-1',
        runId: 'run-1',
        approvalId: 'approval-1',
        allowed: false,
        remembered: false,
        reason: undefined,
        proposal: {
          projectRoot: '/project',
          harness: 'codex',
          proposed: null,
          summary: 'rm -rf build',
          continuation: {
            harness: 'codex',
            model: 'model-1',
            effort: 'high',
            skill: null,
            permissionMode: 'ask'
          }
        }
      })
    )

    expect(deps.commands.map((command) => command.type)).toEqual(['harness/answer'])
  })

  it('fails through the tagged adapter channel before Claude sees invalid staged settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-adapter-invalid-'))
    temporaryDirectories.push(root)
    const deps = {
      ...dependencies(root),
      stageSettings: () => ({ permissions: { defaultMode: 'not-a-mode' } })
    }
    const adapter = createHarnessAdapter('claude', harnessAdapterLayer(deps))
    const runDirectory = join(root, 'run')
    await mkdir(runDirectory)

    const failure = await Effect.runPromise(
      Effect.flip(
        adapter.prepare({
          runDirectory,
          socketPath: '/tmp/app.sock',
          capabilityToken: 'secret',
          permissionMode: 'ask',
          standingRules: [],
          executable: '/opt/claude'
        })
      )
    )
    expect(failure).toMatchObject({ _tag: 'HarnessAdapterError', operation: 'prepare Claude' })
  })
})
