import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CoreCommand } from '@shared/contract'
import {
  runSnapshotSchema,
  startRunInputSchema,
  type RunSnapshot,
  type StartRunInput
} from '@shared/run'
import { PROVIDER_SPECS } from './readiness'
import { PlanningPolicy } from './planning-policy'
import { PlanningToolHost } from './planning-tool-host'
import type { RunProcessBroker } from './run-process-broker'

interface CorePort {
  send(command: CoreCommand): Promise<unknown>
}
interface ReadinessPort {
  refresh(provider?: 'codex' | 'claude'): Promise<{
    providers: {
      provider: string
      available: boolean
      executablePath: string | null
      version: string | null
    }[]
  }>
}

interface RunServiceDeps {
  core: CorePort
  broker: Pick<RunProcessBroker, 'start' | 'stop' | 'stopAll' | 'activeRunIds' | 'needsRecovery'>
  readiness: ReadinessPort
  libraryPath: () => string | undefined
  homeDirectory: string
  privateRoot: string
  proxyExecutable: string
  proxyScript: string
}

/** Coordinates durable Core acceptance with Main's native process authority. */
export class RunService {
  private readonly toolHosts = new Map<string, PlanningToolHost>()

  constructor(private readonly deps: RunServiceDeps) {}

  async start(rawInput: StartRunInput): Promise<RunSnapshot> {
    const input = startRunInputSchema.parse(rawInput)
    const library = this.deps.libraryPath()
    if (!library) throw new Error('Open an Idea Library before starting a Run')
    const readiness = await this.deps.readiness.refresh(input.provider)
    const provider = readiness.providers.find((entry) => entry.provider === input.provider)
    if (!provider?.available || !provider.executablePath) {
      throw new Error(`${input.provider} is not ready for planning`)
    }
    if (!provider.version) throw new Error(`${input.provider} version provenance is unavailable`)
    const spec = PROVIDER_SPECS[input.provider]
    const skillDirectory = join(this.deps.homeDirectory, spec.skillsRoot, input.workflow)
    const skillFile = join(skillDirectory, 'SKILL.md')
    const skillHash = createHash('sha256')
      .update(await readFile(skillFile))
      .digest('hex')
    const executableHash = await hashFile(provider.executablePath)
    const workingDirectory = join(library, input.relativePath)
    const runKey = createHash('sha256')
      .update(`${workingDirectory}\0${input.submissionId}`)
      .digest('hex')
    const runDirectory = join(this.deps.privateRoot, runKey)
    const environment = minimalEnvironment(
      provider.executablePath,
      this.deps.homeDirectory,
      input.provider,
      runDirectory
    )
    const configuration = {
      provider: input.provider,
      executable: provider.executablePath,
      executableHash,
      providerVersion: provider.version,
      model: input.model,
      effort: input.effort,
      workflow: input.workflow,
      skill: { name: input.workflow, path: skillDirectory, hash: skillHash },
      environment,
      workingDirectory,
      permissionMode: input.permissionMode,
      permissionProfile: 'planning-v1' as const
    }
    const accepted = runSnapshotSchema.parse(
      await this.deps.core.send({
        type: 'run/accept',
        input: {
          submissionId: input.submissionId,
          relativePath: input.relativePath,
          prompt: input.prompt,
          configuration
        }
      })
    )
    if (accepted.status !== 'accepted') {
      if (
        ['completed', 'failed', 'stopped', 'policy-violation', 'supervision-failed'].includes(
          accepted.status
        )
      ) {
        return accepted
      }
      if (this.deps.broker.activeRunIds().includes(accepted.id)) return accepted
      return await this.record(
        accepted,
        'failed',
        'error',
        'Interrupted Run requires explicit recovery; the provider was not contacted again'
      )
    }
    if (this.deps.broker.needsRecovery()) {
      return await this.record(
        accepted,
        'supervision-failed',
        'error',
        'Supervision recovery is required before another Run can start'
      )
    }

    const planningDirectory = join(workingDirectory, '.scratch', input.relativePath)
    const policy = new PlanningPolicy({ workingDirectory, planningDirectory })
    const socketDirectory = join(
      tmpdir(),
      `idea-planning-${createHash('sha256').update(accepted.id).digest('hex').slice(0, 16)}`
    )
    const socketPath = join(socketDirectory, 'p.sock')
    const capabilityToken = randomUUID()
    let toolHost: PlanningToolHost | undefined
    const sandboxProfile = join(runDirectory, 'planning.sb')
    try {
      await mkdir(runDirectory, { recursive: true, mode: 0o700 })
      await chmod(runDirectory, 0o700)
      await mkdir(planningDirectory, { recursive: true, mode: 0o700 })
      await mkdir(socketDirectory, { recursive: true, mode: 0o700 })
      await chmod(socketDirectory, 0o700)
      await this.prepareProviderHome(input.provider, runDirectory, socketPath, capabilityToken)
      toolHost = new PlanningToolHost({
        socketPath,
        capabilityToken,
        workingDirectory,
        planningDirectory,
        callbacks: {
          onActivity: (kind, summary) =>
            this.record(accepted, undefined, kind, sanitize(summary, workingDirectory)).then(
              () => undefined
            ),
          onStop: (summary) => {
            void this.stopForPolicy(accepted, summary)
          }
        }
      })
      await toolHost.start()
      this.toolHosts.set(accepted.id, toolHost)
      await writeFile(
        sandboxProfile,
        policy.renderSandboxProfile({
          runDirectory,
          executable: provider.executablePath,
          proxyExecutable: this.deps.proxyExecutable,
          proxyScript: this.deps.proxyScript,
          socketPath
        }),
        { mode: 0o600 }
      )

      await this.record(
        accepted,
        'starting',
        'lifecycle',
        'Verified planning sandbox; starting provider'
      )
    } catch (error) {
      await toolHost?.close().catch(() => undefined)
      await Promise.all([
        rm(socketDirectory, { recursive: true, force: true }),
        rm(runDirectory, { recursive: true, force: true })
      ])
      await this.record(accepted, 'failed', 'error', 'Planning sandbox could not be prepared')
      throw error
    }
    try {
      if ((await hashFile(provider.executablePath)) !== executableHash) {
        await this.record(
          accepted,
          'failed',
          'error',
          'Provider executable changed after Run acceptance; provider was not contacted'
        )
        throw new Error('Provider executable changed after durable Run acceptance')
      }
      const running = await this.record(
        accepted,
        'running',
        'lifecycle',
        'Provider process running'
      )
      await this.deps.broker.start({
        id: accepted.id,
        executable: provider.executablePath,
        args: providerArguments(input, await readFile(skillFile, 'utf8'), runDirectory),
        workingDirectory,
        runDirectory,
        environment: configuration.environment,
        sandboxProfile,
        onBeforeCleanup: async () => {
          await toolHost.close()
          await rm(socketDirectory, { recursive: true, force: true })
          this.toolHosts.delete(accepted.id)
        },
        onActivity: (summary) =>
          void this.record(accepted, undefined, 'output', sanitize(summary, workingDirectory)),
        onExit: (code, signal) => {
          const stopped = signal === 'SIGTERM' || signal === 'SIGKILL'
          void this.record(
            accepted,
            stopped ? 'stopped' : code === 0 ? 'completed' : 'failed',
            code === 0 ? 'lifecycle' : 'error',
            stopped
              ? 'Provider process stopped'
              : code === 0
                ? 'Provider process completed'
                : 'Provider process failed'
          )
        },
        onSupervisionFailure: () => {
          void this.record(
            accepted,
            'supervision-failed',
            'error',
            'Provider process cleanup could not be verified'
          )
        },
        onLimitViolation: (summary) => {
          void this.record(accepted, 'policy-violation', 'blocked', summary)
        }
      })
      return running
    } catch (error) {
      await toolHost.close().catch(() => undefined)
      await rm(socketDirectory, { recursive: true, force: true })
      this.toolHosts.delete(accepted.id)
      if (!(error instanceof Error && error.message.includes('changed after durable'))) {
        await this.record(accepted, 'failed', 'error', 'Provider process could not start')
      }
      throw error
    }
  }

  async list(relativePath: string): Promise<RunSnapshot[]> {
    return runSnapshotSchema
      .array()
      .parse(await this.deps.core.send({ type: 'run/list', relativePath }))
  }

  async stop(runId: string, relativePath: string): Promise<RunSnapshot> {
    try {
      await this.deps.broker.stop(runId, 'user')
      return await this.record(
        { id: runId, relativePath },
        'stopped',
        'lifecycle',
        'Run stopped by user'
      )
    } catch (error) {
      await this.record(
        { id: runId, relativePath },
        'supervision-failed',
        'error',
        'Provider process cleanup could not be verified'
      )
      throw error
    }
  }

  stopAll(reason: 'core-crash' | 'quit' | 'update'): Promise<void> {
    return this.deps.broker.stopAll(reason)
  }

  private async record(
    run: Pick<RunSnapshot, 'id' | 'relativePath'>,
    status: RunSnapshot['status'] | undefined,
    kind: 'lifecycle' | 'allowed' | 'blocked' | 'output' | 'error',
    summary: string
  ): Promise<RunSnapshot> {
    return runSnapshotSchema.parse(
      await this.deps.core.send({
        type: 'run/event',
        input: {
          relativePath: run.relativePath,
          runId: run.id,
          ...(status ? { status } : {}),
          kind,
          summary
        }
      })
    )
  }

  private async prepareProviderHome(
    provider: StartRunInput['provider'],
    runDirectory: string,
    socketPath: string,
    capabilityToken: string
  ): Promise<void> {
    const proxy = {
      command: this.deps.proxyExecutable,
      args: [this.deps.proxyScript],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        PLANNING_MCP_SOCKET: socketPath,
        PLANNING_MCP_CAPABILITY: capabilityToken
      }
    }
    await writeFile(
      join(runDirectory, 'mcp.json'),
      JSON.stringify({ mcpServers: { planning: proxy } }),
      { mode: 0o600 }
    )
    if (provider !== 'codex') return
    const codexHome = join(runDirectory, 'codex-home')
    await mkdir(codexHome, { recursive: true, mode: 0o700 })
    await copyFile(
      join(this.deps.homeDirectory, '.codex', 'auth.json'),
      join(codexHome, 'auth.json')
    )
    await chmod(join(codexHome, 'auth.json'), 0o600)
    await writeFile(
      join(codexHome, 'config.toml'),
      `[mcp_servers.planning]\ncommand = ${JSON.stringify(proxy.command)}\nargs = [${proxy.args.map((value) => JSON.stringify(value)).join(', ')}]\n\n[mcp_servers.planning.env]\nELECTRON_RUN_AS_NODE = "1"\nPLANNING_MCP_SOCKET = ${JSON.stringify(socketPath)}\nPLANNING_MCP_CAPABILITY = ${JSON.stringify(capabilityToken)}\n`,
      { mode: 0o600 }
    )
  }

  private async stopForPolicy(run: RunSnapshot, summary: string): Promise<void> {
    await this.record(run, 'policy-violation', 'lifecycle', `Run stopped by policy: ${summary}`)
    try {
      await this.deps.broker.stop(run.id, 'policy')
    } catch {
      await this.record(
        run,
        'supervision-failed',
        'error',
        'Provider process cleanup could not be verified'
      )
    }
  }
}

function minimalEnvironment(
  executable: string,
  home: string,
  provider: StartRunInput['provider'],
  runDirectory: string
): Record<string, string> {
  return {
    PATH: `${dirname(executable)}:/usr/bin:/bin`,
    HOME: home,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    ...(provider === 'codex' ? { CODEX_HOME: join(runDirectory, 'codex-home') } : {})
  }
}

function providerArguments(
  input: StartRunInput,
  skillText: string,
  runDirectory: string
): string[] {
  const skillPrompt = `Verified planning workflow (${input.workflow}):\n\n${skillText}\n\nUser request:\n${input.prompt}`
  if (input.provider === 'codex') {
    return [
      'exec',
      '--ephemeral',
      '--ignore-rules',
      '--disable',
      'shell_tool',
      '--disable',
      'unified_exec',
      '--disable',
      'apps',
      '--disable',
      'browser_use',
      '--disable',
      'computer_use',
      '--disable',
      'hooks',
      '--disable',
      'plugins',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '--model',
      input.model,
      '-c',
      `model_reasoning_effort=${JSON.stringify(input.effort)}`,
      skillPrompt
    ]
  }
  return [
    '--print',
    '--disable-slash-commands',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    join(runDirectory, 'mcp.json'),
    '--tools',
    '',
    '--allowedTools',
    'mcp__planning__*',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    '--no-chrome',
    '--output-format',
    'stream-json',
    '--model',
    input.model,
    '--effort',
    input.effort,
    skillPrompt
  ]
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

function sanitize(value: string, workingDirectory: string): string {
  return value
    .replaceAll(workingDirectory, '<WORKING_DIRECTORY>')
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, '$1=[REDACTED: credential]')
    .slice(0, 2_000)
}
