import type {
  ConversationEntry,
  ConversationSnapshot,
  ConversationStreamEvent,
  HarnessEvent,
  PlanStep,
  RunSnapshot,
  SuggestedResponse
} from '@shared/contract'
import type { FleetMember, SubagentEntry } from './subagent-fleet'

export type LiveFileChange = Extract<ConversationEntry, { kind: 'file-change' }>

/**
 * One subagent as the Run is reporting it right now, ahead of the durable
 * entry behind it. A subagent reports itself many times a minute while it
 * works, and a dock that only redrew on the durable read would be a dock
 * describing what the fleet was doing a moment ago.
 */
export type LiveSubagent = Omit<Extract<HarnessEvent, { type: 'subagent' }>, 'type'>

/**
 * The Plan as the Run is reporting it right now, ahead of the durable entry
 * behind it. A Plan is rewritten a handful of times in a Run rather than many
 * times a minute, but the step it says is being worked on is the most current
 * thing on screen, and a checklist a paint behind is a checklist saying the
 * agent is on a step it has finished.
 */
export type LivePlan = Omit<Extract<HarnessEvent, { type: 'plan' }>, 'type'>

/** Streamed state for the Run in flight, ahead of its durable projection. */
export interface LiveRun {
  runId: string
  messages: { id: string; text: string }[]
  changes: LiveFileChange[]
  fileChangeOrdinal: number
  commands: { id: string; command: string; output: string; failed: boolean; running: boolean }[]
  subagents: LiveSubagent[]
  /** Null until the agent writes one, which most Runs never do. */
  plan: LivePlan | null
  suggestedResponses: SuggestedResponse[]
}

export interface SelectedConversationSnapshot {
  conversation: ConversationSnapshot
  runs: RunSnapshot[]
  live: LiveRun | null
  failureSummary: string | null
}

/** Suppresses state published by the owner of a previously selected Session. */
export function conversationSelectedFor(
  sessionId: string | null,
  selected: SelectedConversationSnapshot | null
): SelectedConversationSnapshot | null {
  return selected?.conversation.sessionId === sessionId ? selected : null
}

interface ConversationRefreshDependencies {
  readConversation: () => Promise<ConversationSnapshot>
  readRuns: () => Promise<RunSnapshot[]>
  publish: (snapshot: SelectedConversationSnapshot) => void
  fail?: () => void
  requestPaint?: (callback: (time: number) => void) => number
  cancelPaint?: (handle: number) => void
  scheduleRefresh?: (callback: () => void, delayMs: number) => unknown
  cancelRefresh?: (handle: unknown) => void
}

const RUN_HISTORY_NOT_READ = Symbol('run-history-not-read')

/**
 * The selected Session's read model. One owner reconciles durable Conversation
 * and Run reads with pushed state, action results, freshness cadence, and paint
 * cadence before any renderer consumer sees them.
 */
export class SelectedConversationReadModel {
  private latest: SelectedConversationSnapshot | null = null
  private live: LiveRun | null = null
  private pendingLive: LiveRun | null = null
  private streamed: ConversationStreamEvent[] = []
  private failureSummary: string | null = null
  private runsForActiveRun: string | null | typeof RUN_HISTORY_NOT_READ = RUN_HISTORY_NOT_READ
  private revision = 0
  private requested = 0
  private completed = 0
  private inFlightDrain: Promise<void> | null = null
  private paintHandle: number | null = null
  private freshnessTimer: unknown = null

  constructor(
    private readonly sessionId: string,
    private readonly dependencies: ConversationRefreshDependencies
  ) {}

  requestRefresh(): Promise<SelectedConversationSnapshot | null> {
    this.requested += 1
    this.inFlightDrain ??= this.drain().finally(() => {
      this.inFlightDrain = null
    })
    return this.inFlightDrain.then(() => this.latest)
  }

  /** Takes a snapshot returned by a write without waiting for a reread. */
  adopt(conversation: ConversationSnapshot): void {
    if (conversation.sessionId !== this.sessionId) return
    this.revision += 1
    if (
      conversation.activeRunId !== null &&
      conversation.activeRunId !== this.latest?.conversation.activeRunId
    ) {
      this.failureSummary = null
    }
    this.reconcileLive(conversation)
    this.latest = {
      conversation,
      runs: this.latest?.runs ?? [],
      live: this.live,
      failureSummary: this.failureSummary
    }
    this.dependencies.publish(this.latest)
  }

  /** Folds one pushed event; content publishes once per browser paint. */
  push(streamed: ConversationStreamEvent): void {
    if (streamed.sessionId !== this.sessionId) return
    // Lifecycle invalidation is published only after its durable write. Any
    // read already in flight therefore predates this push and must lose.
    if (streamed.invalidation === 'mailbox') this.revision += 1
    // A rewind carries no live Run content. Its durable snapshot is the whole
    // answer; folding it as a Run event would briefly invent activity for the
    // old Run it names.
    if (streamed.event.type === 'rewound') {
      if (streamed.invalidation === 'mailbox') this.invalidateDurableRead()
      return
    }
    if (streamed.event.type === 'started') this.failureSummary = null
    if (streamed.event.type === 'failed') this.failureSummary = streamed.event.summary
    if (streamed.event.type === 'assistant-message') {
      const messageId = streamed.event.id
      this.streamed = this.streamed.filter(
        (existing) =>
          existing.runId !== streamed.runId ||
          existing.event.type !== 'assistant-message' ||
          existing.event.id !== messageId
      )
    }
    this.streamed.push(streamed)
    if (
      this.latest !== null &&
      streamed.journalPosition !== null &&
      streamed.journalPosition <= this.latest.conversation.journalPosition
    ) {
      this.streamed.pop()
      this.reconcileLive(this.latest.conversation)
      this.publishCurrent()
      if (streamed.invalidation === 'mailbox') this.invalidateDurableRead()
      return
    }
    const durableFileChanges =
      this.latest?.conversation.entries.filter(
        (entry) => entry.kind === 'file-change' && entry.runId === streamed.runId
      ).length ?? 0
    this.pendingLive = applyLiveEvent(this.pendingLive ?? this.live, streamed, durableFileChanges)
    if (this.paintHandle === null) {
      const requestPaint =
        this.dependencies.requestPaint ??
        ((callback: (time: number) => void): number => {
          callback(0)
          return 0
        })
      this.paintHandle = requestPaint(() => {
        this.paintHandle = null
        this.live = this.pendingLive
        this.pendingLive = null
        this.publishCurrent()
      })
    }
    if (streamed.invalidation === 'mailbox') this.invalidateDurableRead()
  }

  dispose(): void {
    if (this.paintHandle !== null) {
      const cancelPaint = this.dependencies.cancelPaint ?? (() => undefined)
      cancelPaint(this.paintHandle)
      this.paintHandle = null
    }
    this.cancelPendingRefresh()
  }

  private async drain(): Promise<void> {
    while (this.completed < this.requested) {
      const requestedThrough = this.requested
      const revision = this.revision
      try {
        const conversation = await this.dependencies.readConversation()
        if (revision !== this.revision) {
          this.completed = requestedThrough
          continue
        }

        let runs = this.latest?.runs ?? []
        if (
          this.runsForActiveRun === RUN_HISTORY_NOT_READ ||
          this.runsForActiveRun !== conversation.activeRunId
        ) {
          runs = await this.dependencies.readRuns()
          if (revision !== this.revision) {
            this.completed = requestedThrough
            continue
          }
          this.runsForActiveRun = conversation.activeRunId
        }

        this.reconcileLive(conversation)
        this.latest = {
          conversation,
          runs,
          live: this.live,
          failureSummary: this.failureSummary
        }
        this.dependencies.publish(this.latest)
      } catch {
        if (revision === this.revision) this.dependencies.fail?.()
      }
      this.completed = requestedThrough
    }
  }

  private publishCurrent(): void {
    if (this.latest === null) return
    this.latest = {
      ...this.latest,
      live: this.live,
      failureSummary: this.failureSummary
    }
    this.dependencies.publish(this.latest)
  }

  private reconcileLive(conversation: ConversationSnapshot): void {
    const activeRunId = conversation.activeRunId
    this.streamed = this.streamed.filter(
      (streamed) =>
        (streamed.journalPosition === null ||
          streamed.journalPosition > conversation.journalPosition) &&
        activeRunId !== null &&
        streamed.runId === activeRunId
    )
    const durableFileChanges = conversation.entries.filter(
      (entry) => entry.kind === 'file-change' && entry.runId === activeRunId
    ).length
    this.live = this.streamed.reduce<LiveRun | null>(
      (live, streamed) => applyLiveEvent(live, streamed, durableFileChanges),
      null
    )
    if (this.paintHandle !== null) this.pendingLive = this.live
  }

  private invalidateDurableRead(): void {
    this.cancelPendingRefresh()
    const scheduleRefresh = this.dependencies.scheduleRefresh ?? setTimeout
    this.freshnessTimer = scheduleRefresh(() => {
      this.freshnessTimer = null
      void this.requestRefresh()
    }, 200)
  }

  private cancelPendingRefresh(): void {
    if (this.freshnessTimer === null) return
    const cancelRefresh =
      this.dependencies.cancelRefresh ??
      ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    cancelRefresh(this.freshnessTimer)
    this.freshnessTimer = null
  }
}

function fromEntry(entry: SubagentEntry): FleetMember {
  return {
    dispatchId: entry.dispatchId,
    name: entry.name,
    role: entry.role,
    brief: entry.brief,
    status: entry.status,
    activity: entry.activity,
    result: entry.result,
    steps: entry.steps,
    startedAt: entry.startedAt,
    durationMs: entry.durationMs
  }
}

/**
 * One Run's fleet, from the two places its subagents arrive.
 *
 * The durable entry is the record — it carries when the subagent was
 * dispatched, and it survives the Run. The live event is what the Harness said
 * a moment ago, ahead of the durable read. Neither is enough alone: a dock
 * drawn from the record lags a working fleet by a refresh, and one drawn from
 * the stream forgets everything the moment the Session is reopened. So the
 * live report wins on everything it states, and the record keeps what only it
 * knows — when the subagent started, and anything the newest report has
 * stopped mentioning.
 */
export function fleetOf(
  entries: ConversationEntry[],
  live: LiveRun | null,
  runId: string
): FleetMember[] {
  const fleet = new Map<string, FleetMember>()
  for (const entry of entries) {
    if (entry.kind !== 'subagent' || entry.runId !== runId) continue
    fleet.set(entry.dispatchId, fromEntry(entry))
  }
  if (live?.runId === runId) {
    for (const reported of live.subagents) {
      const durable = fleet.get(reported.id)
      fleet.set(reported.id, {
        dispatchId: reported.id,
        name: reported.name,
        role: reported.role ?? durable?.role ?? null,
        brief: reported.brief ?? durable?.brief ?? null,
        status: reported.status,
        activity: reported.activity ?? durable?.activity ?? null,
        result: reported.result ?? durable?.result ?? null,
        steps: reported.steps ?? durable?.steps ?? null,
        startedAt: durable?.startedAt ?? null,
        durationMs: reported.durationMs ?? durable?.durationMs ?? null
      })
    }
  }
  return [...fleet.values()]
}

/**
 * The Plan a Run is working through: what the stream last said if it is still
 * running, and what the journal kept otherwise.
 *
 * The live report simply wins where there is one. Unlike a subagent, a Plan
 * has no field the record knows and the report does not — both carry the whole
 * list — so there is nothing to merge, and merging would only risk showing a
 * step from one snapshot beside a step from another.
 */
export function planOf(
  entries: ConversationEntry[],
  live: LiveRun | null,
  runId: string
): { explanation: string | null; steps: PlanStep[] } | null {
  if (live?.runId === runId && live.plan !== null) return live.plan
  const durable = entries.find((entry) => entry.kind === 'plan' && entry.runId === runId)
  if (durable?.kind !== 'plan' || durable.steps.length === 0) return null
  return { explanation: durable.explanation, steps: durable.steps }
}

function emptyLiveRun(runId: string): LiveRun {
  return {
    runId,
    messages: [],
    changes: [],
    fileChangeOrdinal: 0,
    commands: [],
    subagents: [],
    plan: null,
    suggestedResponses: []
  }
}

/** The single interpretation point for live Conversation events. */
function applyLiveEvent(
  current: LiveRun | null,
  streamed: ConversationStreamEvent,
  durableFileChanges: number
): LiveRun {
  const { event, runId } = streamed
  const base = current?.runId === runId ? current : emptyLiveRun(runId)
  if (event.type === 'choices') return { ...base, suggestedResponses: event.options }
  if (event.type === 'file-change') {
    const ordinal = Math.max(durableFileChanges, base.fileChangeOrdinal) + 1
    const lines = event.hunks.flatMap((hunk) => hunk.lines)
    return {
      ...base,
      fileChangeOrdinal: ordinal,
      changes: [
        ...base.changes,
        {
          kind: 'file-change',
          id: `file-change:${runId}:${String(ordinal)}`,
          at: new Date().toISOString(),
          runId,
          path: event.path,
          hunks: event.hunks,
          changeKind: event.changeKind ?? 'changed',
          added: lines.filter((line) => line.startsWith('+')).length,
          removed: lines.filter((line) => line.startsWith('-')).length,
          shortened: false,
          source: 'harness'
        }
      ]
    }
  }
  if (event.type === 'plan') {
    // The whole Plan travels every time, so the newest one replaces the one
    // before it rather than being merged into it.
    const { type: _type, ...plan } = event
    return { ...base, plan }
  }
  if (event.type === 'subagent') {
    // Keyed by the Harness's own dispatch id, exactly as the durable entry is:
    // a subagent that reported twice is one subagent.
    const { type: _type, ...subagent } = event
    const known = base.subagents.some((entry) => entry.id === event.id)
    return {
      ...base,
      subagents: known
        ? base.subagents.map((entry) => (entry.id === event.id ? subagent : entry))
        : [...base.subagents, subagent]
    }
  }
  if (event.type === 'command') {
    const known = base.commands.some((entry) => entry.id === event.id)
    return {
      ...base,
      commands: known
        ? base.commands.map((entry) => (entry.id === event.id ? { ...event } : entry))
        : [...base.commands, { ...event }]
    }
  }
  if (event.type !== 'assistant-message') return base
  const known = base.messages.some((message) => message.id === event.id)
  return {
    ...base,
    messages: known
      ? base.messages.map((message) =>
          message.id === event.id ? { ...message, text: event.text } : message
        )
      : [...base.messages, { id: event.id, text: event.text }]
  }
}
