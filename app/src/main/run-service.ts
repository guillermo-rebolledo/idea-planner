import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { CoreCommand } from '@shared/contract'
import {
  PROVIDER_DEFAULT_MODEL,
  conversationSnapshotSchema,
  developIdeaInputSchema,
  harnessEventSchema,
  redactCredentials,
  type ConversationSnapshot,
  type ConversationStreamEvent,
  type DevelopIdeaInput,
  type FinalizeConversationRunInput,
  type HarnessEvent,
  type HarnessFailureCategory
} from '@shared/conversation'
import {
  runSnapshotSchema,
  startRunInputSchema,
  type RunActivityKind,
  type RunSnapshot,
  type StartRunInput
} from '@shared/run'
import { PROVIDER_SPECS, VERIFIED_WORKFLOW_SKILLS } from './readiness'
import { PlanningPolicy } from './planning-policy'
import { PlanningToolHost } from './planning-tool-host'
import { mergeProviderLaunches, resolveProviderLaunch } from './provider-launch'
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
  claudeOauthToken?: () => Promise<string>
  /** Delivers normalized assistant and control events straight to the window. */
  onConversationEvent?: (event: ConversationStreamEvent) => void
}

/** Coordinates durable Core acceptance with Main's native process authority. */
export class RunService {
  private readonly toolHosts = new Map<string, PlanningToolHost>()
  /** The last failure a Run's provider reported, used when the Run ends. */
  private readonly failures = new Map<string, HarnessFailureCategory>()
  /**
   * The last thing a Run's provider wrote to its diagnostic stream. When a
   * process dies without reporting a failure of its own, this is the only
   * explanation there is, so it becomes what the person is told.
   */
  private readonly diagnostics = new Map<string, string>()
  private readonly pendingIngest = new Map<string, Promise<void>>()

  constructor(private readonly deps: RunServiceDeps) {}

  /**
   * Develops an Idea through its Conversation: the person's message is
   * accepted durably first, and only then does one planning Run start. A Run
   * that never reaches the provider leaves the message and a recovery choice.
   */
  async develop(rawInput: DevelopIdeaInput): Promise<ConversationSnapshot> {
    const input = developIdeaInputSchema.parse(rawInput)
    if (!PROVIDER_SPECS[input.provider].conversation) {
      throw new Error(
        `Developing an Idea with ${PROVIDER_SPECS[input.provider].displayName} is not supported yet`
      )
    }
    await this.deps.core.send({
      type: 'conversation/submit',
      input: {
        relativePath: input.relativePath,
        submissionId: input.submissionId,
        text: input.text,
        source: input.source
      }
    })
    try {
      await this.start({
        submissionId: input.submissionId,
        relativePath: input.relativePath,
        prompt: input.text,
        provider: input.provider,
        model: input.model,
        effort: input.effort,
        workflow: input.workflow,
        permissionMode: input.permissionMode
      })
    } catch (error) {
      const snapshot = await this.readConversation(input.relativePath)
      // A failure the Conversation already explains becomes recovery state the
      // person can act on. Anything else — an unready provider, say — is not
      // about this Run and has to reach them as an error.
      if (snapshot.recovery === null && snapshot.activeRunId === null) throw error
      return snapshot
    }
    return await this.readConversation(input.relativePath)
  }

  /**
   * Reads the Conversation, reconciling a Run the app no longer supervises.
   * After a crash or a forced quit the durable history can still name an
   * active Run; leaving it that way would block the person out of their own
   * Idea, so it is closed as interrupted and offered back for resending.
   */
  async conversation(relativePath: string): Promise<ConversationSnapshot> {
    const snapshot = await this.readConversation(relativePath)
    if (!snapshot.activeRunId || this.deps.broker.activeRunIds().includes(snapshot.activeRunId)) {
      return snapshot
    }
    await this.deps.core.send({
      type: 'conversation/finalize',
      input: {
        relativePath,
        runId: snapshot.activeRunId,
        outcome: 'failed',
        category: 'process-crash',
        summary: 'The app stopped supervising this Run before it answered'
      }
    })
    return await this.readConversation(relativePath)
  }

  private readConversation(relativePath: string): Promise<ConversationSnapshot> {
    return this.deps.core
      .send({ type: 'conversation/get', relativePath })
      .then((result) => conversationSnapshotSchema.parse(result))
  }

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
    const skillName = VERIFIED_WORKFLOW_SKILLS[input.workflow]
    if (!skillName) {
      throw new Error(`${input.workflow} is not a verified planning workflow`)
    }
    const spec = PROVIDER_SPECS[input.provider]
    const skillDirectory = join(this.deps.homeDirectory, spec.skillsRoot, skillName)
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
      skill: { name: skillName, path: skillDirectory, hash: skillHash },
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
    const conversation = await this.readConversation(input.relativePath)
    const latestHarness = [...conversation.entries]
      .reverse()
      .find(
        (entry): entry is Extract<typeof entry, { kind: 'boundary' }> =>
          entry.kind === 'boundary' && entry.provider !== undefined
      )?.provider
    const savedSession = conversation.providerSessions[input.provider]
    const switchedProvider = latestHarness !== undefined && latestHarness !== input.provider
    const latestProviderBoundary = [...conversation.entries]
      .reverse()
      .find(
        (entry): entry is Extract<typeof entry, { kind: 'boundary' }> =>
          entry.kind === 'boundary' && entry.provider === input.provider
      )
    const sessionCompatible =
      savedSession !== undefined &&
      latestProviderBoundary?.workflow === input.workflow &&
      latestProviderBoundary.model === input.model &&
      (input.provider !== 'claude' ||
        (await claudeSessionExists(this.deps.homeDirectory, workingDirectory, savedSession)))
    const restoreFromHistory =
      switchedProvider || (latestHarness === input.provider && !sessionCompatible)
    const handoff = await deterministicHandoff(
      conversation,
      input.workflow,
      join(workingDirectory, planningRelativePathFor(input)),
      planningRelativePathFor(input)
    )
    // The Conversation records the Run boundary before anything can fail, so
    // every later outcome has somewhere understandable to land.
    await this.deps.core.send({
      type: 'conversation/begin',
      relativePath: input.relativePath,
      runId: accepted.id,
      submissionId: input.submissionId,
      provider: input.provider,
      workflow: input.workflow,
      model: input.model,
      restorationNote: latestHarness === input.provider && !sessionCompatible
    })
    await this.record(
      accepted,
      undefined,
      'lifecycle',
      `Invoking the verified ${skillName} skill, based on Matt Pocock’s MIT-licensed skills`
    )
    if (this.deps.broker.needsRecovery()) {
      return await this.conclude(
        accepted,
        'supervision-failed',
        'error',
        'Supervision recovery is required before another Run can start'
      )
    }

    const planningRelativePath = planningRelativePathFor(input)
    const planningDirectory = join(workingDirectory, planningRelativePath)
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
      // A socket file left behind by a crash would otherwise make this Run's
      // capability socket unbindable; the path belongs to this Run alone.
      await rm(socketPath, { force: true })
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
          },
          onChoices: (question, options) => {
            void this.offerChoices(accepted, question, options)
          },
          onWorkflowCompletion: () => {
            if (input.workflow !== 'wayfinder') return
            void hasCompletedWayfinderMap(planningDirectory).then((complete) => {
              if (complete) {
                void this.applyConversationEvent(accepted, {
                  type: 'workflow-completion-suggested'
                })
              }
            })
          }
        }
      })
      await toolHost.start()
      this.toolHosts.set(accepted.id, toolHost)
      await writeFile(
        sandboxProfile,
        policy.renderSandboxProfile({
          runDirectory,
          // The provider and the planning proxy both have to start inside
          // this profile. The verified skills location is readable because
          // providers scan the root, and this Run's workflow lives in it.
          launch: mergeProviderLaunches(
            await resolveProviderLaunch(provider.executablePath, [
              join(this.deps.homeDirectory, spec.skillsRoot)
            ]),
            await resolveProviderLaunch(this.deps.proxyExecutable),
            ...(input.provider === 'claude'
              ? [await resolveProviderLaunch('/usr/bin/security')]
              : [])
          ),
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
      await this.conclude(accepted, 'failed', 'error', 'Planning sandbox could not be prepared')
      throw error
    }
    try {
      if ((await hashFile(provider.executablePath)) !== executableHash) {
        await this.conclude(
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
      const providerEnvironment =
        input.provider === 'claude'
          ? {
              ...configuration.environment,
              CLAUDE_CODE_OAUTH_TOKEN: await (this.deps.claudeOauthToken ?? readClaudeOauthToken)()
            }
          : configuration.environment
      await this.deps.broker.start({
        id: accepted.id,
        executable: provider.executablePath,
        args: providerArguments(
          input,
          await readFile(skillFile, 'utf8'),
          runDirectory,
          planningRelativePath,
          restoreFromHistory ? handoff : undefined,
          sessionCompatible ? savedSession : undefined
        ),
        workingDirectory,
        runDirectory,
        environment: providerEnvironment,
        sandboxProfile,
        onBeforeCleanup: async () => {
          await toolHost.close()
          await rm(socketDirectory, { recursive: true, force: true })
          this.toolHosts.delete(accepted.id)
        },
        onOutput: (stream, text) => {
          if (stream === 'stdout') {
            const pending = (this.pendingIngest.get(accepted.id) ?? Promise.resolve())
              .then(() => this.ingest(accepted, input.provider, workingDirectory, text))
              .catch(() => {
                this.failures.set(accepted.id, 'protocol')
              })
            this.pendingIngest.set(accepted.id, pending)
            return
          }
          const summary = sanitize(text, workingDirectory).trim()
          if (!summary) return
          this.diagnostics.set(accepted.id, summary)
          void this.record(accepted, undefined, 'output', summary)
        },
        onExit: (code, signal) => {
          void (this.pendingIngest.get(accepted.id) ?? Promise.resolve()).then(() => {
            this.pendingIngest.delete(accepted.id)
            const stopped = signal === 'SIGTERM' || signal === 'SIGKILL'
            const providerFailed = this.failures.has(accepted.id)
            return this.conclude(
              accepted,
              stopped ? 'stopped' : code === 0 && !providerFailed ? 'completed' : 'failed',
              code === 0 && !providerFailed ? 'lifecycle' : 'error',
              stopped
                ? 'Provider process stopped'
                : code === 0 && !providerFailed
                  ? 'Provider process completed'
                  : 'Provider process failed'
            )
          })
        },
        onSupervisionFailure: () => {
          void this.conclude(
            accepted,
            'supervision-failed',
            'error',
            'Provider process cleanup could not be verified'
          )
        },
        onLimitViolation: (summary) => {
          void this.conclude(accepted, 'policy-violation', 'blocked', summary)
        }
      })
      return running
    } catch (error) {
      await toolHost.close().catch(() => undefined)
      await rm(socketDirectory, { recursive: true, force: true })
      this.toolHosts.delete(accepted.id)
      if (!(error instanceof Error && error.message.includes('changed after durable'))) {
        await this.conclude(accepted, 'failed', 'error', 'Provider process could not start')
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
      return await this.conclude(
        { id: runId, relativePath },
        'stopped',
        'lifecycle',
        'Run stopped by user'
      )
    } catch (error) {
      await this.conclude(
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

  /**
   * Parses one raw provider chunk in Core, streams the normalized events to
   * the window, and files whatever belongs in sanitized activity. Raw provider
   * frames never leave Core, and nothing here can widen a Run's authority.
   */
  private async ingest(
    run: Pick<RunSnapshot, 'id' | 'relativePath'>,
    provider: StartRunInput['provider'],
    workingDirectory: string,
    chunk: string
  ): Promise<void> {
    const events = harnessEventSchema.array().parse(
      await this.deps.core.send({
        type: 'conversation/ingest',
        relativePath: run.relativePath,
        runId: run.id,
        provider,
        chunk
      })
    )
    for (const event of events) {
      if (event.type === 'failed') this.failures.set(run.id, event.category)
      this.deps.onConversationEvent?.({
        relativePath: run.relativePath,
        runId: run.id,
        event
      })
      const activity = describeActivity(event)
      if (activity) {
        await this.record(
          run,
          undefined,
          activity.kind,
          sanitize(activity.summary, workingDirectory)
        )
      }
    }
  }

  /**
   * Records provider-native structured choices. Only the planning tool host
   * sees the offered options, so it is what tells the Conversation.
   */
  private async offerChoices(
    run: Pick<RunSnapshot, 'id' | 'relativePath'>,
    question: string,
    options: { label: string; value: string }[]
  ): Promise<void> {
    const event: HarnessEvent = {
      type: 'choices',
      question: redactCredentials(question),
      options: options.map((option, index) => ({
        id: `option-${index + 1}`,
        label: redactCredentials(option.label),
        value: redactCredentials(option.value)
      }))
    }
    await this.deps.core.send({
      type: 'conversation/apply',
      relativePath: run.relativePath,
      runId: run.id,
      event
    })
    this.deps.onConversationEvent?.({
      relativePath: run.relativePath,
      runId: run.id,
      event
    })
  }

  private async applyConversationEvent(
    run: Pick<RunSnapshot, 'id' | 'relativePath'>,
    event: HarnessEvent
  ): Promise<void> {
    await this.deps.core.send({
      type: 'conversation/apply',
      relativePath: run.relativePath,
      runId: run.id,
      event
    })
    this.deps.onConversationEvent?.({ relativePath: run.relativePath, runId: run.id, event })
  }

  /** Records a Run's terminal state and closes its Conversation boundary. */
  private async conclude(
    run: Pick<RunSnapshot, 'id' | 'relativePath'>,
    status: 'completed' | 'stopped' | 'failed' | 'policy-violation' | 'supervision-failed',
    kind: RunActivityKind,
    summary: string
  ): Promise<RunSnapshot> {
    const category = this.failures.get(run.id) ?? null
    const diagnostic = this.diagnostics.get(run.id)
    this.failures.delete(run.id)
    this.diagnostics.delete(run.id)
    // A bare "it failed" helps nobody. When the provider said nothing the app
    // could categorize, its own last diagnostic line is the explanation.
    const explained =
      status === 'failed' && category === null && diagnostic ? `${summary}: ${diagnostic}` : summary
    const snapshot = await this.record(run, status, kind, explained)
    const finalize: FinalizeConversationRunInput = {
      relativePath: run.relativePath,
      runId: run.id,
      outcome: status,
      category: status === 'failed' ? category : null,
      summary: explained
    }
    await this.deps.core.send({ type: 'conversation/finalize', input: finalize })
    return snapshot
  }

  private async record(
    run: Pick<RunSnapshot, 'id' | 'relativePath'>,
    status: RunSnapshot['status'] | undefined,
    kind: RunActivityKind,
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
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: `--require=${this.deps.proxyScript}`,
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
      `[mcp_servers.planning]\ncommand = ${JSON.stringify(proxy.command)}\n\n[mcp_servers.planning.env]\nELECTRON_RUN_AS_NODE = "1"\nNODE_OPTIONS = ${JSON.stringify(proxy.env.NODE_OPTIONS)}\nPLANNING_MCP_SOCKET = ${JSON.stringify(socketPath)}\nPLANNING_MCP_CAPABILITY = ${JSON.stringify(capabilityToken)}\n`,
      { mode: 0o600 }
    )
  }

  private async stopForPolicy(run: RunSnapshot, summary: string): Promise<void> {
    await this.conclude(run, 'policy-violation', 'lifecycle', `Run stopped by policy: ${summary}`)
    try {
      await this.deps.broker.stop(run.id, 'policy')
    } catch {
      await this.conclude(
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
  runDirectory: string,
  planningRelativePath: string,
  handoff?: string,
  sessionId?: string
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
      // `default` means the provider's own configured model: passing a guess
      // would fail on accounts that cannot use it.
      ...(input.model === PROVIDER_DEFAULT_MODEL ? [] : ['--model', input.model]),
      '-c',
      `model_reasoning_effort=${JSON.stringify(input.effort)}`,
      skillPrompt
    ]
  }
  return [
    '--print',
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
    '--no-chrome',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--include-hook-events',
    ...(sessionId ? ['--resume', sessionId] : []),
    ...(input.model === PROVIDER_DEFAULT_MODEL ? [] : ['--model', input.model]),
    '--effort',
    input.effort,
    `/${input.workflow} ${input.prompt}\n\nManaged planning location: ${planningRelativePath}\nThe verified skill source is available at ${input.workflow}'s recorded Run provenance. Use only the app-owned planning tools.${handoff ? `\n\nDeterministic handoff from canonical local history:\n${handoff}` : ''}`
  ]
}

function planningRelativePathFor(input: StartRunInput): string {
  return input.workflow === 'wayfinder'
    ? join('.scratch', `${input.relativePath}-wayfinding`)
    : join('.scratch', input.relativePath)
}

async function deterministicHandoff(
  conversation: ConversationSnapshot,
  workflow: StartRunInput['workflow'],
  planningDirectory: string,
  planningRelativePath: string
): Promise<string> {
  const recent = conversation.entries
    .filter((entry) => entry.kind === 'message')
    .slice(-8)
    .map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.text}`)
    .join('\n')
  const decisions = await readFile(join(planningDirectory, 'map.md'), 'utf8').catch(
    () => '(no Wayfinder decisions recorded)'
  )
  return [
    'Phase: Developing',
    `Workflow: ${workflow}`,
    `Decisions:\n${decisions.slice(0, 8_000)}`,
    `Planning artifacts: ${planningRelativePath}`,
    `Complete conversation: planning/conversation.md`,
    'Recent turns:',
    recent || '(none)'
  ].join('\n')
}

async function hasCompletedWayfinderMap(planningDirectory: string): Promise<boolean> {
  const map = await readFile(join(planningDirectory, 'map.md'), 'utf8').catch(() => '')
  if (!map.trim()) return false
  if (/(?:^|\n)Status:\s*(?:open|claimed)\s*(?:\n|$)|(?:^|\n)- \[ \]/i.test(map)) return false
  const issueDirectory = join(planningDirectory, 'issues')
  const issueNames = await readdir(issueDirectory).catch((): string[] => [])
  const linkedIssues = [...map.matchAll(/\]\(issues\/([^)]+\.md)\)/g)].flatMap((match) =>
    match[1] ? [match[1]] : []
  )
  if (linkedIssues.some((name) => !issueNames.includes(name))) return false
  const issues = await Promise.all(
    linkedIssues.map((name) => readFile(join(issueDirectory, name), 'utf8').catch(() => ''))
  )
  return issues.every((issue) => /(?:^|\n)Status:\s*resolved\s*(?:\n|$)/i.test(issue))
}

async function claudeSessionExists(
  homeDirectory: string,
  workingDirectory: string,
  sessionId: string
): Promise<boolean> {
  const projectKey = resolve(workingDirectory).replaceAll('/', '-')
  const sessionPath = join(homeDirectory, '.claude', 'projects', projectKey, `${sessionId}.jsonl`)
  return readFile(sessionPath, 'utf8').then(
    () => true,
    () => false
  )
}

const claudeCredentialsSchema = z.object({
  claudeAiOauth: z.object({ accessToken: z.string().min(1) })
})

async function readClaudeOauthToken(): Promise<string> {
  const { stdout } = await promisify(execFile)('/usr/bin/security', [
    'find-generic-password',
    '-s',
    'Claude Code-credentials',
    '-w'
  ])
  return claudeCredentialsSchema.parse(JSON.parse(stdout)).claudeAiOauth.accessToken
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

function sanitize(value: string, workingDirectory: string): string {
  return redactCredentials(value.replaceAll(workingDirectory, '<WORKING_DIRECTORY>')).slice(
    0,
    2_000
  )
}

/**
 * What a normalized event contributes to the collapsed activity stream.
 * Assistant text and Suggested Responses are Conversation content, not
 * activity, so they deliberately produce nothing here.
 */
function describeActivity(
  event: HarnessEvent
): { kind: RunActivityKind; summary: string } | undefined {
  switch (event.type) {
    case 'reasoning':
      return { kind: 'reasoning', summary: event.summary }
    case 'tool':
      // What the provider asked for, not a verdict: the authoritative allow
      // or deny row comes from the planning tool host.
      return { kind: 'output', summary: `${event.name}: ${event.summary}` }
    case 'failed':
      return { kind: 'error', summary: event.summary }
    case 'session-ready':
      return { kind: 'lifecycle', summary: `Provider session ready with ${event.model}` }
    case 'retrying':
      return {
        kind: 'output',
        summary: `Provider retry ${event.attempt} in ${event.delayMs} ms (${event.category})`
      }
    case 'assistant-message':
    case 'choices':
    case 'workflow-completion-suggested':
    case 'usage':
    case 'completed':
    case 'unsupported':
      return undefined
  }
}
