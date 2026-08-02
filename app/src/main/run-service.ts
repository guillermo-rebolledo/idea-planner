import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { sessionSummarySchema, type CoreCommand } from '@shared/contract'
import {
  HARNESS_DEFAULT_MODEL,
  MAX_APPROVAL_DETAIL,
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
import { proposeStandingApproval, ruleText, type ProposedRule } from '@shared/approval'
import {
  APPROVAL_TOOL,
  APP_TOOLS,
  MCP_SERVER_NAME,
  resolveApprovalInputSchema,
  runSnapshotSchema,
  startRunInputSchema,
  type PermissionMode,
  type ResolveApprovalInput,
  type RunActivityKind,
  type RunSnapshot,
  type StartRunInput
} from '@shared/run'
import { HARNESS_SPECS, VERIFIED_SKILLS } from './readiness'
import { ToolHost, type ApprovalRequest } from './tool-host'
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
  /** Overridable so a test can stage settings this app would never write. */
  stageSettings?: (permissionMode: PermissionMode) => unknown
  /** Delivers normalized assistant and control events straight to the window. */
  onConversationEvent?: (event: ConversationStreamEvent) => void
}

/** What one outstanding request could be turned into, if the person asks. */
interface RequestProposal {
  projectRoot: string
  harness: StartRunInput['harness']
  proposed: ProposedRule | null
  summary: string
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
  /**
   * What each outstanding request could become, by Run and request id. Only
   * this app knows it: the rule was synthesised here, from input the durable
   * record deliberately bounds.
   */
  private readonly proposals = new Map<string, Map<string, RequestProposal>>()

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
    // `codex exec` auto-rejects approvals without emitting an event, so an Ask
    // Run on it would refuse everything while looking like it was working.
    // Ticket 10 brings the app-server transport that can actually ask.
    if (input.permissionMode === 'ask' && input.harness === 'codex') {
      throw new Error(
        'Ask mode needs the Codex app-server protocol, which is not built yet. Use Full access.'
      )
    }
    const checkout = await this.checkoutFor(input.sessionId)
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
      checkout,
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
        (await claudeThreadExists(this.deps.homeDirectory, checkout, savedThread)))
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
      askedPermissionMode: CLAUDE_PERMISSION_MODES[input.permissionMode],
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
        input.permissionMode,
        await this.standingRules(checkout, input.harness)
      )
      toolHost = new ToolHost({
        socketPath,
        capabilityToken,
        servesApprovals: input.permissionMode === 'ask',
        callbacks: {
          onActivity: (kind, summary) =>
            this.record(accepted, undefined, kind, sanitize(summary, checkout)).then(
              () => undefined
            ),
          onStop: (summary) => {
            void this.stopForPolicy(accepted, summary)
          },
          onChoices: (question, options) => {
            void this.offerChoices(accepted, question, options)
          },
          onApproval: (request) => this.requestApproval(accepted, checkout, input.harness, request)
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
        workingDirectory: checkout,
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
              .then(() => this.ingest(accepted, input.harness, checkout, text))
              .catch(() => {
                this.failures.set(accepted.id, 'protocol')
              })
            this.pendingIngest.set(accepted.id, pending)
            return
          }
          const summary = sanitize(text, checkout).trim()
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
    run: Pick<RunSnapshot, 'id' | 'sessionId' | 'configuration'>,
    harness: StartRunInput['harness'],
    checkout: string,
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
      const activity = describeActivity(event, run.configuration.permissionMode)
      if (activity) {
        await this.record(run, undefined, activity.kind, sanitize(activity.summary, checkout))
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

  /**
   * The agent asking before it edits or runs something, in Ask mode. The
   * request lands in the Conversation and the Run is marked blocked; the
   * Harness stays held in its tool call until `resolveApproval` answers it.
   */
  private async requestApproval(
    run: Pick<RunSnapshot, 'id' | 'sessionId'>,
    /**
     * The Project this Run works in, which is also its Checkout while a
     * Session edits its Project in place (ADR 0004). A Standing Approval
     * belongs to the Project, so it is named as the Project here.
     */
    projectRoot: string,
    harness: StartRunInput['harness'],
    request: ApprovalRequest
  ): Promise<void> {
    const described = describeApproval(request.tool, request.input)
    // A rule is written from the Project root with its symlinks resolved,
    // because that is the form the Harness compares against.
    const proposedRule = proposeStandingApproval(
      request.tool,
      request.input,
      await realPath(projectRoot)
    )
    const summary = sanitize(described.summary, projectRoot)
    const proposals = this.proposals.get(run.id) ?? new Map<string, RequestProposal>()
    proposals.set(request.id, { projectRoot, harness, proposed: proposedRule, summary })
    this.proposals.set(run.id, proposals)
    const event: HarnessEvent = {
      type: 'approval-request',
      id: request.id,
      tool: request.tool,
      summary,
      detail: sanitize(described.detail, projectRoot).slice(0, MAX_APPROVAL_DETAIL),
      proposedRule
    }
    await this.deps.core.send({
      type: 'conversation/apply',
      sessionId: run.sessionId,
      runId: run.id,
      event
    })
    this.deps.onConversationEvent?.({ sessionId: run.sessionId, runId: run.id, event })
    await this.record(run, 'waiting', 'blocked', `Waiting for you to approve ${event.summary}`)
  }

  /**
   * The person's answer. The Harness is told first — it is the one waiting —
   * and the Conversation records what was decided either way.
   */
  async resolveApproval(rawInput: ResolveApprovalInput): Promise<ConversationSnapshot> {
    const input = resolveApprovalInputSchema.parse(rawInput)
    const host = this.toolHosts.get(input.runId)
    const written = input.message?.trim() ?? ''
    // A refusal the agent cannot read is one it will simply try again.
    const message =
      written === '' ? 'You declined this in the app. Ask before trying it again.' : written
    const allowed = input.decision === 'allow'
    const proposal = this.proposals.get(input.runId)?.get(input.approvalId)
    if (!host?.hasOutstandingApproval(input.approvalId)) {
      // The Run ended, or somebody already answered. Either way the agent has
      // moved on, and saying so beats silently pretending this took effect.
      throw new Error('That request is no longer waiting for an answer')
    }
    // Granted before the agent is told, and never on a request this app cannot
    // narrow: a permission that outlives the Run has to be durable before the
    // Run acts on it, or a crash in between leaves it granted in appearance only.
    const remembered = Boolean(input.remember && allowed && proposal?.proposed)
    if (input.remember && !remembered) {
      throw new Error('That request cannot be turned into a Standing Approval')
    }
    if (remembered && proposal?.proposed) {
      await this.deps.core.send({
        type: 'approval/grant',
        input: {
          projectRoot: proposal.projectRoot,
          harness: proposal.harness,
          kind: proposal.proposed.kind,
          toolName: proposal.proposed.toolName,
          content: proposal.proposed.content,
          summary: proposal.summary
        }
      })
    }
    this.proposals.get(input.runId)?.delete(input.approvalId)
    host.resolveApproval(
      input.approvalId,
      allowed
        ? {
            behavior: 'allow',
            // This Run's settings were staged before the grant existed, so the
            // rule rides along with the answer and the Harness applies it to
            // the Thread it is already running. Nothing in this app decides
            // what it covers: its own matcher does, exactly as it will next
            // Run from the settings file.
            ...(remembered && proposal?.proposed
              ? {
                  sessionRule: {
                    toolName: proposal.proposed.toolName,
                    content: proposal.proposed.content
                  }
                }
              : {})
          }
        : { behavior: 'deny', message }
    )
    const event: HarnessEvent = {
      type: 'approval-resolved',
      id: input.approvalId,
      decision: allowed ? 'allowed' : 'denied',
      message: allowed ? '' : message,
      remembered
    }
    await this.deps.core.send({
      type: 'conversation/apply',
      sessionId: input.sessionId,
      runId: input.runId,
      event
    })
    this.deps.onConversationEvent?.({
      sessionId: input.sessionId,
      runId: input.runId,
      event
    })
    // A denial is an answer, not a failure: the agent was told and carries on.
    // The Run leaves the blocked state only once nothing else is outstanding.
    // The host is what knows whether anything else still stands, so it is what
    // decides when the Run stops being blocked.
    await this.record(
      { id: input.runId, sessionId: input.sessionId },
      host.hasOutstandingApprovals() ? undefined : 'running',
      allowed ? 'allowed' : 'blocked',
      allowed
        ? remembered && proposal?.proposed
          ? `You approved the request, and always allow ${ruleText(proposal.proposed)}`
          : 'You approved the request'
        : `You declined: ${message}`
    )
    return await this.readConversation(input.sessionId)
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
    this.proposals.delete(run.id)
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

  /** What this Project has permanently allowed, as the Harness's own rules. */
  private async standingRules(
    projectRoot: string,
    harness: StartRunInput['harness']
  ): Promise<string[]> {
    return z
      .array(z.string().min(1))
      .parse(await this.deps.core.send({ type: 'approval/rules', projectRoot, harness }))
  }

  private async prepareHarnessHome(
    harness: StartRunInput['harness'],
    runDirectory: string,
    socketPath: string,
    capabilityToken: string,
    permissionMode: PermissionMode,
    standingRules: string[]
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
      // This Run's settings, layered over the person's own and never written
      // into them: their terminal use of the Harness is not ours to change.
      //
      // Ask gates every tool, including the app's own — and being asked whether
      // the app may offer you a menu is not a permission decision anybody has.
      // An allow rule short-circuits the prompt for exactly those, and nothing
      // else. What the agent does to the Checkout still comes to the person.
      //
      // The Project's Standing Approvals join them. The Harness consults these
      // rules before it asks, so a standing-approved call never reaches this
      // app at all — which is the whole point, and the reason the rules were
      // narrowed when they were written rather than when they are used.
      const settings = this.deps.stageSettings
        ? this.deps.stageSettings(permissionMode)
        : {
            permissions: {
              defaultMode: CLAUDE_PERMISSION_MODES[permissionMode],
              allow: [...APP_TOOLS, ...standingRules]
            }
          }
      // Checked before the Harness sees them: invalid settings are ignored in
      // silence, so a rule that never loaded looks exactly like one that did.
      const validated = claudeSettingsSchema.safeParse(settings)
      if (!validated.success) {
        throw new Error(
          `Refusing to start: this Run's settings are not valid — ${validated.error.issues[0]?.message ?? 'unknown problem'}`
        )
      }
      await writeFile(join(runDirectory, 'settings.json'), JSON.stringify(validated.data), {
        mode: 0o600
      })
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
    ...(harness === 'codex' ? { CODEX_HOME: join(runDirectory, 'codex-home') } : {})
    // Claude's per-Run configuration is a staged settings file, not a staged
    // home: CLAUDE_CONFIG_DIR relocates account state too, and a staged one
    // reports the person as not logged in.
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
    // The person's own sources, so their installed Skills are discoverable,
    // plus this Run's settings layered on top.
    '--setting-sources',
    'user',
    '--settings',
    join(runDirectory, 'settings.json'),
    '--strict-mcp-config',
    '--mcp-config',
    join(runDirectory, 'mcp.json'),
    // No allow-list: naming only the app's MCP tool is what left the Harness
    // with no native tools at all. It edits the Checkout with its own.
    '--permission-mode',
    CLAUDE_PERMISSION_MODES[input.permissionMode],
    // Ask is this mode plus somewhere for its prompts to go. Without the tool
    // the Harness has nothing to ask, and stalls on its first tool call.
    ...(input.permissionMode === 'ask' ? ['--permission-prompt-tool', APPROVAL_TOOL] : []),
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
  checkout: string,
  threadId: string
): Promise<boolean> {
  const projectKey = resolve(checkout).replaceAll('/', '-')
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

/**
 * A path with its symlinks resolved, or the path itself when it cannot be
 * resolved. A rule is compared against the resolved form, so this is what one
 * has to be written from.
 */
async function realPath(path: string): Promise<string> {
  return realpath(path).catch(() => path)
}

function sanitize(value: string, checkout: string): string {
  return redactCredentials(value.replaceAll(checkout, '<PROJECT>')).slice(0, 2_000)
}

/**
 * What this app is willing to put in a Run's settings file. Narrow on purpose:
 * the Harness ignores what it cannot read without saying so, so anything this
 * schema does not describe would fail silently at the far end.
 */
const claudeSettingsSchema = z.object({
  permissions: z.object({
    defaultMode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']),
    allow: z.array(z.string().min(1)).optional(),
    deny: z.array(z.string().min(1)).optional()
  })
})

/**
 * The app's two Permission Modes as Claude names them
 * (`docs/harness-permission-mapping.md`). Ask maps to the mode that asks; a
 * Run in that mode is refused until ticket 07b serves the prompt that answers
 * it, because one that starts anyway stalls on its first tool call.
 */
const CLAUDE_PERMISSION_MODES: Record<PermissionMode, string> = {
  ask: 'default',
  auto: 'bypassPermissions'
}

/**
 * What a normalized event contributes to the collapsed activity stream.
 * Assistant text and Suggested Responses are Conversation content, not
 * activity, so they deliberately produce nothing here.
 */
function describeActivity(
  event: HarnessEvent,
  permissionMode: PermissionMode
): { kind: RunActivityKind; summary: string } | undefined {
  switch (event.type) {
    case 'reasoning':
      return { kind: 'reasoning', summary: event.summary }
    case 'tool':
      // What the Harness reported doing. The app no longer adjudicates it, so
      // this is an observation, not a verdict.
      return { kind: 'output', summary: `${event.name}: ${event.summary}` }
    case 'command':
      // The output belongs to the Conversation; the activity stream says only
      // that a command ran, and whether it worked.
      return {
        kind: event.failed ? 'error' : 'output',
        summary: `Ran ${event.command}`
      }
    case 'file-change':
      // The diff itself belongs to the Conversation; the activity stream says
      // only that the Checkout was changed, and where.
      return { kind: 'output', summary: `Changed ${event.path}` }
    case 'failed':
      return { kind: 'error', summary: event.summary }
    case 'thread-ready': {
      // Managed settings outrank command-line arguments, so the mode the app
      // asked for is not necessarily the one running. Saying so is the whole
      // point of reading it back.
      const asked = CLAUDE_PERMISSION_MODES[permissionMode]
      const mismatch =
        event.permissionMode !== undefined && event.permissionMode !== asked
          ? ` — running as ${event.permissionMode}, not the ${permissionMode} you chose`
          : ''
      return {
        kind: mismatch ? 'error' : 'lifecycle',
        summary: `Harness Thread ready with ${event.model}${mismatch}`
      }
    }
    case 'retrying':
      return {
        kind: 'output',
        summary: `Harness retry ${event.attempt} in ${event.delayMs} ms (${event.category})`
      }
    // An approval is recorded where it is decided, with the wording the person
    // actually saw; repeating it here would say it twice.
    case 'approval-request':
    case 'approval-resolved':
    case 'assistant-message':
    case 'choices':
    case 'usage':
    case 'completed':
    case 'unsupported':
      return undefined
  }
}

/**
 * What the person is actually being asked to allow. The tool input is the only
 * honest source, so the line they read is drawn from it — an approval whose
 * card says merely "Bash" is one nobody can judge.
 */
function describeApproval(
  tool: string,
  input: Record<string, unknown>
): { summary: string; detail: string } {
  const field = (name: string): string | undefined =>
    typeof input[name] === 'string' && input[name].length > 0 ? input[name] : undefined
  const summary =
    field('command') ?? field('file_path') ?? field('path') ?? field('pattern') ?? tool
  return { summary, detail: JSON.stringify(input, null, 2) }
}
