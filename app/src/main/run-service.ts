import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { sessionSummarySchema, type CoreCommand } from '@shared/contract'
import {
  HARNESS_DEFAULT_MODEL,
  conversationSnapshotSchema,
  developSessionInputSchema,
  harnessEventSchema,
  redactCredentials,
  type ConversationSnapshot,
  type ConversationStreamEvent,
  type DevelopSessionInput,
  type FinalizeConversationRunInput,
  type HarnessEvent,
  type HarnessFailureCategory
} from '@shared/conversation'
import {
  MCP_SERVER_NAME,
  MCP_TOOL_PREFIX,
  runSnapshotSchema,
  startRunInputSchema,
  type RunActivityKind,
  type RunSnapshot,
  type StartRunInput
} from '@shared/run'
import { HARNESS_SPECS, VERIFIED_SKILLS } from './readiness'
import { ToolHost } from './tool-host'
import type { RunProcessBroker } from './run-process-broker'

interface CorePort {
  send(command: CoreCommand): Promise<unknown>
}
interface ReadinessPort {
  refresh(harness?: 'codex' | 'claude'): Promise<{
    harnesses: {
      harness: string
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
  private readonly toolHosts = new Map<string, ToolHost>()
  /** The last failure a Run's Harness reported, used when the Run ends. */
  private readonly failures = new Map<string, HarnessFailureCategory>()
  /**
   * The last thing a Run's Harness wrote to its diagnostic stream. When a
   * process dies without reporting a failure of its own, this is the only
   * explanation there is, so it becomes what the person is told.
   */
  private readonly diagnostics = new Map<string, string>()
  private readonly pendingIngest = new Map<string, Promise<void>>()

  constructor(private readonly deps: RunServiceDeps) {}

  /**
   * Develops a Session through its Conversation: the person's message is
   * accepted durably first, and only then does one Run start. A Run that
   * never reaches the Harness leaves the message and a recovery choice.
   */
  async develop(rawInput: DevelopSessionInput): Promise<ConversationSnapshot> {
    const input = developSessionInputSchema.parse(rawInput)
    if (!HARNESS_SPECS[input.harness].conversation) {
      throw new Error(
        `Developing a Session with ${HARNESS_SPECS[input.harness].displayName} is not supported yet`
      )
    }
    await this.deps.core.send({
      type: 'conversation/submit',
      input: {
        sessionId: input.sessionId,
        submissionId: input.submissionId,
        text: input.text,
        source: input.source
      }
    })
    try {
      await this.start({
        submissionId: input.submissionId,
        sessionId: input.sessionId,
        prompt: input.text,
        harness: input.harness,
        model: input.model,
        effort: input.effort,
        skill: input.skill,
        permissionMode: input.permissionMode
      })
    } catch (error) {
      const snapshot = await this.readConversation(input.sessionId)
      // A failure the Conversation already explains becomes recovery state the
      // person can act on. Anything else — an unready Harness, say — is not
      // about this Run and has to reach them as an error.
      if (snapshot.recovery === null && snapshot.activeRunId === null) throw error
      return snapshot
    }
    return await this.readConversation(input.sessionId)
  }

  /**
   * Reads the Conversation, reconciling a Run the app no longer supervises.
   * After a crash or a forced quit the durable history can still name an
   * active Run; leaving it that way would block the person out of their own
   * Session, so it is closed as interrupted and offered back for resending.
   */
  async conversation(sessionId: string): Promise<ConversationSnapshot> {
    const snapshot = await this.readConversation(sessionId)
    if (!snapshot.activeRunId || this.deps.broker.activeRunIds().includes(snapshot.activeRunId)) {
      return snapshot
    }
    await this.deps.core.send({
      type: 'conversation/finalize',
      input: {
        sessionId,
        runId: snapshot.activeRunId,
        outcome: 'failed',
        category: 'process-crash',
        summary: 'The app stopped supervising this Run before it answered'
      }
    })
    return await this.readConversation(sessionId)
  }

  private readConversation(sessionId: string): Promise<ConversationSnapshot> {
    return this.deps.core
      .send({ type: 'conversation/get', sessionId })
      .then((result) => conversationSnapshotSchema.parse(result))
  }

  /**
   * The Session's Checkout. A Session belongs to a Project (ADR 0002), and
   * that Project's root is the directory the Harness is allowed to work in.
   */
  private async checkoutFor(sessionId: string): Promise<string> {
    const session = sessionSummarySchema.parse(
      await this.deps.core.send({ type: 'session/get', sessionId })
    )
    return session.projectRoot
  }

  async start(rawInput: StartRunInput): Promise<RunSnapshot> {
    const input = startRunInputSchema.parse(rawInput)
    const workingDirectory = await this.checkoutFor(input.sessionId)
    const readiness = await this.deps.readiness.refresh(input.harness)
    const harness = readiness.harnesses.find((entry) => entry.harness === input.harness)
    if (!harness?.available || !harness.executablePath) {
      throw new Error(`${input.harness} is not ready`)
    }
    if (!harness.version) throw new Error(`${input.harness} version provenance is unavailable`)
    const skillName = input.skill
    if (!VERIFIED_SKILLS.includes(skillName)) {
      throw new Error(`${skillName} is not a verified Skill`)
    }
    const spec = HARNESS_SPECS[input.harness]
    const skillDirectory = join(this.deps.homeDirectory, spec.skillsRoot, skillName)
    const skillFile = join(skillDirectory, 'SKILL.md')
    const skillHash = createHash('sha256')
      .update(await readFile(skillFile))
      .digest('hex')
    const executableHash = await hashFile(harness.executablePath)
    const runKey = createHash('sha256')
      .update(`${input.sessionId}\0${input.submissionId}`)
      .digest('hex')
    const runDirectory = join(this.deps.privateRoot, runKey)
    const environment = minimalEnvironment(
      harness.executablePath,
      this.deps.homeDirectory,
      input.harness,
      runDirectory
    )
    const configuration = {
      harness: input.harness,
      executable: harness.executablePath,
      executableHash,
      harnessVersion: harness.version,
      model: input.model,
      effort: input.effort,
      skill: { name: skillName, path: skillDirectory, hash: skillHash },
      environment,
      workingDirectory,
      permissionMode: input.permissionMode
    }
    const accepted = runSnapshotSchema.parse(
      await this.deps.core.send({
        type: 'run/accept',
        input: {
          submissionId: input.submissionId,
          sessionId: input.sessionId,
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
        'Interrupted Run requires explicit recovery; the Harness was not contacted again'
      )
    }
    const conversation = await this.readConversation(input.sessionId)
    const latestHarness = [...conversation.entries]
      .reverse()
      .find(
        (entry): entry is Extract<typeof entry, { kind: 'boundary' }> =>
          entry.kind === 'boundary' && entry.harness !== undefined
      )?.harness
    const savedThread = conversation.harnessThreads[input.harness]
    const switchedHarness = latestHarness !== undefined && latestHarness !== input.harness
    const latestHarnessBoundary = [...conversation.entries]
      .reverse()
      .find(
        (entry): entry is Extract<typeof entry, { kind: 'boundary' }> =>
          entry.kind === 'boundary' && entry.harness === input.harness
      )
    const threadCompatible =
      savedThread !== undefined &&
      latestHarnessBoundary?.skill === input.skill &&
      latestHarnessBoundary.model === input.model &&
      (input.harness !== 'claude' ||
        (await claudeThreadExists(this.deps.homeDirectory, workingDirectory, savedThread)))
    const restoreFromHistory =
      switchedHarness || (latestHarness === input.harness && !threadCompatible)
    const handoff = deterministicHandoff(conversation, input.skill)
    // The Conversation records the Run boundary before anything can fail, so
    // every later outcome has somewhere understandable to land.
    await this.deps.core.send({
      type: 'conversation/begin',
      sessionId: input.sessionId,
      runId: accepted.id,
      submissionId: input.submissionId,
      harness: input.harness,
      skill: input.skill,
      model: input.model,
      restorationNote: latestHarness === input.harness && !threadCompatible
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

    const socketDirectory = join(
      tmpdir(),
      `run-tools-${createHash('sha256').update(accepted.id).digest('hex').slice(0, 16)}`
    )
    const socketPath = join(socketDirectory, 'p.sock')
    const capabilityToken = randomUUID()
    let toolHost: ToolHost | undefined
    try {
      await mkdir(runDirectory, { recursive: true, mode: 0o700 })
      await chmod(runDirectory, 0o700)
      await mkdir(socketDirectory, { recursive: true, mode: 0o700 })
      await chmod(socketDirectory, 0o700)
      // A socket file left behind by a crash would otherwise make this Run's
      // capability socket unbindable; the path belongs to this Run alone.
      await rm(socketPath, { force: true })
      await this.prepareHarnessHome(
        input.harness,
        runDirectory,
        socketPath,
        capabilityToken,
        skillName,
        skillFile
      )
      toolHost = new ToolHost({
        socketPath,
        capabilityToken,
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
          }
        }
      })
      await toolHost.start()
      this.toolHosts.set(accepted.id, toolHost)

      await this.record(accepted, 'starting', 'lifecycle', 'Prepared the Run; starting the Harness')
    } catch (error) {
      await toolHost?.close().catch(() => undefined)
      await Promise.all([
        rm(socketDirectory, { recursive: true, force: true }),
        rm(runDirectory, { recursive: true, force: true })
      ])
      await this.conclude(accepted, 'failed', 'error', 'The Run could not be prepared')
      throw error
    }
    try {
      if ((await hashFile(harness.executablePath)) !== executableHash) {
        await this.conclude(
          accepted,
          'failed',
          'error',
          'Harness executable changed after Run acceptance; the Harness was not contacted'
        )
        throw new Error('Harness executable changed after durable Run acceptance')
      }
      const running = await this.record(accepted, 'running', 'lifecycle', 'Harness process running')
      const harnessEnvironment =
        input.harness === 'claude'
          ? {
              ...configuration.environment,
              CLAUDE_CODE_OAUTH_TOKEN: await (this.deps.claudeOauthToken ?? readClaudeOauthToken)()
            }
          : configuration.environment
      await this.deps.broker.start({
        id: accepted.id,
        executable: harness.executablePath,
        args: harnessArguments(
          input,
          await readFile(skillFile, 'utf8'),
          runDirectory,
          restoreFromHistory ? handoff : undefined,
          threadCompatible ? savedThread : undefined
        ),
        workingDirectory,
        runDirectory,
        environment: harnessEnvironment,
        onBeforeCleanup: async () => {
          await toolHost.close()
          await rm(socketDirectory, { recursive: true, force: true })
          this.toolHosts.delete(accepted.id)
        },
        onOutput: (stream, text) => {
          if (stream === 'stdout') {
            const pending = (this.pendingIngest.get(accepted.id) ?? Promise.resolve())
              .then(() => this.ingest(accepted, input.harness, workingDirectory, text))
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
            const harnessFailed = this.failures.has(accepted.id)
            return this.conclude(
              accepted,
              stopped ? 'stopped' : code === 0 && !harnessFailed ? 'completed' : 'failed',
              code === 0 && !harnessFailed ? 'lifecycle' : 'error',
              stopped
                ? 'Harness process stopped'
                : code === 0 && !harnessFailed
                  ? 'Harness process completed'
                  : 'Harness process failed'
            )
          })
        },
        onSupervisionFailure: () => {
          void this.conclude(
            accepted,
            'supervision-failed',
            'error',
            'Harness process cleanup could not be verified'
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
        await this.conclude(accepted, 'failed', 'error', 'The Harness process could not start')
      }
      throw error
    }
  }

  async list(sessionId: string): Promise<RunSnapshot[]> {
    return runSnapshotSchema
      .array()
      .parse(await this.deps.core.send({ type: 'run/list', sessionId }))
  }

  async stop(runId: string, sessionId: string): Promise<RunSnapshot> {
    try {
      await this.deps.broker.stop(runId, 'user')
      return await this.conclude(
        { id: runId, sessionId },
        'stopped',
        'lifecycle',
        'Run stopped by user'
      )
    } catch (error) {
      await this.conclude(
        { id: runId, sessionId },
        'supervision-failed',
        'error',
        'Harness process cleanup could not be verified'
      )
      throw error
    }
  }

  stopAll(reason: 'core-crash' | 'quit' | 'update'): Promise<void> {
    return this.deps.broker.stopAll(reason)
  }

  /**
   * Parses one raw Harness chunk in Core, streams the normalized events to
   * the window, and files whatever belongs in sanitized activity. Raw Harness
   * frames never leave Core, and nothing here can widen a Run's authority.
   */
  private async ingest(
    run: Pick<RunSnapshot, 'id' | 'sessionId'>,
    harness: StartRunInput['harness'],
    workingDirectory: string,
    chunk: string
  ): Promise<void> {
    const events = harnessEventSchema.array().parse(
      await this.deps.core.send({
        type: 'conversation/ingest',
        sessionId: run.sessionId,
        runId: run.id,
        harness,
        chunk
      })
    )
    for (const event of events) {
      if (event.type === 'failed') this.failures.set(run.id, event.category)
      this.deps.onConversationEvent?.({
        sessionId: run.sessionId,
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
   * Records Harness-native structured choices. Only the app's tool host sees
   * the offered options, so it is what tells the Conversation.
   */
  private async offerChoices(
    run: Pick<RunSnapshot, 'id' | 'sessionId'>,
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
      sessionId: run.sessionId,
      runId: run.id,
      event
    })
    this.deps.onConversationEvent?.({
      sessionId: run.sessionId,
      runId: run.id,
      event
    })
  }

  /** Records a Run's terminal state and closes its Conversation boundary. */
  private async conclude(
    run: Pick<RunSnapshot, 'id' | 'sessionId'>,
    status: 'completed' | 'stopped' | 'failed' | 'policy-violation' | 'supervision-failed',
    kind: RunActivityKind,
    summary: string
  ): Promise<RunSnapshot> {
    const category = this.failures.get(run.id) ?? null
    const diagnostic = this.diagnostics.get(run.id)
    this.failures.delete(run.id)
    this.diagnostics.delete(run.id)
    // A bare "it failed" helps nobody. When the Harness said nothing the app
    // could categorize, its own last diagnostic line is the explanation.
    const explained =
      status === 'failed' && category === null && diagnostic ? `${summary}: ${diagnostic}` : summary
    const snapshot = await this.record(run, status, kind, explained)
    const finalize: FinalizeConversationRunInput = {
      sessionId: run.sessionId,
      runId: run.id,
      outcome: status,
      category: status === 'failed' ? category : null,
      summary: explained
    }
    await this.deps.core.send({ type: 'conversation/finalize', input: finalize })
    return snapshot
  }

  private async record(
    run: Pick<RunSnapshot, 'id' | 'sessionId'>,
    status: RunSnapshot['status'] | undefined,
    kind: RunActivityKind,
    summary: string
  ): Promise<RunSnapshot> {
    return runSnapshotSchema.parse(
      await this.deps.core.send({
        type: 'run/event',
        input: {
          sessionId: run.sessionId,
          runId: run.id,
          ...(status ? { status } : {}),
          kind,
          summary
        }
      })
    )
  }

  private async prepareHarnessHome(
    harness: StartRunInput['harness'],
    runDirectory: string,
    socketPath: string,
    capabilityToken: string,
    skillName: string,
    skillFile: string
  ): Promise<void> {
    const proxy = {
      command: this.deps.proxyExecutable,
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: `--require=${this.deps.proxyScript}`,
        APP_MCP_SOCKET: socketPath,
        APP_MCP_CAPABILITY: capabilityToken
      }
    }
    await writeFile(
      join(runDirectory, 'mcp.json'),
      JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: proxy } }),
      { mode: 0o600 }
    )
    if (harness === 'claude') {
      const stagedSkill = join(runDirectory, 'claude-config', 'skills', skillName)
      await mkdir(stagedSkill, { recursive: true, mode: 0o700 })
      await copyFile(skillFile, join(stagedSkill, 'SKILL.md'))
      return
    }
    const codexHome = join(runDirectory, 'codex-home')
    await mkdir(codexHome, { recursive: true, mode: 0o700 })
    await copyFile(
      join(this.deps.homeDirectory, '.codex', 'auth.json'),
      join(codexHome, 'auth.json')
    )
    await chmod(join(codexHome, 'auth.json'), 0o600)
    await writeFile(
      join(codexHome, 'config.toml'),
      `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = ${JSON.stringify(proxy.command)}\n\n[mcp_servers.${MCP_SERVER_NAME}.env]\nELECTRON_RUN_AS_NODE = "1"\nNODE_OPTIONS = ${JSON.stringify(proxy.env.NODE_OPTIONS)}\nAPP_MCP_SOCKET = ${JSON.stringify(socketPath)}\nAPP_MCP_CAPABILITY = ${JSON.stringify(capabilityToken)}\n`,
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
        'Harness process cleanup could not be verified'
      )
    }
  }
}

/**
 * The name of the app's own MCP server, and therefore the prefix a Harness
 * gives its tools. Claude's `--allowedTools` filter below is derived from it,
 * so the two can never drift apart.
 */

function minimalEnvironment(
  executable: string,
  home: string,
  harness: StartRunInput['harness'],
  runDirectory: string
): Record<string, string> {
  return {
    PATH: `${dirname(executable)}:/usr/bin:/bin`,
    HOME: home,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    ...(harness === 'codex' ? { CODEX_HOME: join(runDirectory, 'codex-home') } : {}),
    ...(harness === 'claude' ? { CLAUDE_CONFIG_DIR: join(runDirectory, 'claude-config') } : {})
  }
}

function harnessArguments(
  input: StartRunInput,
  skillText: string,
  runDirectory: string,
  handoff?: string,
  threadId?: string
): string[] {
  const skillPrompt = `Verified Skill (${input.skill}):\n\n${skillText}\n\nUser request:\n${input.prompt}`
  if (input.harness === 'codex') {
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
      // `default` means the Harness's own configured model: passing a guess
      // would fail on accounts that cannot use it.
      ...(input.model === HARNESS_DEFAULT_MODEL ? [] : ['--model', input.model]),
      '-c',
      `model_reasoning_effort=${JSON.stringify(input.effort)}`,
      skillPrompt
    ]
  }
  return [
    '--print',
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--mcp-config',
    join(runDirectory, 'mcp.json'),
    '--tools',
    'ToolSearch',
    '--allowedTools',
    `${MCP_TOOL_PREFIX}*`,
    '--permission-mode',
    'dontAsk',
    '--no-chrome',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--include-hook-events',
    ...(threadId ? ['--resume', threadId] : []),
    ...(input.model === HARNESS_DEFAULT_MODEL ? [] : ['--model', input.model]),
    '--effort',
    input.effort,
    `/${input.skill} ${input.prompt}${handoff ? `\n\nDeterministic handoff from the Conversation so far:\n${handoff}` : ''}`
  ]
}

/**
 * What a new Harness Thread needs to continue the Conversation: the Skill in
 * force and the turns immediately before it.
 */
function deterministicHandoff(conversation: ConversationSnapshot, skill: string): string {
  const recent = conversation.entries
    .filter((entry) => entry.kind === 'message')
    .slice(-8)
    .map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.text}`)
    .join('\n')
  return [`Skill: ${skill}`, 'Recent turns:', recent || '(none)'].join('\n')
}

async function claudeThreadExists(
  homeDirectory: string,
  workingDirectory: string,
  threadId: string
): Promise<boolean> {
  const projectKey = resolve(workingDirectory).replaceAll('/', '-')
  const threadPath = join(homeDirectory, '.claude', 'projects', projectKey, `${threadId}.jsonl`)
  return readFile(threadPath, 'utf8').then(
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
  return redactCredentials(value.replaceAll(workingDirectory, '<PROJECT>')).slice(0, 2_000)
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
      // What the Harness reported doing. The app no longer adjudicates it, so
      // this is an observation, not a verdict.
      return { kind: 'output', summary: `${event.name}: ${event.summary}` }
    case 'failed':
      return { kind: 'error', summary: event.summary }
    case 'thread-ready':
      return { kind: 'lifecycle', summary: `Harness Thread ready with ${event.model}` }
    case 'retrying':
      return {
        kind: 'output',
        summary: `Harness retry ${event.attempt} in ${event.delayMs} ms (${event.category})`
      }
    case 'assistant-message':
    case 'choices':
    case 'usage':
    case 'completed':
    case 'unsupported':
      return undefined
  }
}
