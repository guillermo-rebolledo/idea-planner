import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import {
  checkoutDirectory,
  sessionSummarySchema,
  startSessionInputSchema,
  type CheckoutStateObservation,
  type CoreCommand,
  type StartSessionInput,
  type StartedSessionResult
} from '@shared/contract'
import {
  HARNESS_DEFAULT_MODEL,
  MAX_APPROVAL_DETAIL,
  conversationSnapshotSchema,
  developSessionInputSchema,
  editQueuedSubmissionInputSchema,
  enqueueQueuedSubmissionInputSchema,
  harnessEventSchema,
  moveQueuedSubmissionInputSchema,
  queuedSubmissionIdentitySchema,
  redactCredentials,
  startingSubmissionId,
  unfinishedRunSchema,
  type ConversationSnapshot,
  type ConversationStreamEvent,
  type CodexLaunch,
  type DevelopSessionInput,
  type HarnessEvent,
  type HarnessFailureCategory,
  type RunRequest,
  type QueuedSubmission,
  type UnfinishedRun
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
import type { HarnessId } from '@shared/readiness'
import {
  completeRunLifecycleResultSchema,
  openRunLifecycleResultSchema,
  type CheckoutObservation,
  type TerminalRunObservation
} from '@shared/run-lifecycle'
import type { SkillCatalog } from '@shared/skill'
import { diffSnapshots, observeCheckoutState, snapshotCheckout, type CheckoutSnapshot } from './git'
import { HARNESS_SPECS } from './readiness'
import { ToolHost, type ApprovalRequest } from './tool-host'
import type { RunProcessBroker } from './run-process-broker'
import { QueueCoordinator } from './queue-coordinator'

interface CorePort {
  send(command: CoreCommand): Promise<unknown>
}

/** What Core hands back for one pass of protocol: events, and any reply owed. */
const harnessStreamSchema = z.object({
  events: harnessEventSchema.array(),
  outgoing: z.array(z.string())
})
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
  broker: Pick<
    RunProcessBroker,
    'start' | 'stop' | 'stopAll' | 'activeRunIds' | 'needsRecovery' | 'write'
  >
  readiness: ReadinessPort
  homeDirectory: string
  privateRoot: string
  proxyExecutable: string
  proxyScript: string
  claudeOauthToken?: () => Promise<string>
  /** What is installed for a Project, with its own Skills only once trusted. */
  skills: (projectRoot: string, harness: HarnessId) => Promise<SkillCatalog>
  /** Overridable so a test can stage settings this app would never write. */
  stageSettings?: (permissionMode: PermissionMode) => unknown
  /** How long a Harness is given to end its own turn before it is stopped. */
  interruptGraceMs?: number
  /** Delivers normalized assistant and control events straight to the window. */
  onConversationEvent?: (event: ConversationStreamEvent) => void
}

/** Statuses a Run never leaves. A resend that finds one starts a new attempt. */
const TERMINAL_RUN_STATUSES = new Set<RunSnapshot['status']>([
  'completed',
  'failed',
  'stopped',
  'policy-violation',
  'supervision-failed'
])

const PROJECT_SKILL_TRUST_FAILURE = 'Project Skill trust changed before the Harness was contacted'

class ProjectSkillTrustChanged extends Error {
  constructor() {
    super(PROJECT_SKILL_TRUST_FAILURE)
  }
}

/** App-owned state holding what a Run's Checkout looked like before it ran. */
const SNAPSHOTS = 'checkout-snapshots'

/** What a snapshot is of, kept with it so a restart can still read it. */
const BASELINE = 'baseline.json'

/** A short, path-free fact prepended to a Run only when Git is not clean. */
function withCheckoutStateContext(prompt: string, observation: CheckoutStateObservation): string {
  return observation.status === 'observed' && observation.state !== 'clean'
    ? `Checkout State: ${observation.state}\n\n${prompt}`
    : prompt
}

const baselineFileSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  checkout: z.string().min(1),
  snapshot: z.object({ status: z.literal('taken'), tree: z.string().min(1) })
})

/** What a snapshot directory says it is, or nothing anybody can use. */
async function readBaseline(directory: string): Promise<z.infer<typeof baselineFileSchema> | null> {
  const text = await readFile(join(directory, BASELINE), 'utf8').catch(() => '')
  let written: unknown
  try {
    written = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = baselineFileSchema.safeParse(written)
  return parsed.success ? parsed.data : null
}

/** A Run's Checkout as it was before the Harness touched it. */
interface CheckoutBaseline {
  checkout: string
  /** App-owned, so snapshotting writes nothing into the person's repository. */
  directory: string
  snapshot: CheckoutSnapshot
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
  private readonly queueCoordinator: QueueCoordinator
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
  /** Runs already being ended by their own turn completing, so it happens once. */
  private readonly finishing = new Set<string>()
  /**
   * Runs this process has accepted and not yet ended. The broker only knows a
   * Run once its process exists, and a Run is durably open from the moment its
   * boundary is written — so between those two the broker's answer alone would
   * let the recovery pass close a Run that is starting.
   */
  private readonly mine = new Set<string>()
  /**
   * What each Run's Checkout looked like when it started. Comparing it with
   * the Checkout when the Run ends is the only way a change made by a shell
   * command is ever seen: the Harness reports the edits it makes with its own
   * tools and nothing else (ticket 12c).
   */
  private readonly baselines = new Map<string, CheckoutBaseline>()

  constructor(private readonly deps: RunServiceDeps) {
    this.queueCoordinator = new QueueCoordinator({
      core: deps.core,
      start: (sessionId, item) => this.startQueued(sessionId, item),
      pause: (sessionId) => this.setQueuePaused(sessionId, true)
    })
  }

  private async startQueued(
    sessionId: string,
    item: QueuedSubmission
  ): Promise<RunSnapshot & { recovered: boolean }> {
    const prompt =
      item.reviewAttachments.length === 0
        ? item.text
        : `${item.text}\n\nReview attachments:\n${item.reviewAttachments
            .map((attachment) => `- ${attachment.path}`)
            .join('\n')}`
    const priorAttempts = (await this.list(sessionId)).filter(
      (run) =>
        run.submissionId === item.submissionId ||
        run.submissionId.startsWith(`${item.submissionId}:attempt-`)
    )
    // Core lists newest first; reconciliation must compare the last attempt,
    // not the original submission that an edited retry superseded.
    const prior = priorAttempts[0]
    const unchanged =
      prior?.prompt === prompt &&
      prior.configuration.harness === item.harness &&
      prior.configuration.model === item.model &&
      prior.configuration.effort === item.effort &&
      prior.configuration.permissionMode === item.permissionMode &&
      (prior.configuration.skill?.name ?? null) === item.skill
    // A durable Run means the external launch may already have happened. An
    // unchanged recovered claim is therefore reconciled, never launched a
    // second time. Editing is the person's explicit request for different
    // work, and receives a new attempt identity below.
    const stoppedBeforeHarness = prior?.activity.some(
      (activity) => activity.summary === PROJECT_SKILL_TRUST_FAILURE
    )
    if (prior && unchanged && !stoppedBeforeHarness) return { ...prior, recovered: true }
    const run = await this.start(
      {
        submissionId: item.submissionId,
        sessionId,
        prompt,
        harness: item.harness,
        model: item.model,
        effort: item.effort,
        ...(item.skill ? { skill: item.skill } : {}),
        permissionMode: item.permissionMode
      },
      priorAttempts.length > 0
    )
    return { ...run, recovered: false }
  }

  /**
   * Every Checkout snapshot still on disk when the app starts belongs to a Run
   * that never got to conclude — a crash, or a quit mid-Run. Each one is the
   * record of work nobody ever compared, which is the worst case to lose it
   * in: the person cannot ask the agent what it was doing either.
   *
   * So the comparison is made now, and only then is the snapshot cleaned up.
   * One honesty cost, stated in ticket 12e rather than hidden: this measures
   * the Checkout as it is *now*, so anything the person changed between the
   * crash and reopening the app lands in that Run.
   */
  async recoverUnfinishedWork(): Promise<void> {
    const recovery = (this.recovering ??= this.recoverAll())
    try {
      await recovery
    } catch (error) {
      if (this.recovering === recovery) this.recovering = undefined
      throw error
    }
  }

  private recovering?: Promise<void>

  /** Runs this app process is still responsible for, including one being prepared. */
  activeRunCount(): number {
    return new Set([...this.deps.broker.activeRunIds(), ...this.mine]).size
  }

  private async recoverAll(): Promise<void> {
    const open = await this.unfinishedRuns()
    await this.closeUnfinishedRuns(open)
    await this.discardUnclaimedSnapshots(new Set(open.map((run) => run.runId)))
  }

  /**
   * Closes a Run its Conversation still has open. Nothing finalizes a Run the
   * app never got to finish, so its Session goes on saying the agent is
   * working when no agent is working — and the inbox is only worth having if
   * that signal is true.
   *
   * A Run this process is genuinely running is never touched: the broker is
   * asked, because it is the one that knows.
   */
  private async closeUnfinishedRuns(open: UnfinishedRun[]): Promise<void> {
    const running = new Set([...this.deps.broker.activeRunIds(), ...this.mine])
    for (const run of open) {
      if (running.has(run.runId)) continue
      const baseline = await this.abandonedBaseline(run.runId)
      await this.conclude(
        { id: run.runId, sessionId: run.sessionId },
        'failed',
        'error',
        'The app closed while this Run was working',
        baseline
      ).catch(() => undefined)
    }
  }

  private async unfinishedRuns(): Promise<UnfinishedRun[]> {
    return unfinishedRunSchema
      .array()
      .parse(await this.deps.core.send({ type: 'conversation/unfinished' }))
  }

  private async abandonedBaseline(runId: string): Promise<CheckoutBaseline | undefined> {
    const root = join(this.deps.privateRoot, SNAPSHOTS)
    const abandoned = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of abandoned) {
      if (!entry.isDirectory()) continue
      const directory = join(root, entry.name)
      const baseline = await readBaseline(directory)
      if (baseline?.runId === runId) {
        return {
          checkout: baseline.checkout,
          directory,
          snapshot: baseline.snapshot
        }
      }
    }
    return undefined
  }

  /** Removes only evidence Core says cannot belong to an unfinished Run. */
  private async discardUnclaimedSnapshots(unfinished: ReadonlySet<string>): Promise<void> {
    const root = join(this.deps.privateRoot, SNAPSHOTS)
    const abandoned = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of abandoned) {
      if (!entry.isDirectory()) continue
      const directory = join(root, entry.name)
      const baseline = await readBaseline(directory)
      if (!baseline || !unfinished.has(baseline.runId)) {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }

  /**
   * Starts a Session: the Project gets one, and the message that asked for it
   * is answered by its first Run. Sending from the launch screen is one act,
   * so it reads as one here too.
   *
   * The Run answers that same message rather than adding another — Core wrote
   * it under `startingSubmissionId` and deduplicates by that identity, so the
   * Conversation holds exactly what the person typed, once.
   *
   * A Run that cannot start does not undo the Session. The message is durable
   * the moment the Session exists, and throwing it away because a Harness was
   * not ready would lose what the person wrote. It is reported instead of
   * thrown, because the Session is real either way and the caller has one
   * thing to do with each half: open the Session, and say if it is not
   * working yet.
   */
  async startSession(request: {
    input: StartSessionInput
    run: RunRequest | undefined
  }): Promise<StartedSessionResult> {
    const input = startSessionInputSchema.parse(request.input)
    const session = sessionSummarySchema.parse(
      await this.deps.core.send({ type: 'session/start', input })
    )
    const run = request.run
    if (!run) return { status: 'started', session, runStarted: false }
    const snapshot = await this.develop({
      sessionId: session.id,
      submissionId: startingSubmissionId(session.id),
      text: input.message,
      source: 'composer',
      ...run
    }).catch(() => null)
    // `develop` answers with the Conversation when the failure is one the
    // Conversation itself explains — which it does by offering recovery — and
    // throws when it is not. Either way the question here is the same: is this
    // Session working on the message it was created with.
    return {
      status: 'started',
      session,
      runStarted: snapshot !== null && snapshot.recovery === null
    }
  }

  /**
   * Develops a Session through its Conversation: the person's message is
   * accepted durably first, and only then does one Run start. A Run that
   * never reaches the Harness leaves the message and a recovery choice.
   */
  async develop(rawInput: DevelopSessionInput): Promise<ConversationSnapshot> {
    // Before this Run takes a snapshot of its own. The sweep happens once per
    // launch and removes whatever it finds, so a Run that starts while it is
    // still running could have its own baseline deleted underneath it.
    await this.recoverUnfinishedWork().catch(() => undefined)
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

  async enqueueQueuedSubmission(rawInput: unknown): Promise<ConversationSnapshot> {
    const input = enqueueQueuedSubmissionInputSchema.parse(rawInput)
    return conversationSnapshotSchema.parse(
      await this.deps.core.send({ type: 'conversation/queue-enqueue', input })
    )
  }

  async editQueuedSubmission(rawInput: unknown): Promise<ConversationSnapshot> {
    const input = editQueuedSubmissionInputSchema.parse(rawInput)
    return conversationSnapshotSchema.parse(
      await this.deps.core.send({ type: 'conversation/queue-edit', input })
    )
  }

  async moveQueuedSubmission(rawInput: unknown): Promise<ConversationSnapshot> {
    const input = moveQueuedSubmissionInputSchema.parse(rawInput)
    return conversationSnapshotSchema.parse(
      await this.deps.core.send({ type: 'conversation/queue-move', input })
    )
  }

  async cancelQueuedSubmission(rawInput: unknown): Promise<ConversationSnapshot> {
    const input = queuedSubmissionIdentitySchema.parse(rawInput)
    return conversationSnapshotSchema.parse(
      await this.deps.core.send({ type: 'conversation/queue-cancel', input })
    )
  }

  async pauseConversationQueue(sessionId: string): Promise<ConversationSnapshot> {
    return conversationSnapshotSchema.parse(await this.setQueuePaused(sessionId, true))
  }

  async resumeConversationQueue(sessionId: string): Promise<ConversationSnapshot> {
    await this.setQueuePaused(sessionId, false)
    await this.queueCoordinator.drain(sessionId)
    return await this.readConversation(sessionId)
  }

  private setQueuePaused(sessionId: string, paused: boolean): Promise<unknown> {
    return this.deps.core.send({
      type: 'conversation/queue-state',
      input: { sessionId, paused }
    })
  }

  async sendQueuedSubmissionNow(rawInput: unknown): Promise<ConversationSnapshot> {
    const input = queuedSubmissionIdentitySchema.parse(rawInput)
    const snapshot = await this.readConversation(input.sessionId)
    if (snapshot.activeRunId) throw new Error('A Run is already active')
    await this.deps.core.send({ type: 'conversation/queue-prioritize', input })
    return await this.resumeConversationQueue(input.sessionId)
  }

  /**
   * Reads the Conversation, reconciling a Run the app no longer supervises.
   * After a crash or a forced quit the durable history can still name an
   * active Run; leaving it that way would block the person out of their own
   * Session, so it is closed as interrupted and offered back for resending.
   */
  async conversation(sessionId: string): Promise<ConversationSnapshot> {
    // Startup recovery owns terminal observations from the previous process.
    // Waiting here prevents a window read from racing it with a second,
    // necessarily less informed observation after the baseline was consumed.
    if (this.recovering) await this.recovering
    const snapshot = await this.readConversation(sessionId)
    // Acceptance makes the Run ours before the broker can register its
    // process. A refresh in that launch window must not mistake it for an
    // abandoned Run from an earlier app process.
    if (
      !snapshot.activeRunId ||
      this.mine.has(snapshot.activeRunId) ||
      this.deps.broker.activeRunIds().includes(snapshot.activeRunId)
    ) {
      return snapshot
    }
    const baseline = await this.abandonedBaseline(snapshot.activeRunId)
    await this.conclude(
      { id: snapshot.activeRunId, sessionId },
      'failed',
      'error',
      'The app stopped supervising this Run before it answered',
      baseline
    )
    return await this.readConversation(sessionId)
  }

  private readConversation(sessionId: string): Promise<ConversationSnapshot> {
    return this.deps.core
      .send({ type: 'conversation/get', sessionId })
      .then((result) => conversationSnapshotSchema.parse(result))
  }

  /**
   * The Session's Checkout: the directory the Harness is allowed to work in.
   * A Session belongs to a Project (ADR 0002); its Checkout is that Project's
   * working copy, or the isolated worktree fixed when it was created.
   */
  private async checkoutFor(sessionId: string): Promise<string> {
    const session = sessionSummarySchema.parse(
      await this.deps.core.send({ type: 'session/get', sessionId })
    )
    return checkoutDirectory(session.projectRoot, session.checkout)
  }

  async start(rawInput: StartRunInput, retryTerminal = true): Promise<RunSnapshot> {
    const input = startRunInputSchema.parse(rawInput)
    const checkout = await this.checkoutFor(input.sessionId)
    const readiness = await this.deps.readiness.refresh(input.harness)
    const harness = readiness.harnesses.find((entry) => entry.harness === input.harness)
    if (!harness?.available || !harness.executablePath) {
      throw new Error(`${input.harness} is not ready`)
    }
    if (!harness.version) throw new Error(`${input.harness} version provenance is unavailable`)
    // A Skill is whatever is installed and offered, resolved by discovery
    // rather than named in a list this app keeps: two lists of Skills are two
    // chances to offer one the Harness cannot find.
    const skill = input.skill ? await this.resolveSkill(input.skill, checkout, input.harness) : null
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
      skill,
      environment,
      checkout,
      permissionMode: input.permissionMode
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
      latestHarnessBoundary !== undefined &&
      latestHarnessBoundary.skill === input.skill &&
      latestHarnessBoundary.model === input.model &&
      (input.harness !== 'claude' ||
        (await claudeThreadExists(this.deps.homeDirectory, checkout, savedThread))) &&
      (input.harness !== 'codex' || (await codexThreadExists(this.deps.homeDirectory, savedThread)))
    const restoreFromHistory =
      switchedHarness || (latestHarness === input.harness && !threadCompatible)
    const handoff = deterministicHandoff(conversation, input.skill ?? null)
    const accept = (submissionId: string): Promise<unknown> =>
      this.deps.core.send({
        type: 'run/lifecycle-open',
        input: {
          submissionId,
          conversationSubmissionId: input.submissionId,
          sessionId: input.sessionId,
          prompt: input.prompt,
          configuration,
          askedPermissionMode: CLAUDE_PERMISSION_MODES[input.permissionMode],
          restorationNote: latestHarness === input.harness && !threadCompatible
        }
      })
    let accepted: RunSnapshot
    try {
      accepted = openRunLifecycleResultSchema.parse(await accept(input.submissionId)).run
    } catch (error) {
      if (
        !retryTerminal ||
        !(error instanceof Error) ||
        !error.message.includes('Submission identity was already used')
      ) {
        throw error
      }
      accepted = await this.acceptRetry(input.submissionId, accept)
    }
    // A resent submission whose Run already ended is a new attempt at the
    // same message. The message stays one message — the Conversation's
    // submission identity is untouched — but a Run that already failed is
    // not somewhere a retry can land, so each attempt takes its own durable
    // acceptance under a derived identity. This is what makes the recovery
    // card's "send that message again" actually contact a Harness.
    for (
      let attempt = 2;
      retryTerminal && TERMINAL_RUN_STATUSES.has(accepted.status) && attempt <= 20;
      attempt++
    ) {
      try {
        accepted = openRunLifecycleResultSchema.parse(
          await accept(`${input.submissionId}:attempt-${String(attempt)}`)
        ).run
      } catch {
        // This attempt's identity was already used for different content —
        // the person changed the configuration between retries, or the
        // Harness updated underneath them. The next attempt number is free.
      }
    }
    if (TERMINAL_RUN_STATUSES.has(accepted.status)) return accepted
    // From here on this Run is this process's, whatever the broker knows yet.
    this.mine.add(accepted.id)
    if (accepted.status !== 'accepted') {
      if (this.deps.broker.activeRunIds().includes(accepted.id)) return accepted
      return await this.record(
        accepted,
        'failed',
        'error',
        'Interrupted Run requires explicit recovery; the Harness was not contacted again'
      )
    }
    // Main owns the moment a Run starts. Publish it only after Core has made
    // the boundary durable, so a listener can immediately read `running`.
    this.deps.onConversationEvent?.({
      sessionId: input.sessionId,
      runId: accepted.id,
      event: { type: 'started' }
    })
    if (skill) {
      await this.record(
        accepted,
        undefined,
        'lifecycle',
        `Working to the ${skill.name} Skill, pinned to the text on disk when this Run started`
      )
    }
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
        await this.standingRules(checkout, input.harness),
        harness.executablePath
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
            void this.stopForPolicy(accepted, summary).catch(() => undefined)
          },
          onChoices: (question, options) => {
            void this.offerChoices(accepted, question, options).catch(() => undefined)
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
      const harnessEnvironment =
        input.harness === 'claude'
          ? {
              ...configuration.environment,
              CLAUDE_CODE_OAUTH_TOKEN: await (this.deps.claudeOauthToken ?? readClaudeOauthToken)()
            }
          : configuration.environment
      // Taken before the Harness runs, so everything the person had already
      // changed is the baseline and stays theirs.
      //
      // It is kept beside the Run rather than inside it: a Run that ends badly
      // has its directory removed, and a baseline that went with it would take
      // the answer to "what changed" away exactly when it is wanted.
      const snapshotDirectory = join(this.deps.privateRoot, SNAPSHOTS, runKey)
      const baseline: CheckoutBaseline = {
        checkout,
        directory: snapshotDirectory,
        snapshot: await snapshotCheckout(checkout, snapshotDirectory)
      }
      this.baselines.set(accepted.id, baseline)
      // Written beside its own objects, so a Run the app never gets to finish
      // can still be compared on the next start (ticket 12e). A write that
      // fails costs only that: this Run is still compared when it ends, from
      // the baseline held in memory.
      await writeFile(
        join(snapshotDirectory, BASELINE),
        JSON.stringify({
          sessionId: accepted.sessionId,
          runId: accepted.id,
          checkout,
          snapshot: baseline.snapshot
        }),
        { mode: 0o600 }
      ).catch(() => undefined)
      if (skill && input.skill) {
        const currentSkill = await this.resolveSkill(input.skill, checkout, input.harness).catch(
          () => {
            throw new ProjectSkillTrustChanged()
          }
        )
        if (currentSkill.path !== skill.path || currentSkill.hash !== skill.hash) {
          throw new ProjectSkillTrustChanged()
        }
      }
      // Observed at the last responsible moment rather than inherited from
      // the title bar: a Git operation can begin while this Run is prepared.
      const checkoutState = await observeCheckoutState(checkout)
      const runPrompt = withCheckoutStateContext(input.prompt, checkoutState)
      const running = await this.record(accepted, 'running', 'lifecycle', 'Harness process running')
      // Codex says nothing until it is spoken to, so its Adapter is opened
      // before the process is started and its opening frame written the moment
      // it is. Claude is opened the same way and is owed nothing.
      const opening = harnessStreamSchema.parse(
        await this.deps.core.send({
          type: 'harness/open',
          runId: accepted.id,
          harness: input.harness,
          ...(input.harness === 'codex'
            ? {
                launch: {
                  cwd: checkout,
                  approvalPolicy: CODEX_APPROVAL_POLICIES[input.permissionMode],
                  sandbox: CODEX_SANDBOXES[input.permissionMode],
                  ...(input.model === HARNESS_DEFAULT_MODEL ? {} : { model: input.model }),
                  effort: input.effort,
                  developerInstructions: skill
                    ? await readFile(join(skill.path, 'SKILL.md'), 'utf8')
                    : '',
                  prompt: restoreFromHistory
                    ? `${runPrompt}\n\nDeterministic handoff from the Conversation so far:\n${handoff}`
                    : runPrompt,
                  ...(threadCompatible && savedThread ? { resumeThreadId: savedThread } : {})
                }
              }
            : {})
        })
      )
      await this.deps.broker.start({
        id: accepted.id,
        executable: harness.executablePath,
        args: harnessArguments(
          { ...input, prompt: runPrompt },
          runDirectory,
          restoreFromHistory ? handoff : undefined,
          threadCompatible ? savedThread : undefined
        ),
        workingDirectory: checkout,
        runDirectory,
        environment: harnessEnvironment,
        answersProtocol: input.harness === 'codex',
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
          void this.record(accepted, undefined, 'output', summary).catch(() => undefined)
        },
        onExit: (code, signal) => {
          void (this.pendingIngest.get(accepted.id) ?? Promise.resolve())
            .then(() => {
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
            .catch(() => undefined)
        },
        onSupervisionFailure: () => {
          void this.conclude(
            accepted,
            'supervision-failed',
            'error',
            'Harness process cleanup could not be verified'
          ).catch(() => undefined)
        },
        onLimitViolation: (summary) => {
          void this.conclude(accepted, 'policy-violation', 'blocked', summary).catch(
            () => undefined
          )
        }
      })
      // Now that there is a process to speak to, it is spoken to.
      this.writeFrames(accepted.id, opening.outgoing)
      return running
    } catch (error) {
      await toolHost.close().catch(() => undefined)
      await rm(socketDirectory, { recursive: true, force: true })
      this.toolHosts.delete(accepted.id)
      if (error instanceof ProjectSkillTrustChanged) {
        await this.conclude(accepted, 'failed', 'error', PROJECT_SKILL_TRUST_FAILURE)
      } else if (!(error instanceof Error && error.message.includes('changed after durable'))) {
        await this.conclude(accepted, 'failed', 'error', 'The Harness process could not start')
      }
      throw error
    }
  }

  private async acceptRetry(
    submissionId: string,
    accept: (submissionId: string) => Promise<unknown>
  ): Promise<RunSnapshot> {
    let lastError: unknown
    for (let attempt = 2; attempt <= 20; attempt++) {
      try {
        return openRunLifecycleResultSchema.parse(
          await accept(`${submissionId}:attempt-${String(attempt)}`)
        ).run
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('No Run attempt identity is available')
  }

  async list(sessionId: string): Promise<RunSnapshot[]> {
    return runSnapshotSchema
      .array()
      .parse(await this.deps.core.send({ type: 'run/list', sessionId }))
  }

  async stop(runId: string, sessionId: string): Promise<RunSnapshot> {
    // Asked to stop before it is made to, and given a moment to do it: a
    // Harness that ends its own turn leaves its session and the Checkout in a
    // state it chose. Failing to ask is not a reason to fail to stop.
    const endedItself = await this.interruptTurn(runId).catch(() => false)
    if (endedItself) {
      // It took the hint, and ending its own turn already concluded the Run.
      return await this.record({ id: runId, sessionId }, undefined, 'lifecycle', 'Run stopped')
    }
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

  async stopAll(reason: 'core-crash' | 'quit' | 'update'): Promise<void> {
    // Pause before asking native processes to end. An exit racing shutdown may
    // otherwise look like a completed Run and drain a queue while Argos is
    // closing. Core-crash is the one case where Core cannot be asked.
    if (reason !== 'core-crash') {
      const sessions = sessionSummarySchema
        .array()
        .parse(await this.deps.core.send({ type: 'session/list' }))
      await Promise.all(sessions.map((session) => this.setQueuePaused(session.id, true)))
    }
    await this.deps.broker.stopAll(reason)
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
    const stream = harnessStreamSchema.parse(
      await this.deps.core.send({
        type: 'conversation/ingest',
        sessionId: run.sessionId,
        runId: run.id,
        harness,
        chunk
      })
    )
    // Whatever the Harness is owed in reply. Only Core knows the protocol, so
    // Main writes what Core hands it and reads none of it.
    this.writeFrames(run.id, stream.outgoing)
    for (const event of stream.events) {
      if (event.type === 'failed') this.failures.set(run.id, event.category)
      // Harness terminal frames are inputs to Main's conclusion, not durable
      // Conversation boundaries yet. `conclude` publishes the one terminal
      // event after Core has finalized the Run, so listeners never read the
      // old `running` projection or see the same ending twice.
      if (event.type !== 'completed' && event.type !== 'failed') {
        this.deps.onConversationEvent?.({
          sessionId: run.sessionId,
          runId: run.id,
          event
        })
      }
      const activity = describeActivity(event, run.configuration.permissionMode)
      if (activity) {
        await this.record(run, undefined, activity.kind, sanitize(activity.summary, checkout))
      }
      // An Approval Request Codex raised in-band. Core has already written it
      // into the Conversation; what is left is what Claude's path does too —
      // remember what would answer it, and block the Run while it stands.
      if (event.type === 'approval-request') {
        const proposals = this.proposals.get(run.id) ?? new Map<string, RequestProposal>()
        proposals.set(event.id, {
          projectRoot: checkout,
          harness,
          proposed: event.proposedRule,
          summary: event.summary
        })
        this.proposals.set(run.id, proposals)
        await this.record(run, 'waiting', 'blocked', `Waiting for you to approve ${event.summary}`)
      }
      // Codex says when it has stopped waiting on one, answered or cleared by
      // the turn ending. A card nobody can answer any more is not left up.
      if (event.type === 'approval-resolved' && event.decision === 'abandoned') {
        this.proposals.get(run.id)?.delete(event.id)
        if (!this.proposals.get(run.id)?.size) {
          await this.record(run, 'running', 'output', 'The Harness stopped waiting on that request')
        }
      }
      // `codex app-server` is a server: it answers a turn and then waits for
      // the next one, so nothing ends the Run on its own. The turn ending is
      // the Run ending here, and the process is stopped rather than left
      // running for a turn that will never be asked for.
      if (event.type === 'completed' && harness === 'codex') await this.finishTurn(run)
      // The same server-shaped problem when it fails: an error answer breaks
      // the one fixed exchange, nothing further will be said, and the process
      // sits there — a Run stuck on "Working" with the person told nothing.
      // Failure ends the Run exactly as completion does, so the Conversation
      // records what happened and its recovery guidance appears.
      if (event.type === 'failed' && harness === 'codex') await this.failTurn(run, event.summary)
    }
  }

  /**
   * Ends a Run whose Harness has finished but will not exit. Concluding first
   * means the Conversation records what happened; stopping through the broker
   * suppresses the exit path, so the Run is not concluded twice.
   */
  private async finishTurn(run: Pick<RunSnapshot, 'id' | 'sessionId'>): Promise<void> {
    if (this.finishing.has(run.id)) return
    this.finishing.add(run.id)
    await this.conclude(run, 'completed', 'lifecycle', 'Harness completed the turn')
    await this.deps.broker.stop(run.id, 'quit').catch(() => undefined)
    this.finishing.delete(run.id)
  }

  /**
   * Ends a Run whose Harness reported failure but will not exit, the failing
   * twin of {@link finishTurn}. The category the failure carried is already in
   * `failures`, so conclude reports the cause rather than a bare "it failed".
   */
  private async failTurn(
    run: Pick<RunSnapshot, 'id' | 'sessionId'>,
    summary: string
  ): Promise<void> {
    if (this.finishing.has(run.id)) return
    this.finishing.add(run.id)
    await this.conclude(run, 'failed', 'error', summary.slice(0, 500))
    await this.deps.broker.stop(run.id, 'quit').catch(() => undefined)
    this.finishing.delete(run.id)
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
    const written = input.message?.trim() ?? ''
    // A refusal the agent cannot read is one it will simply try again.
    const message =
      written === '' ? 'You declined this in the app. Ask before trying it again.' : written
    const allowed = input.decision === 'allow'
    const proposal = this.proposals.get(input.runId)?.get(input.approvalId)
    if (!proposal) {
      // The Run ended, or somebody already answered. Either way the agent has
      // moved on, and saying so beats silently pretending this took effect.
      throw new Error('That request is no longer waiting for an answer')
    }
    // Granted before the agent is told, and never on a request this app cannot
    // narrow: a permission that outlives the Run has to be durable before the
    // Run acts on it, or a crash in between leaves it granted in appearance only.
    const remembered = Boolean(input.remember && allowed && proposal.proposed)
    if (input.remember && !remembered) {
      throw new Error('That request cannot be turned into a Standing Approval')
    }
    if (remembered && proposal.proposed) {
      await this.deps.core.send({
        type: 'approval/grant',
        // The rule carries its own Harness, so it is stored exactly as it was
        // proposed — synthesised for Claude, computed by Codex for Codex.
        input: {
          ...proposal.proposed,
          projectRoot: proposal.projectRoot,
          summary: proposal.summary
        }
      })
    }
    this.proposals.get(input.runId)?.delete(input.approvalId)
    const answered = await this.answerApproval(input, {
      allowed,
      remembered,
      message,
      proposal
    })
    if (!answered) throw new Error('That request is no longer waiting for an answer')
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
    // The Run leaves the blocked state once nothing else is outstanding.
    await this.record(
      { id: input.runId, sessionId: input.sessionId },
      this.proposals.get(input.runId)?.size ? undefined : 'running',
      allowed ? 'allowed' : 'blocked',
      allowed
        ? remembered && proposal.proposed
          ? `You approved the request, and always allow ${ruleText(proposal.proposed)}`
          : 'You approved the request'
        : `You declined: ${message}`
    )
    return await this.readConversation(input.sessionId)
  }

  /**
   * Asks the Harness to end the turn it is running, and waits briefly for it
   * to. The wait is what makes this different from killing it: a frame written
   * and then followed instantly by SIGTERM is a frame nobody could act on.
   */
  /** Hands frames to the Harness. Only Main may speak to a process. */
  private writeFrames(runId: string, frames: string[]): void {
    for (const frame of frames) this.deps.broker.write(runId, frame)
  }

  private async interruptTurn(runId: string): Promise<boolean> {
    const frames = z
      .array(z.string())
      .parse(await this.deps.core.send({ type: 'harness/interrupt', runId }))
    // A Harness with no way to be asked is one there is nothing to wait for.
    if (frames.length === 0) return false
    this.writeFrames(runId, frames)
    const deadline = Date.now() + (this.deps.interruptGraceMs ?? 2_000)
    while (Date.now() < deadline) {
      if (!this.deps.broker.activeRunIds().includes(runId)) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return false
  }

  /**
   * Tells the Harness what the person decided, wherever it is waiting.
   *
   * The two Harnesses wait in different places and that is the whole of the
   * difference: Claude's request came in on the app's own MCP socket and is
   * answered by resolving the tool call it is blocked in, while Codex's came
   * in on its own protocol and is answered by writing a frame back. Everything
   * either side of this — the Conversation, the Run's blocked state, the
   * Standing Approval — is the same for both.
   */
  private async answerApproval(
    input: ResolveApprovalInput,
    decided: {
      allowed: boolean
      remembered: boolean
      message: string
      proposal: RequestProposal
    }
  ): Promise<boolean> {
    if (decided.proposal.harness === 'codex') {
      const answer = z.object({ answered: z.boolean(), outgoing: z.array(z.string()) }).parse(
        await this.deps.core.send({
          type: 'harness/answer',
          runId: input.runId,
          approvalId: input.approvalId,
          allow: decided.allowed,
          // Codex keeps the prefix it proposed, on its own decision.
          remember: decided.remembered
        })
      )
      this.writeFrames(input.runId, answer.outgoing)
      return answer.answered
    }
    const host = this.toolHosts.get(input.runId)
    if (!host?.hasOutstandingApproval(input.approvalId)) return false
    return host.resolveApproval(
      input.approvalId,
      decided.allowed
        ? {
            behavior: 'allow',
            // This Run's settings were staged before the grant existed, so the
            // rule rides along with the answer and Claude applies it to the
            // Thread it is already running. Nothing here decides what it
            // covers: its own matcher does, exactly as it will next Run.
            ...(decided.remembered && decided.proposal.proposed?.harness === 'claude'
              ? {
                  sessionRule: {
                    toolName: decided.proposal.proposed.toolName,
                    content: decided.proposal.proposed.content
                  }
                }
              : {})
          }
        : { behavior: 'deny', message: decided.message }
    )
  }

  /** Records a Run's terminal state and closes its Conversation boundary. */
  private async conclude(
    run: Pick<RunSnapshot, 'id' | 'sessionId'>,
    status: 'completed' | 'stopped' | 'failed' | 'policy-violation' | 'supervision-failed',
    kind: RunActivityKind,
    summary: string,
    recoveredBaseline?: CheckoutBaseline
  ): Promise<RunSnapshot> {
    this.mine.delete(run.id)
    const category = this.failures.get(run.id) ?? null
    const diagnostic = this.diagnostics.get(run.id)
    // A bare "it failed" helps nobody. When the Harness said nothing the app
    // could categorize, its own last diagnostic line is the explanation.
    const explained =
      status === 'failed' && category === null && diagnostic ? `${summary}: ${diagnostic}` : summary
    const baseline = recoveredBaseline ?? this.baselines.get(run.id)
    const checkoutObservation = await this.observeUnreportedChanges(run, baseline)
    const terminal = completeRunLifecycleResultSchema.parse(
      await this.deps.core.send({
        type: 'run/lifecycle-complete',
        input: {
          sessionId: run.sessionId,
          runId: run.id,
          observation: terminalObservation(status, kind, explained, category),
          checkoutObservation
        }
      })
    )
    this.failures.delete(run.id)
    this.diagnostics.delete(run.id)
    this.proposals.delete(run.id)
    if (baseline) {
      if (this.baselines.get(run.id)?.directory === baseline.directory) {
        this.baselines.delete(run.id)
      }
      await rm(baseline.directory, { recursive: true, force: true })
    }
    // Said out loud, after Core has written it: a Run ending is the one
    // lifecycle event nothing else reports. The Conversation re-reads itself
    // while a Run is in flight and would find out anyway, but every other
    // surface — the inbox and its status dots above all — only ever learns
    // what it is told, and a Session that stopped working while nobody was
    // looking would go on claiming it is running.
    this.deps.onConversationEvent?.({
      sessionId: run.sessionId,
      runId: run.id,
      event:
        terminal.run.status === 'completed'
          ? { type: 'completed' }
          : terminal.run.status === 'stopped'
            ? { type: 'stopped' }
            : { type: 'failed', category: category ?? 'unknown', summary: explained }
    })
    if (terminal.queueDisposition === 'advance') {
      void this.queueCoordinator.drain(run.sessionId).catch(() => undefined)
    }
    return terminal.run
  }

  /**
   * What the Run changed that nobody reported. Comparing the Checkout with its
   * baseline finds it however it was made — a shell command, a codemod, a
   * formatter — and Core keeps only what the Harness did not already account
   * for. A Checkout with no snapshot simply has nothing to compare, which is
   * not a failure and never ends a Run differently.
   */
  private async observeUnreportedChanges(
    run: Pick<RunSnapshot, 'id' | 'sessionId'>,
    baseline: CheckoutBaseline | undefined
  ): Promise<CheckoutObservation> {
    if (!baseline) return { status: 'unavailable' }
    try {
      if (baseline.snapshot.status !== 'taken') return { status: 'unavailable' }
      return { status: 'observed', changes: await this.compareCheckout(run, baseline) }
    } catch {
      // A comparison that cannot be made leaves the reported record alone;
      // Core still receives an honest terminal observation with no inferred changes.
      return { status: 'unavailable' }
    }
  }

  private async compareCheckout(
    run: Pick<RunSnapshot, 'id' | 'sessionId'>,
    baseline: CheckoutBaseline
  ): Promise<Extract<CheckoutObservation, { status: 'observed' }>['changes']> {
    if (baseline.snapshot.status !== 'taken') return []
    const comparison = await diffSnapshots(
      baseline.checkout,
      baseline.directory,
      baseline.snapshot,
      await snapshotCheckout(baseline.checkout, baseline.directory)
    )
    // A cap nobody is told about turns a partial answer into a wrong one.
    if (comparison.unlisted > 0) {
      await this.record(
        run,
        undefined,
        'output',
        `${String(comparison.changes.length)} of ${String(
          comparison.changes.length + comparison.unlisted
        )} changed files are listed; the rest changed too`
      )
    }
    return comparison.changes
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

  /**
   * The Skill this Run was asked for, as it is on disk right now. Pinning the
   * hash is what makes the record mean something later: the text can change
   * under a Run that has already read it.
   */
  private async resolveSkill(
    name: string,
    projectRoot: string,
    harness: StartRunInput['harness']
  ): Promise<{ name: string; path: string; hash: string }> {
    const catalog = await this.deps.skills(projectRoot, harness)
    const skill = catalog.available.find((entry) => entry.name === name)
    if (!skill) {
      throw new Error(
        `${name} is not an installed Skill for this Harness, or belongs to a Project whose Skills are not trusted`
      )
    }
    return {
      name: skill.name,
      path: skill.path,
      hash: createHash('sha256')
        .update(await readFile(join(skill.path, 'SKILL.md')))
        .digest('hex')
    }
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

  /**
   * Asks Codex whether it can read the rules this app wrote. Refusing to start
   * is the point: an unreadable rules file is ignored in silence, and a Run
   * that goes on to ask about something the person already allowed is one that
   * has lost their answer.
   */
  private async validateExecpolicy(executable: string, rulesFile: string): Promise<void> {
    const checked = await promisify(execFile)(executable, [
      'execpolicy',
      'check',
      '--rules',
      rulesFile,
      '--',
      'true'
    ]).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : 'unknown problem')
    )
    if (checked !== null) {
      throw new Error(`Refusing to start: this Project's Codex rules are not valid — ${checked}`)
    }
  }

  private async prepareHarnessHome(
    harness: StartRunInput['harness'],
    runDirectory: string,
    socketPath: string,
    capabilityToken: string,
    permissionMode: PermissionMode,
    standingRules: string[],
    /** The Harness that will read them, which is also what validates them. */
    executable: string
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
    // This Project's Standing Approvals, as Codex's own execpolicy. Validated
    // with Codex's own checker before the Run uses them, because a rules file
    // it cannot read is one it ignores — and a permission that silently never
    // loaded looks exactly like one that did.
    if (standingRules.length > 0) {
      const rulesDirectory = join(codexHome, 'rules')
      await mkdir(rulesDirectory, { recursive: true, mode: 0o700 })
      const rulesFile = join(rulesDirectory, 'standing-approvals.rules')
      await writeFile(rulesFile, `${standingRules.join('\n')}\n`, { mode: 0o600 })
      await this.validateExecpolicy(executable, rulesFile)
    }
    // Auth follows CODEX_HOME, so a staged home needs it reachable — as a link
    // rather than a copy. It is a credential, and this app does not hold one.
    await symlink(
      join(this.deps.homeDirectory, '.codex', 'auth.json'),
      join(codexHome, 'auth.json')
    )
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

function terminalObservation(
  status: 'completed' | 'stopped' | 'failed' | 'policy-violation' | 'supervision-failed',
  kind: RunActivityKind,
  summary: string,
  category: HarnessFailureCategory | null
): TerminalRunObservation {
  switch (status) {
    case 'completed':
      return { type: 'harness-completed', kind, summary }
    case 'failed':
      return { type: 'harness-failed', kind, summary, category }
    case 'stopped':
      return { type: 'person-stopped', kind, summary }
    case 'policy-violation':
      return { type: 'policy-violation', kind, summary }
    case 'supervision-failed':
      return { type: 'supervision-failed', kind, summary }
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
  runDirectory: string,
  handoff?: string,
  threadId?: string
): string[] {
  if (input.harness === 'codex') {
    // One long-lived JSON-RPC peer. Everything that used to be argv — policy,
    // sandbox, model, effort, the Skill, the prompt — now travels over the
    // protocol, where approvals and diffs travel too.
    return ['app-server']
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
    // Only when the chosen model has one. Asking for a level a model does not
    // offer is asking the Harness for something it would refuse (ticket 13).
    ...(input.effort === null ? [] : ['--effort', input.effort]),
    // Claude reads a Skill natively when the message names one; without one
    // the message is just the message.
    `${input.skill ? `/${input.skill} ` : ''}${input.prompt}${handoff ? `\n\nDeterministic handoff from the Conversation so far:\n${handoff}` : ''}`
  ]
}

/**
 * What a new Harness Thread needs to continue the Conversation: the Skill in
 * force and the turns immediately before it.
 */
function deterministicHandoff(conversation: ConversationSnapshot, skill: string | null): string {
  const recent = conversation.entries
    .filter((entry) => entry.kind === 'message')
    .slice(-8)
    .map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.text}`)
    .join('\n')
  return [...(skill ? [`Skill: ${skill}`] : []), 'Recent turns:', recent || '(none)'].join('\n')
}

/**
 * Whether Codex still holds the rollout behind a saved Harness Thread. Codex
 * refuses to resume a thread whose rollout file is gone — "no rollout found
 * for thread id …" — and retrying the same id can never succeed, so a thread
 * that is not on disk takes the restore-from-history path instead of failing
 * the Run. Rollouts live under `sessions/YYYY/MM/DD/rollout-…-<threadId>.jsonl`;
 * checked on disk like Claude's, because the app-server is not running yet.
 */
async function codexThreadExists(homeDirectory: string, threadId: string): Promise<boolean> {
  const sessions = join(homeDirectory, '.codex', 'sessions')
  const suffix = `-${threadId}.jsonl`
  const list = (directory: string): Promise<{ name: string; isDirectory(): boolean }[]> =>
    readdir(directory, { withFileTypes: true }).then(
      (entries) => entries,
      () => []
    )
  for (const year of await list(sessions)) {
    if (!year.isDirectory()) continue
    for (const month of await list(join(sessions, year.name))) {
      if (!month.isDirectory()) continue
      for (const day of await list(join(sessions, year.name, month.name))) {
        if (!day.isDirectory()) continue
        const files = await list(join(sessions, year.name, month.name, day.name))
        if (files.some((file) => !file.isDirectory() && file.name.endsWith(suffix))) return true
      }
    }
  }
  return false
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
 * The same two Modes as Codex names them (`docs/harness-permission-mapping.md`).
 * `untrusted` is the only policy that guarantees escalation is decided by a
 * rule rather than by the model, so a person who chose Ask cannot silently get
 * no prompts; `never` with full access is the documented no-prompt pairing.
 */
const CODEX_APPROVAL_POLICIES: Record<PermissionMode, CodexLaunch['approvalPolicy']> = {
  ask: 'untrusted',
  auto: 'never'
}

const CODEX_SANDBOXES: Record<PermissionMode, CodexLaunch['sandbox']> = {
  ask: 'workspace-write',
  auto: 'danger-full-access'
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
