import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Effect from 'effect/Effect'
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
  MAX_APPROVAL_DETAIL,
  MAX_COMPACTION_SUMMARY,
  compactSessionInputSchema,
  compactionPlanSchema,
  conversationSnapshotSchema,
  developSessionInputSchema,
  editQueuedSubmissionInputSchema,
  enqueueQueuedSubmissionInputSchema,
  harnessEventSchema,
  headroomExhausted,
  moveQueuedSubmissionInputSchema,
  queuedSubmissionIdentitySchema,
  redactCredentials,
  startingSubmissionId,
  unfinishedRunSchema,
  type CompactSessionInput,
  type CompactionPlan,
  type ConversationSnapshot,
  type ConversationEvent,
  type ConversationStreamEvent,
  type DevelopSessionInput,
  type HarnessEvent,
  type HarnessFailureCategory,
  type RunRequest,
  type QueuedSubmissionLaunchPlan,
  type UnfinishedRun
} from '@shared/conversation'
import { harnessPromptWithReviewAttachments } from '@shared/review-attachment'
import { proposeStandingApproval, ruleText } from '@shared/approval'
import {
  resolveApprovalInputSchema,
  runSnapshotSchema,
  startRunInputSchema,
  PROJECT_SKILL_TRUST_FAILURE,
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
import { diffSnapshots, observeCheckoutState, type CheckoutSnapshot } from './git'
import type { SessionSnapshotStore } from './snapshot-store'
import { HARNESS_SPECS } from './readiness'
import { ToolHost, type ApprovalRequest } from './tool-host'
import type { RunProcessBroker } from './run-process-broker'
import { QueueCoordinator } from './queue-coordinator'
import {
  createHarnessAdapter,
  harnessAdapterLayer,
  type AdapterRequestProposal,
  type BoundedRunner,
  type HarnessAdapter
} from './harness-adapter'
import { conversationSeed, latestCompaction, threadReuseVetoed } from './thread-continuity'

interface CorePort {
  send(command: CoreCommand): Promise<unknown>
}

/** What Core hands back for one pass of protocol: events, and any reply owed. */
const harnessStreamSchema = z.object({
  events: harnessEventSchema.array(),
  outgoing: z.array(z.string())
})
interface ReadinessPort {
  refresh(harness?: HarnessId): Promise<{
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
  /**
   * Where each Session's before/after Run trees are kept (ADR 0006). Passed in
   * rather than made here, because undo reads the same store: two stores over
   * one directory would be two answers to "what did this Run change".
   */
  snapshots: SessionSnapshotStore
  proxyExecutable: string
  proxyScript: string
  claudeOauthToken?: () => Promise<string>
  /** What is installed for a Project, with its own Skills only once trusted. */
  skills: (projectRoot: string, harness: HarnessId) => Promise<SkillCatalog>
  /** Overridable so a test can stage settings this app would never write. */
  stageSettings?: (permissionMode: PermissionMode) => unknown
  /** How a bounded, non-mutating request reaches a Harness; injectable for tests. */
  runBounded?: BoundedRunner
  /** How long a Harness is given to end its own turn before it is stopped. */
  interruptGraceMs?: number
  /** Delivers normalized assistant and control events straight to the window. */
  onConversationEvent?: (event: ConversationStreamEvent) => void
  /** Runs Main product Effects on Electron's one scoped runtime. */
  runEffect?: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
}

/** Statuses a Run never leaves. A resend that finds one starts a new attempt. */
const TERMINAL_RUN_STATUSES = new Set<RunSnapshot['status']>([
  'completed',
  'failed',
  'stopped',
  'policy-violation',
  'supervision-failed'
])

const MAILBOX_INVALIDATING_EVENT_TYPES: ReadonlySet<ConversationEvent['type']> = new Set([
  'started',
  'stopped',
  'choices',
  'approval-request',
  'approval-resolved',
  'completed',
  'failed'
])

function conversationInvalidation(
  event: ConversationEvent
): ConversationStreamEvent['invalidation'] {
  return MAILBOX_INVALIDATING_EVENT_TYPES.has(event.type) ? 'mailbox' : 'none'
}

class ProjectSkillTrustChanged extends Error {
  constructor() {
    super(PROJECT_SKILL_TRUST_FAILURE)
  }
}

/**
 * What the Harness is asked when a Session is compacted. A second compaction
 * hands the summary already in force over as material to be rewritten rather
 * than summarized again: preserve what is still true, drop what is stale, and
 * merge in what is new. A summary of a summary decays into noise.
 */
function compactionPrompt(plan: CompactionPlan): string {
  return [
    ...(plan.previousSummary
      ? [
          'A summary of the earlier part of this session is already in force:',
          plan.previousSummary,
          '',
          'Rewrite it into a single summary using the turns below: keep what is still true, drop what is stale, and merge in what is new. Do not produce a summary of the summary.',
          ''
        ]
      : ['Summarize the session below into a single summary that lets the work continue.', '']),
    'Keep what the next turn would need: the shape of the codebase, the conventions in force, the decisions taken, and what was tried and rejected.',
    '',
    'The session so far:',
    plan.material || '(nothing yet)'
  ].join('\n')
}

/** A short, path-free fact prepended to a Run only when Git is not clean. */
function withCheckoutStateContext(prompt: string, observation: CheckoutStateObservation): string {
  return observation.status === 'observed' && observation.state !== 'clean'
    ? `Checkout State: ${observation.state}\n\n${prompt}`
    : prompt
}

/** A Run's Checkout as it was before the Harness touched it. */
interface CheckoutBaseline {
  sessionId: string
  runId: string
  checkout: string
  snapshot: CheckoutSnapshot
}

/** What one outstanding request could be turned into, if the person asks. */
type RequestProposal = AdapterRequestProposal

/**
 * Main's Harness-independent Run owner. It observes native facts, delegates
 * every Harness-specific fact to the selected Adapter, and sends one opening
 * or terminal lifecycle request to Core; it never sequences Core persistence.
 */
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
  /** The selected implementation for each active Run. */
  private readonly adapters = new Map<string, HarnessAdapter>()
  /**
   * The compaction each Session has in flight. Anything that would start the
   * next Run waits on it: a Run that began first would resume the Thread the
   * compaction is in the middle of retiring.
   */
  private readonly compactions = new Map<string, Promise<void>>()

  constructor(private readonly deps: RunServiceDeps) {
    this.queueCoordinator = new QueueCoordinator({
      queue: {
        next: (sessionId) => deps.core.send({ type: 'conversation/queue-next', sessionId }),
        observeLaunch: (input) =>
          deps.core.send({ type: 'conversation/queue-launch-observed', input })
      },
      start: (plan) => this.startQueued(plan),
      runEffect: (effect) => this.runEffect(effect)
    })
  }

  private adapter(harness: HarnessId): HarnessAdapter {
    return createHarnessAdapter(
      harness,
      harnessAdapterLayer({
        core: this.deps.core,
        homeDirectory: this.deps.homeDirectory,
        proxyExecutable: this.deps.proxyExecutable,
        proxyScript: this.deps.proxyScript,
        claudeOauthToken: this.deps.claudeOauthToken,
        stageSettings: this.deps.stageSettings,
        writeFrame: (runId, frame) => this.deps.broker.write(runId, frame),
        ...(this.deps.runBounded ? { runBounded: this.deps.runBounded } : {})
      })
    )
  }

  private runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
    return this.deps.runEffect ? this.deps.runEffect(effect) : Effect.runPromise(effect)
  }

  private startQueued(plan: QueuedSubmissionLaunchPlan): Promise<RunSnapshot> {
    const item = plan.item
    return this.start(
      {
        submissionId: item.submissionId,
        sessionId: plan.sessionId,
        prompt: plan.prompt,
        harness: item.harness,
        model: item.model,
        effort: item.effort,
        ...(item.skill ? { skill: item.skill } : {}),
        permissionMode: item.permissionMode
      },
      false,
      plan.runSubmissionId
    )
  }

  /**
   * A Run whose Conversation is still open when the app starts is one that
   * never got to conclude — a crash, or a quit mid-Run. Its before snapshot is
   * the record of work nobody ever compared, which is the worst case to lose
   * it in: the person cannot ask the agent what it was doing either.
   *
   * So the comparison is made now. One honesty cost, stated in ticket 12e
   * rather than hidden: this measures the Checkout as it is *now*, so anything
   * the person changed between the crash and reopening the app lands in that
   * Run — and, since ADR 0006, would be part of what undoing it puts back.
   *
   * Nothing is applied here and nothing is reapplied. Recovery only ever
   * observes and records; putting a Run back is something a person asks for.
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
    await this.discardOrphanedSnapshots()
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
      const baseline = await this.abandonedBaseline(run.sessionId, run.runId)
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

  /** The before snapshot of a Run the previous process never got to conclude. */
  private async abandonedBaseline(
    sessionId: string,
    runId: string
  ): Promise<CheckoutBaseline | undefined> {
    const record = await this.deps.snapshots.read(sessionId, runId)
    if (!record?.before) return undefined
    return {
      sessionId,
      runId,
      checkout: record.checkout,
      snapshot: { status: 'taken', tree: record.before }
    }
  }

  /**
   * Removes stores no Session claims, and the working files a crash left
   * mid-capture in the ones that remain.
   *
   * Snapshots are retained for the life of a Session now (ADR 0006), so this
   * is no longer a sweep of everything unfinished — it is only the litter: a
   * Session deleted while its store could not be removed, or a store written
   * by a Session that has since gone.
   */
  private async discardOrphanedSnapshots(): Promise<void> {
    const [intact, damaged] = await Promise.all([
      this.deps.core
        .send({ type: 'session/list' })
        .then((result) => sessionSummarySchema.array().parse(result)),
      // A Session whose record could not be read is damaged, not gone: Core
      // reports it so the loss can be shown rather than inferred, and it may
      // yet be repaired. Pruning on "not in the intact list" would quietly
      // destroy its snapshots — the one thing this sweep must never do.
      this.deps.core
        .send({ type: 'session/list-damaged' })
        .then((result) => z.array(z.string()).parse(result))
        .catch(() => [] as string[])
    ])
    const claimed = new Set([...intact.map((session) => session.id), ...damaged])
    await this.deps.snapshots.pruneUnknown(claimed)
    for (const session of intact) await this.deps.snapshots.clearScratch(session.id)
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
        source: input.source,
        reviewAttachments: input.reviewAttachments
      }
    })
    try {
      await this.start({
        submissionId: input.submissionId,
        sessionId: input.sessionId,
        // The Conversation keeps the person's own words; the Harness is the
        // only place the reviewed snapshots are spelled out.
        prompt: harnessPromptWithReviewAttachments(input.text, input.reviewAttachments),
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
      await this.deps.core.send({
        type: 'conversation/queue-change',
        input: { type: 'enqueue', input }
      })
    )
  }

  async editQueuedSubmission(rawInput: unknown): Promise<ConversationSnapshot> {
    const input = editQueuedSubmissionInputSchema.parse(rawInput)
    return conversationSnapshotSchema.parse(
      await this.deps.core.send({
        type: 'conversation/queue-change',
        input: { type: 'edit', input }
      })
    )
  }

  async moveQueuedSubmission(rawInput: unknown): Promise<ConversationSnapshot> {
    const input = moveQueuedSubmissionInputSchema.parse(rawInput)
    return conversationSnapshotSchema.parse(
      await this.deps.core.send({
        type: 'conversation/queue-change',
        input: { type: 'move', input }
      })
    )
  }

  async cancelQueuedSubmission(rawInput: unknown): Promise<ConversationSnapshot> {
    const input = queuedSubmissionIdentitySchema.parse(rawInput)
    return conversationSnapshotSchema.parse(
      await this.deps.core.send({
        type: 'conversation/queue-change',
        input: { type: 'cancel', input }
      })
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
      type: 'conversation/queue-change',
      input: { type: paused ? 'pause' : 'resume', sessionId }
    })
  }

  async sendQueuedSubmissionNow(rawInput: unknown): Promise<ConversationSnapshot> {
    const input = queuedSubmissionIdentitySchema.parse(rawInput)
    await this.deps.core.send({
      type: 'conversation/queue-change',
      input: { type: 'send-now', input }
    })
    await this.queueCoordinator.drain(input.sessionId)
    return await this.readConversation(input.sessionId)
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
    const baseline = await this.abandonedBaseline(sessionId, snapshot.activeRunId)
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

  async start(
    rawInput: StartRunInput,
    retryTerminal = true,
    runSubmissionId?: string
  ): Promise<RunSnapshot> {
    const input = startRunInputSchema.parse(rawInput)
    const adapter = this.adapter(input.harness)
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
    const environment = await this.runEffect(
      adapter.environment(harness.executablePath, runDirectory)
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
    // A compaction still being written is one this Run must be seeded from,
    // not one it races: starting first would resume the Thread it is retiring.
    await this.settleCompaction(input.sessionId)
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
      !threadReuseVetoed(conversation, input.harness) &&
      (await this.runEffect(adapter.threadExists(checkout, savedThread)))
    const restoreFromHistory =
      switchedHarness || (latestHarness === input.harness && !threadCompatible)
    // A Session that has been compacted is seeded from its summary and the
    // turns it kept whole, rather than from the last few turns alone: the
    // summary is the whole reason the Thread was not resumed.
    const handoff = conversationSeed(conversation, {
      shape: latestCompaction(conversation) ? 'compaction' : 'handoff',
      skill: input.skill ?? null
    })
    const accept = (submissionId: string): Promise<unknown> =>
      this.deps.core.send({
        type: 'run/lifecycle-open',
        input: {
          submissionId,
          conversationSubmissionId: input.submissionId,
          sessionId: input.sessionId,
          prompt: input.prompt,
          configuration,
          askedPermissionMode: adapter.askedPermissionMode(input.permissionMode),
          restorationNote: latestHarness === input.harness && !threadCompatible
        }
      })
    let accepted: RunSnapshot
    try {
      accepted = openRunLifecycleResultSchema.parse(
        await accept(runSubmissionId ?? input.submissionId)
      ).run
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
    this.adapters.set(accepted.id, adapter)
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
      invalidation: 'mailbox',
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
      await this.runEffect(
        adapter.prepare({
          runDirectory,
          socketPath,
          capabilityToken,
          permissionMode: input.permissionMode,
          standingRules: await this.standingRules(checkout, adapter.id),
          executable: harness.executablePath
        })
      )
      toolHost = new ToolHost({
        socketPath,
        capabilityToken,
        servesApprovals: input.permissionMode === 'ask' && adapter.servesApprovals,
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
          onApproval: (request) => this.requestApproval(accepted, checkout, adapter.id, request),
          readConversation: () => this.readConversation(accepted.sessionId)
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
      const harnessEnvironment = await this.runEffect(
        adapter.launchEnvironment(harness.executablePath, runDirectory)
      )
      // Taken before the Harness runs, so everything the person had already
      // changed is the baseline and stays theirs.
      //
      // It goes to the Session's own store rather than beside this Run: a Run
      // that ends badly has its directory removed, and a baseline that went
      // with it would take the answer to "what changed" away exactly when it
      // is wanted — and, since ADR 0006, would take undo with it.
      //
      // Written to disk as well as held in memory, so a Run the app never gets
      // to finish can still be compared on the next start (ticket 12e). A
      // write that fails costs only that: this Run is still compared when it
      // ends, from the baseline in hand.
      const baseline: CheckoutBaseline = {
        sessionId: accepted.sessionId,
        runId: accepted.id,
        checkout,
        snapshot: await this.deps.snapshots
          .capture({
            sessionId: accepted.sessionId,
            runId: accepted.id,
            checkout,
            phase: 'before'
          })
          .catch((): CheckoutSnapshot => ({ status: 'skipped', reason: 'not-a-repository' }))
      }
      this.baselines.set(accepted.id, baseline)
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
      const opening = await this.runEffect(
        adapter.open({
          runId: accepted.id,
          checkout,
          configuration,
          prompt: runPrompt,
          skillInstructions: skill ? await readFile(join(skill.path, 'SKILL.md'), 'utf8') : '',
          ...(restoreFromHistory ? { handoff } : {}),
          ...(threadCompatible && savedThread ? { resumeThreadId: savedThread } : {})
        })
      )
      await this.deps.broker.start({
        id: accepted.id,
        executable: harness.executablePath,
        args: await this.runEffect(
          adapter.arguments(
            { ...configuration, prompt: runPrompt },
            runDirectory,
            restoreFromHistory ? handoff : undefined,
            threadCompatible ? savedThread : undefined
          )
        ),
        workingDirectory: checkout,
        runDirectory,
        environment: harnessEnvironment,
        answersProtocol: adapter.answersProtocol,
        onBeforeCleanup: async () => {
          await toolHost.close()
          await rm(socketDirectory, { recursive: true, force: true })
          this.toolHosts.delete(accepted.id)
        },
        onOutput: (stream, text) => {
          if (stream === 'stdout') {
            const pending = (this.pendingIngest.get(accepted.id) ?? Promise.resolve())
              .then(() => this.ingest(accepted, adapter, checkout, text))
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
    adapter: HarnessAdapter,
    checkout: string,
    chunk: string
  ): Promise<void> {
    const stream = harnessStreamSchema.parse(
      await this.deps.core.send({
        type: 'conversation/ingest',
        sessionId: run.sessionId,
        runId: run.id,
        harness: adapter.id,
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
          invalidation: conversationInvalidation(event),
          event
        })
      }
      const activity = describeActivity(
        event,
        run.configuration.permissionMode,
        adapter.askedPermissionMode(run.configuration.permissionMode)
      )
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
          harness: adapter.id,
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
      const terminal = adapter.terminalFact(event)
      if (terminal) await this.finishHarnessTurn(run, terminal)
    }
  }

  /**
   * Ends a Run whose Harness has finished but will not exit. Concluding first
   * means the Conversation records what happened; stopping through the broker
   * suppresses the exit path, so the Run is not concluded twice.
   */
  private async finishHarnessTurn(
    run: Pick<RunSnapshot, 'id' | 'sessionId'>,
    terminal: { status: 'completed' | 'failed'; kind: 'lifecycle' | 'error'; summary: string }
  ): Promise<void> {
    if (this.finishing.has(run.id)) return
    this.finishing.add(run.id)
    await this.conclude(run, terminal.status, terminal.kind, terminal.summary)
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
      invalidation: conversationInvalidation(event),
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
    this.deps.onConversationEvent?.({
      sessionId: run.sessionId,
      runId: run.id,
      invalidation: conversationInvalidation(event),
      event
    })
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
      invalidation: conversationInvalidation(event),
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
    const adapter = this.adapters.get(runId)
    if (!adapter || !(await this.runEffect(adapter.interrupt(runId)))) return false
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
    const adapter = this.adapters.get(input.runId) ?? this.adapter(decided.proposal.harness)
    return await this.runEffect(
      adapter.answerApproval({
        runId: input.runId,
        approvalId: input.approvalId,
        allowed: decided.allowed,
        remembered: decided.remembered,
        message: decided.message,
        proposal: decided.proposal,
        host: this.toolHosts.get(input.runId)
      })
    )
  }

  /** Records a Run's terminal state and closes its Conversation boundary. */
  /**
   * Replaces the agent's memory of this Session's early turns with a summary,
   * and leaves the Conversation exactly as it is. The next Run declines to
   * resume the Thread this compaction retired and starts a fresh one from the
   * summary and the turns it kept whole.
   *
   * Core decides what a compaction means — where the tail begins, what the
   * summary has to account for, and whether one may happen at all. Only the
   * writing of the summary is here, because only Main can speak to a Harness.
   */
  async compact(rawInput: CompactSessionInput): Promise<ConversationSnapshot> {
    const input = compactSessionInputSchema.parse(rawInput)
    const plan = compactionPlanSchema.parse(
      await this.deps.core.send({
        type: 'conversation/compaction-plan',
        sessionId: input.sessionId
      })
    )
    if (plan.harness === null) {
      throw new Error('No Harness has answered in this Session, so none can summarize it')
    }
    const readiness = await this.deps.readiness.refresh(plan.harness)
    const harness = readiness.harnesses.find((entry) => entry.harness === plan.harness)
    if (!harness?.available || !harness.executablePath) {
      throw new Error(`${plan.harness} is not ready to summarize this Session`)
    }
    // The compaction's identity is the point it compacts to, so a request
    // retried after a summary that never landed writes one boundary, not two.
    const operationId = createHash('sha256')
      .update(`${input.sessionId}\0${plan.tailFromEntryId}`)
      .digest('hex')
    const summary = (
      await this.runEffect(
        this.adapter(plan.harness).summarize({
          executable: harness.executablePath,
          checkout: await this.checkoutFor(input.sessionId),
          runDirectory: join(this.deps.privateRoot, 'compaction', operationId),
          prompt: compactionPrompt(plan)
        })
      )
    ).slice(0, MAX_COMPACTION_SUMMARY)
    if (!summary) {
      throw new Error(`${plan.harness} returned no summary, so nothing was compacted`)
    }
    const snapshot = conversationSnapshotSchema.parse(
      await this.deps.core.send({
        type: 'conversation/compact',
        input: {
          sessionId: input.sessionId,
          operationId,
          runId: plan.runId,
          summary,
          tailFromEntryId: plan.tailFromEntryId,
          // The app is compacting, not the Harness: this Thread is retired.
          native: false
        }
      })
    )
    // The inbox reads a projection rather than the Conversation, so it is told
    // rather than left to find out.
    this.deps.onConversationEvent?.({
      sessionId: input.sessionId,
      runId: plan.runId,
      invalidation: 'mailbox',
      event: { type: 'context-compacted', summary }
    })
    return snapshot
  }

  /**
   * Compacts a Session whose latest Run left it too little room to carry on,
   * without being asked.
   *
   * It runs beside the Run that ended rather than inside it: writing the
   * summary is a Harness request, and a person who pressed Stop must not wait
   * on one. Everything that would start the *next* Run waits on it instead —
   * the queue draining, and a message sent from the composer — because a Run
   * that started first would resume the very Thread this is retiring.
   *
   * Best-effort by construction: a compaction that cannot be made must not
   * turn a Run that ended into a Run that failed, and the person can still ask
   * for one themselves.
   */
  private compactIfShortOfRoom(sessionId: string): Promise<void> {
    const work = this.compactForHeadroom(sessionId)
    this.compactions.set(sessionId, work)
    void work.finally(() => {
      if (this.compactions.get(sessionId) === work) this.compactions.delete(sessionId)
    })
    return work
  }

  /** Whatever compaction this Session already has in flight, if any. */
  private async settleCompaction(sessionId: string): Promise<void> {
    await this.compactions.get(sessionId)
  }

  private async compactForHeadroom(sessionId: string): Promise<void> {
    try {
      const conversation = await this.readConversation(sessionId)
      if (!headroomExhausted(conversation.usage.run)) return
      // A Harness that compacted its own Thread since the last app-side
      // compaction has already made the room this would be making.
      const latest = conversation.entries.findLast(
        (entry) => entry.kind === 'boundary' && entry.compaction !== undefined
      )
      if (latest?.kind === 'boundary' && latest.compaction?.native === true) return
      await this.compact({ sessionId })
    } catch {
      // Nothing is owed here. The Run has ended either way, and the recovery
      // the person is shown offers compaction as something they can ask for.
    }
  }

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
    this.adapters.delete(run.id)
    // The store itself stays: it belongs to the Session, not to this Run, and
    // it is what makes undoing this Run possible for as long as the Session
    // exists (ADR 0006). Only the in-memory handle is released.
    if (baseline && this.baselines.get(run.id)?.runId === baseline.runId) {
      this.baselines.delete(run.id)
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
      invalidation: 'mailbox',
      event:
        terminal.run.status === 'completed'
          ? { type: 'completed' }
          : terminal.run.status === 'stopped'
            ? { type: 'stopped' }
            : { type: 'failed', category: category ?? 'unknown', summary: explained }
    })
    // Before the next message goes anywhere near this Session. A Session that
    // has run out of room is one whose next Run would die of it, and the
    // person is not made to notice first — but this Run is over now, and
    // saying so does not wait on a summary being written.
    const compacted = this.compactIfShortOfRoom(run.sessionId)
    if (terminal.queueDisposition === 'advance') {
      void compacted.then(() => this.queueCoordinator.drain(run.sessionId)).catch(() => undefined)
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
    // Recorded before anything this Run owns is cleaned up, and recorded even
    // when the comparison below cannot be made: the after tree is half of what
    // undoing this Run needs, and a Run whose diff failed to render is not a
    // Run whose state should become unrecoverable.
    const after = await this.deps.snapshots.capture({
      sessionId: baseline.sessionId,
      runId: baseline.runId,
      checkout: baseline.checkout,
      phase: 'after'
    })
    const comparison = await diffSnapshots(
      baseline.checkout,
      this.deps.snapshots.directoryFor(baseline.sessionId),
      baseline.snapshot,
      after
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

/** The Harness executable exactly as it was when a Run was accepted. */
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
 * What a normalized event contributes to the collapsed activity stream.
 * Assistant text and Suggested Responses are Conversation content, not
 * activity, so they deliberately produce nothing here.
 */
function describeActivity(
  event: HarnessEvent,
  permissionMode: PermissionMode,
  askedPermissionMode: string
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
      const mismatch =
        event.permissionMode !== undefined && event.permissionMode !== askedPermissionMode
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
    case 'subagent':
      // Only the dispatch and the ending: a subagent reports itself many times
      // over as it works, and an activity stream repeating each one would be a
      // log of the reporting rather than of the work.
      return event.status === 'working'
        ? undefined
        : {
            kind: event.status === 'failed' ? 'error' : 'output',
            summary: `Subagent ${event.name} ${event.status === 'done' ? 'reported back' : event.status}`
          }
    // The Plan is Conversation content: it is drawn in the transcript, and an
    // activity line per rewrite would be a log of the agent revising a list
    // rather than of anything it did. An approval is recorded where it is
    // decided, with the wording the person actually saw; repeating it here
    // would say it twice.
    // A compaction is Conversation content too: it is drawn where it happened,
    // beside the turns it stands in for.
    case 'plan':
    case 'context-compacted':
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
