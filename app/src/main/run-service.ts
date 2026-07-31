import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
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
import type { RunProcessBroker } from './run-process-broker'

interface CorePort {
  send(command: CoreCommand): Promise<unknown>
}
interface ReadinessPort {
  refresh(provider?: 'codex' | 'claude'): Promise<{
    providers: { provider: string; available: boolean; executablePath: string | null }[]
  }>
}

interface RunServiceDeps {
  core: CorePort
  broker: Pick<RunProcessBroker, 'start' | 'stop' | 'stopAll' | 'activeRunIds' | 'needsRecovery'>
  readiness: ReadinessPort
  libraryPath: () => string | undefined
  homeDirectory: string
  privateRoot: string
}

/** Coordinates durable Core acceptance with Main's native process authority. */
export class RunService {
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
    const spec = PROVIDER_SPECS[input.provider]
    const skillDirectory = join(this.deps.homeDirectory, spec.skillsRoot, input.workflow)
    const skillFile = join(skillDirectory, 'SKILL.md')
    const skillHash = createHash('sha256')
      .update(await readFile(skillFile))
      .digest('hex')
    const workingDirectory = join(library, input.relativePath)
    const configuration = {
      provider: input.provider,
      executable: provider.executablePath,
      model: input.model,
      effort: input.effort,
      workflow: input.workflow,
      skill: { name: input.workflow, path: skillDirectory, hash: skillHash },
      environment: minimalEnvironment(provider.executablePath, this.deps.homeDirectory),
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

    const runDirectory = join(this.deps.privateRoot, accepted.id)
    const planningDirectory = join(workingDirectory, '.scratch', input.relativePath)
    const policy = new PlanningPolicy({ workingDirectory, planningDirectory })
    await mkdir(runDirectory, { recursive: true, mode: 0o700 })
    await chmod(runDirectory, 0o700)
    const sandboxProfile = join(runDirectory, 'planning.sb')
    await writeFile(
      sandboxProfile,
      policy.renderSandboxProfile({
        runDirectory,
        executable: provider.executablePath,
        homeDirectory: this.deps.homeDirectory,
        skillDirectory
      }),
      { mode: 0o600 }
    )

    await this.record(
      accepted,
      'starting',
      'lifecycle',
      'Verified planning sandbox; starting provider'
    )
    try {
      await this.deps.broker.start({
        id: accepted.id,
        executable: provider.executablePath,
        args: providerArguments(input),
        workingDirectory,
        runDirectory,
        environment: configuration.environment,
        sandboxProfile,
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
      return await this.record(accepted, 'running', 'lifecycle', 'Provider process running')
    } catch (error) {
      await this.record(accepted, 'failed', 'error', 'Provider process could not start')
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
}

function minimalEnvironment(executable: string, home: string): Record<string, string> {
  return {
    PATH: `${dirname(executable)}:/usr/bin:/bin`,
    HOME: home,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8'
  }
}

function providerArguments(input: StartRunInput): string[] {
  const skillPrompt = `$${input.workflow} ${input.prompt}`
  if (input.provider === 'codex') {
    return [
      'exec',
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
    '--output-format',
    'stream-json',
    '--model',
    input.model,
    '--disallowedTools',
    'Bash',
    skillPrompt
  ]
}

function sanitize(value: string, workingDirectory: string): string {
  return value
    .replaceAll(workingDirectory, '<WORKING_DIRECTORY>')
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, '$1=[REDACTED: credential]')
    .slice(0, 2_000)
}
