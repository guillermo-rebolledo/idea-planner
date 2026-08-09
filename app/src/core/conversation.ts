import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect, Ref } from 'effect'
import { CoreError } from '@shared/contract'
import {
  MAX_APPROVAL_DETAIL,
  addUsage,
  conversationEntrySchema,
  countDiffLines,
  emptyUsage,
  assistantMessageId,
  hasPlainOptions,
  redactCredentials,
  editQueuedSubmissionInputSchema,
  enqueueQueuedSubmissionInputSchema,
  moveQueuedSubmissionInputSchema,
  queuedSubmissionIdentitySchema,
  queuedSubmissionEntrySchema,
  queueOutcomeEntrySchema,
  isActiveQueuedSubmission,
  recordAppActionInputSchema,
  recordCompactionInputSchema,
  setConversationQueuePausedInputSchema,
  MAX_COMPACTION_SUMMARY,
  type CompactionPlan,
  type RecordAppActionInput,
  type RecordCompactionInput,
  type ChangedFile,
  type DiffHunk,
  submitConversationMessageInputSchema,
  type ConversationEntry,
  type ConversationRecovery,
  type ConversationSnapshot,
  type CheckoutChange,
  type HarnessEvent,
  type CodexLaunch,
  type HarnessFailureCategory,
  type HarnessStream,
  type HarnessUsage,
  type EditQueuedSubmissionInput,
  type EnqueueQueuedSubmissionInput,
  type MoveQueuedSubmissionInput,
  type QueuedSubmission,
  type QueuedSubmissionIdentity,
  type QueuedSubmissionDispositionObservation,
  type QueuedSubmissionLaunchResult,
  type QueueOutcome,
  type SetConversationQueuePausedInput,
  type SuggestedResponse
} from '@shared/conversation'
import { reviewAttachmentsRefusal, type ReviewAttachment } from '@shared/review-attachment'
import { isRestored } from '@shared/run-undo'
import type { HarnessId } from '@shared/readiness'
import type { RunActivityKind, SkillName } from '@shared/run'
import { createCodexAdapter, type HarnessAdapter } from './harness/codex'
import { parseGitPatch } from './harness/diff'
import {
  advance,
  deriveState,
  journalSize,
  readSessionState,
  stateFile,
  writeState,
  type SessionState
} from './session-state'
import { createClaudeAdapter } from './harness/claude'

/**
 * The Session's one permanent Conversation, inside the app-owned Session
 * directory (ADR 0002). Nothing about it is written into the Project.
 *
 * This module also owns the Core-side protocol Adapters that normalize raw
 * Harness frames into product events. Main's Harness Adapters own native
 * process facts; protocol normalization remains beside this durable journal.
 * Durable truth is append-only JSONL: later entries with the same id supersede
 * earlier ones, so a coalesced streaming checkpoint costs one append and an
 * interrupted Run still reads back as labelled partial content. Everything
 * presented is projected from that journal in memory.
 */

const JOURNAL = 'conversation.jsonl'

/** How much of one file's diff is worth keeping in the Conversation. */
const MAX_DIFF_LINES = 400

/** How much of one command's output is worth keeping. */
const MAX_OUTPUT_CHARACTERS = 16_000

/** A command line, bounded, and honest about it when it is cut. */
function describeCommand(command: string): string {
  const redacted = redactCredentials(command)
  return redacted.length <= 2_000 ? redacted : `${redacted.slice(0, 2_000)}…`
}

/**
 * What a command printed, as the Conversation should hold it: redacted,
 * because a command prints whatever it prints, and bounded, because a build
 * log would otherwise displace everything around it. The end is kept rather
 * than the start — a failure says why on its last lines.
 */
function describeOutput(output: string): string {
  const redacted = redactCredentials(output)
  if (redacted.length <= MAX_OUTPUT_CHARACTERS) return redacted
  const kept = redacted.slice(-MAX_OUTPUT_CHARACTERS)
  return `… earlier output not kept …\n${kept}`
}

/**
 * A file change as the Conversation should hold it: relative to the Checkout
 * so no path leaves the person's machine, redacted because a diff carries
 * whatever the Harness has just written, and bounded because a generated file
 * can be enormous.
 */
function describeChange(
  path: string,
  hunks: DiffHunk[],
  checkout: string
): { path: string; hunks: DiffHunk[]; added: number; removed: number; shortened: boolean } {
  const relative = path.startsWith(`${checkout}/`) ? path.slice(checkout.length + 1) : path
  let budget = MAX_DIFF_LINES
  const kept: DiffHunk[] = []
  for (const hunk of hunks) {
    if (budget <= 0) break
    const lines = hunk.lines.slice(0, budget).map((line) => redactCredentials(line))
    budget -= lines.length
    kept.push({ ...hunk, lines })
  }
  const shown = kept.reduce((total, hunk) => total + hunk.lines.length, 0)
  return {
    path: redactCredentials(relative),
    // A change with nothing left to show is still a change that happened.
    hunks: kept.length > 0 ? kept : [{ ...hunks[0], lines: [] } as DiffHunk],
    // Said out loud, because a diff that stops early looks exactly like one
    // that was that short.
    shortened: shown < hunks.reduce((total, hunk) => total + hunk.lines.length, 0),
    // Counted from the whole change, not from what survived the budget: a
    // clipped diff that also reports a smaller change is a diff that lies
    // twice.
    ...countDiffLines(hunks)
  }
}
/** Streaming deltas persist at most this often; every other change persists at once. */
const CHECKPOINT_INTERVAL_MS = 250

interface ConversationOptions {
  /** The app-owned directory holding one Session's journal and Runs. */
  directoryFor: (sessionId: string) => Effect.Effect<string, CoreError>
  /** The Session's Checkout, so file paths can be kept relative to it. */
  checkoutFor: (sessionId: string) => Effect.Effect<string, CoreError>
  clock: Effect.Effect<Date>
}

export interface BeginConversationRunInput {
  sessionId: string
  runId: string
  submissionId: string
  harness?: HarnessId
  skill?: SkillName
  model?: string
  restorationNote?: boolean
  /** The native mode this app asked for, to compare with what the Harness reports. */
  askedPermissionMode?: string
}

export interface ApplyHarnessEventInput {
  sessionId: string
  runId: string
  event: HarnessEvent
}

export interface IngestHarnessOutputInput {
  sessionId: string
  runId: string
  harness: HarnessId
  chunk: string
}

export interface OpenHarnessInput {
  runId: string
  harness: HarnessId
  /** Present for a Harness that is answered rather than only read. */
  launch?: CodexLaunch
}

export interface AnswerHarnessInput {
  runId: string
  approvalId: string
  allow: boolean
  remember: boolean
}

interface FinalizeRunInput {
  sessionId: string
  runId: string
  outcome: 'completed' | 'stopped' | 'failed' | 'policy-violation' | 'supervision-failed'
  category: HarnessFailureCategory | null
  summary: string
  queuePaused?: boolean
  transitionFingerprint?: string
  checkoutObservation?: 'observed' | 'unavailable'
  queueDisposition?: 'advance' | 'pause'
  terminalActivityKind?: RunActivityKind
  checkoutChanges?: CheckoutChange[]
}

export interface ConversationEffects {
  get(sessionId: string): Effect.Effect<ConversationSnapshot, CoreError>
  /**
   * What the Session is doing, without reading its whole Conversation back.
   * The projection behind it is checked against the journal on every read, so
   * this can never answer with something the Conversation did not say.
   */
  state(sessionId: string): Effect.Effect<SessionState, CoreError>
  submit(input: unknown): Effect.Effect<ConversationSnapshot, CoreError>
  enqueue(input: EnqueueQueuedSubmissionInput): Effect.Effect<ConversationSnapshot, CoreError>
  editQueued(input: EditQueuedSubmissionInput): Effect.Effect<ConversationSnapshot, CoreError>
  moveQueued(input: MoveQueuedSubmissionInput): Effect.Effect<ConversationSnapshot, CoreError>
  prioritizeQueued(input: QueuedSubmissionIdentity): Effect.Effect<ConversationSnapshot, CoreError>
  cancelQueued(input: QueuedSubmissionIdentity): Effect.Effect<ConversationSnapshot, CoreError>
  setQueuePaused(
    input: SetConversationQueuePausedInput
  ): Effect.Effect<ConversationSnapshot, CoreError>
  claimQueued(sessionId: string): Effect.Effect<QueuedSubmission | null, CoreError>
  observeQueuedLaunch(
    input: QueuedSubmissionDispositionObservation
  ): Effect.Effect<QueuedSubmissionLaunchResult, CoreError>
  begin(input: BeginConversationRunInput): Effect.Effect<ConversationSnapshot, CoreError>
  apply(input: ApplyHarnessEventInput): Effect.Effect<number, CoreError>
  /**
   * Prepares the Adapter for a Run and returns whatever the Harness must be
   * told before it will say anything. Codex speaks only when spoken to.
   */
  open(input: OpenHarnessInput): Effect.Effect<HarnessStream, CoreError>
  /**
   * Answers an Approval Request the Harness raised in-band, and reports
   * whether its Adapter had one to answer. A Harness whose approvals arrive
   * elsewhere always says no, and the caller answers them where they arrived.
   */
  answer(
    input: AnswerHarnessInput
  ): Effect.Effect<{ answered: boolean; outgoing: string[] }, CoreError>
  /** Asks the Harness to end the turn it is running, if it can be asked. */
  interrupt(runId: string): Effect.Effect<string[], CoreError>
  /** Parses one raw Harness chunk and applies everything it completed. */
  ingest(input: IngestHarnessOutputInput): Effect.Effect<HarnessStream, CoreError>
  /** Records changes found by comparing the Checkout, which nobody reported. */
  finalize(input: FinalizeRunInput): Effect.Effect<ConversationSnapshot, CoreError>
  /** Appends what the app itself did to the Checkout, without rewriting a Run. */
  recordAppAction(input: RecordAppActionInput): Effect.Effect<ConversationSnapshot, CoreError>
  /**
   * What a compaction of this Session would have to be written from: where the
   * untouched tail begins, the summary already being carried, and the turns
   * before the tail that the next summary has to account for.
   *
   * It decides nothing about how the summary is produced. Core owns what a
   * compaction means; only Main can speak to a Harness.
   */
  compactionPlan(sessionId: string): Effect.Effect<CompactionPlan, CoreError>
  /** Records that the agent's memory of the turns before the tail is now a summary. */
  compact(input: RecordCompactionInput): Effect.Effect<ConversationSnapshot, CoreError>
}

/**
 * One assistant message a Run is producing, rebuilt from the journal after a
 * crash. A Run may produce several, so each is tracked under the Harness's
 * own item id.
 */
interface StreamState {
  runId: string
  itemId: string
  messageId: string
  text: string
  authoritative: boolean
  suggestedResponses: SuggestedResponse[]
  checkpointedAt: number
}

export function createConversationEffects(options: ConversationOptions): ConversationEffects {
  // Per ADR 0001 mutable Core state lives in Ref; entries are replaced rather
  // than mutated so a checkpoint always writes a consistent message.
  const streams = Effect.runSync(Ref.make<ReadonlyMap<string, StreamState>>(new Map()))
  const adapters = Effect.runSync(Ref.make<ReadonlyMap<string, HarnessAdapter>>(new Map()))
  // How much of a Run's protocol this app could not model. A Run that says
  // nothing else is the only evidence the person will ever get.
  const drift = Effect.runSync(Ref.make<ReadonlyMap<string, number>>(new Map()))
  // Intentionally process-local. A new Core starts every non-empty queue paused,
  // even when the last durable transition before shutdown was Resume.
  const queuePauseOverrides = Effect.runSync(Ref.make<ReadonlyMap<string, boolean>>(new Map()))
  // One writer at a time: a streaming checkpoint must never interleave with a
  // submission or a finalize on the same journal.
  const writeLock = Effect.runSync(Effect.makeSemaphore(1))

  const sessionDirectory = options.directoryFor

  const readJournal = (
    sessionDir: string
  ): Effect.Effect<{ entries: ConversationEntry[]; journalPosition: number }, CoreError> =>
    Effect.tryPromise({
      try: async () => {
        const raw = await readFile(join(sessionDir, JOURNAL)).catch(() => Buffer.alloc(0))
        const byId = new Map<string, ConversationEntry>()
        for (const line of raw.toString('utf8').split('\n')) {
          if (!line.trim()) continue
          let parsed
          try {
            parsed = conversationEntrySchema.safeParse(JSON.parse(line))
          } catch {
            // A torn final line from an interrupted append is not a reason to
            // lose the Conversation before it.
            continue
          }
          if (parsed.success) byId.set(parsed.data.id, parsed.data)
        }
        return { entries: [...byId.values()], journalPosition: raw.byteLength }
      },
      catch: () => new CoreError('IO_ERROR', 'The Conversation history could not be read')
    })

  const readEntries = (sessionDir: string): Effect.Effect<ConversationEntry[], CoreError> =>
    readJournal(sessionDir).pipe(Effect.map(({ entries }) => entries))

  const appendMany = (
    sessionDir: string,
    entries: ConversationEntry[]
  ): Effect.Effect<void, CoreError> =>
    Effect.gen(function* () {
      const journal = join(sessionDir, JOURNAL)
      const text = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
      // What the projection has to agree with to be usable: the journal as it
      // is *before* this entry. Read first, so what follows is one fold over
      // one entry rather than a reading of everything that ever happened.
      const before = yield* journalSize(journal)
      const known = yield* stateAsOf(sessionDir, before)
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(sessionDir, { recursive: true, mode: 0o700 })
          await appendFile(journal, text, 'utf8')
        },
        catch: () => new CoreError('IO_ERROR', 'The Conversation could not be saved')
      })
      // The journal is written first and the projection after it, so a crash
      // between them leaves a projection that is behind rather than ahead.
      // Being behind is seen and repaired; being ahead would be a status the
      // Conversation never said (ticket 12f).
      yield* writeState(sessionDir, {
        ...entries.reduce(advance, known),
        journalBytes: before + Buffer.byteLength(text, 'utf8')
      }).pipe(Effect.catchAll(() => Effect.void))
    })

  const append = (sessionDir: string, entry: ConversationEntry): Effect.Effect<void, CoreError> =>
    appendMany(sessionDir, [entry])

  /**
   * What this Session was doing when its journal was `bytes` long, from the
   * projection if that is what the projection describes and from the journal
   * itself if it is not. A projection that has fallen behind is repaired
   * rather than trusted: the Conversation is what happened, and this only
   * says so faster.
   */
  const stateAsOf = (sessionDir: string, bytes: number): Effect.Effect<SessionState, CoreError> =>
    Effect.gen(function* () {
      const written = yield* Effect.promise(() =>
        readFile(stateFile(sessionDir), 'utf8').then(
          (text) => readSessionState(text),
          () => null
        )
      )
      if (written?.journalBytes === bytes) return written
      const rebuilt = deriveState(yield* readEntries(sessionDir), bytes)
      yield* writeState(sessionDir, rebuilt).pipe(Effect.catchAll(() => Effect.void))
      return rebuilt
    })

  const readState = (sessionDir: string): Effect.Effect<SessionState, CoreError> =>
    journalSize(join(sessionDir, JOURNAL)).pipe(
      Effect.flatMap((bytes) => stateAsOf(sessionDir, bytes))
    )

  /**
   * How many durable steps of one kind a Run has taken: from the projection
   * for the active Run — the case every step of a live Run asks — and from
   * the journal for any other, which only a late event for an already-ended
   * Run ever is.
   */
  const stepCount = (
    sessionDir: string,
    runId: string,
    kind: 'read' | 'file-change'
  ): Effect.Effect<number, CoreError> =>
    Effect.gen(function* () {
      const state = yield* readState(sessionDir)
      if (state.activeRunId === runId) return state.runSteps[kind]
      return (yield* readEntries(sessionDir)).filter(
        (entry) => entry.kind === kind && entry.runId === runId
      ).length
    })

  /**
   * When one Run's command was seen starting, if it was: from the projection
   * for the active Run, and from the journal for any other — the projection's
   * running commands belong to the active Run alone, and a finish arriving
   * late must not lose its measurement over that.
   */
  const commandStartedAt = (
    sessionDir: string,
    runId: string,
    entryId: string
  ): Effect.Effect<string | undefined, CoreError> =>
    Effect.gen(function* () {
      const state = yield* readState(sessionDir)
      if (state.activeRunId === runId) return state.runningCommands[entryId]
      const running = (yield* readEntries(sessionDir)).find(
        (entry) => entry.kind === 'command' && entry.id === entryId && entry.running
      )
      return running?.at
    })

  /**
   * When a subagent was dispatched, from the projection for the active Run and
   * from the journal for any other. Read the same way a command's start is,
   * and for the same reason: a subagent reports itself many times over, and
   * every report would otherwise start its clock again.
   */
  const subagentStartedAt = (
    sessionDir: string,
    runId: string,
    entryId: string
  ): Effect.Effect<string | undefined, CoreError> =>
    Effect.gen(function* () {
      const state = yield* readState(sessionDir)
      if (state.activeRunId === runId) return state.subagentDispatchedAt[entryId]
      const dispatched = (yield* readEntries(sessionDir)).find(
        (entry) => entry.kind === 'subagent' && entry.id === entryId
      )
      return dispatched?.kind === 'subagent' ? dispatched.startedAt : undefined
    })

  const snapshot = (
    sessionId: string,
    sessionDir: string
  ): Effect.Effect<ConversationSnapshot, CoreError> =>
    Effect.all([readJournal(sessionDir), Ref.get(queuePauseOverrides)]).pipe(
      Effect.map(([journal, overrides]) =>
        summarize(sessionId, journal.entries, journal.journalPosition, overrides.get(sessionId))
      )
    )

  const summarizeCurrent = (
    sessionId: string,
    sessionDir: string,
    entries: ConversationEntry[],
    queuePausedOverride?: boolean
  ): Effect.Effect<ConversationSnapshot> =>
    journalSize(join(sessionDir, JOURNAL)).pipe(
      Effect.map((journalPosition) =>
        summarize(sessionId, entries, journalPosition, queuePausedOverride)
      )
    )

  const state = (sessionId: string): Effect.Effect<SessionState, CoreError> =>
    sessionDirectory(sessionId).pipe(Effect.flatMap(readState))

  const get = (sessionId: string): Effect.Effect<ConversationSnapshot, CoreError> =>
    sessionDirectory(sessionId).pipe(
      Effect.flatMap((sessionDir) => snapshot(sessionId, sessionDir))
    )

  const submit = (rawInput: unknown): Effect.Effect<ConversationSnapshot, CoreError> =>
    Effect.gen(function* () {
      const parsed = submitConversationMessageInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid message')
        )
      }
      const input = parsed.data
      // Bounds are answered before anything is committed: a selection cut
      // after the send is one nobody agreed to.
      const refusal = reviewAttachmentsRefusal(input.reviewAttachments)
      if (refusal) return yield* Effect.fail(new CoreError('INVALID_INPUT', refusal))
      const sessionDir = yield* sessionDirectory(input.sessionId)
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const entries = yield* readEntries(sessionDir)
          const id = `user:${input.submissionId}`
          const existing = entries.find((entry) => entry.id === id)
          if (existing) {
            // A resent submission is the same submission: never a second
            // message, and never a silently different one — including one
            // carrying different reviewed code under the same identity.
            if (
              existing.kind !== 'message' ||
              existing.text !== input.text ||
              !sameAttachments(existing.reviewAttachments, input.reviewAttachments)
            ) {
              return yield* Effect.fail(
                new CoreError(
                  'INVALID_INPUT',
                  'Submission identity was already used for different content'
                )
              )
            }
            const paused = (yield* Ref.get(queuePauseOverrides)).get(input.sessionId)
            return yield* summarizeCurrent(input.sessionId, sessionDir, entries, paused)
          }
          const at = (yield* options.clock).toISOString()
          const entry = conversationEntrySchema.parse({
            kind: 'message',
            id,
            at,
            runId: null,
            role: 'user',
            text: input.text,
            completeness: 'complete',
            source: input.source,
            submissionId: input.submissionId,
            reviewAttachments: input.reviewAttachments,
            suggestedResponses: [],
            plainOptions: false
          })
          yield* append(sessionDir, entry)
          const paused = (yield* Ref.get(queuePauseOverrides)).get(input.sessionId)
          return yield* summarizeCurrent(input.sessionId, sessionDir, [...entries, entry], paused)
        })
      )
    })

  const queuedEntry = (
    entries: ConversationEntry[],
    submissionId: string
  ): QueuedSubmission | undefined =>
    entries.find(
      (entry): entry is QueuedSubmission =>
        entry.kind === 'queued-submission' && entry.submissionId === submissionId
    )

  const queueOutcome = (
    type: QueueOutcome['type'],
    submissionId: string | null,
    at: string
  ): ConversationEntry =>
    queueOutcomeEntrySchema.parse({
      kind: 'queue-outcome',
      id: 'queue-outcome',
      at,
      type,
      submissionId
    })

  const queueSnapshot = (
    sessionId: string,
    sessionDir: string,
    entries: ConversationEntry[]
  ): Effect.Effect<ConversationSnapshot> =>
    Ref.get(queuePauseOverrides).pipe(
      Effect.flatMap((overrides) =>
        summarizeCurrent(sessionId, sessionDir, entries, overrides.get(sessionId))
      )
    )

  const enqueue = (
    rawInput: EnqueueQueuedSubmissionInput
  ): Effect.Effect<ConversationSnapshot, CoreError> =>
    Effect.gen(function* () {
      const parsed = enqueueQueuedSubmissionInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return yield* Effect.fail(
          new CoreError(
            'INVALID_INPUT',
            parsed.error.issues[0]?.message ?? 'Invalid queued message'
          )
        )
      }
      const input = parsed.data
      const refusal = reviewAttachmentsRefusal(input.reviewAttachments)
      if (refusal) return yield* Effect.fail(new CoreError('INVALID_INPUT', refusal))
      const sessionDir = yield* sessionDirectory(input.sessionId)
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const entries = yield* readEntries(sessionDir)
          const existing = queuedEntry(entries, input.submissionId)
          if (existing) {
            const same =
              existing.text === input.text &&
              existing.harness === input.harness &&
              existing.model === input.model &&
              existing.effort === input.effort &&
              existing.skill === (input.skill ?? null) &&
              existing.permissionMode === input.permissionMode &&
              existing.source === input.source &&
              sameAttachments(existing.reviewAttachments, input.reviewAttachments)
            if (!same) {
              return yield* Effect.fail(
                new CoreError(
                  'INVALID_INPUT',
                  'Submission identity was already used for different queued content'
                )
              )
            }
            return yield* queueSnapshot(input.sessionId, sessionDir, entries)
          }
          const active = entries.filter(
            (entry): entry is QueuedSubmission =>
              entry.kind === 'queued-submission' && isActiveQueuedSubmission(entry)
          )
          if (active.length >= 50) {
            return yield* Effect.fail(
              new CoreError('INVALID_INPUT', 'A Session may hold at most 50 queued submissions')
            )
          }
          const at = (yield* options.clock).toISOString()
          const pauseOverride = (yield* Ref.get(queuePauseOverrides)).get(input.sessionId)
          const entry = queuedSubmissionEntrySchema.parse({
            kind: 'queued-submission',
            id: `queued:${input.submissionId}`,
            at,
            submissionId: input.submissionId,
            text: input.text,
            source: input.source,
            harness: input.harness,
            model: input.model,
            effort: input.effort,
            skill: input.skill ?? null,
            permissionMode: input.permissionMode,
            reviewAttachments: input.reviewAttachments,
            status: 'pending',
            position: Math.max(-1, ...active.map((item) => item.position)) + 1
          })
          const additions: ConversationEntry[] = [
            entry,
            queueOutcome('enqueued', input.submissionId, at)
          ]
          if (pauseOverride === undefined) {
            additions.push(
              conversationEntrySchema.parse({
                kind: 'queue-state',
                id: 'queue-state',
                at,
                paused: false
              })
            )
            yield* Ref.update(queuePauseOverrides, (current) =>
              new Map(current).set(input.sessionId, false)
            )
          }
          yield* appendMany(sessionDir, additions)
          return yield* summarizeCurrent(
            input.sessionId,
            sessionDir,
            replaceEntries(entries, additions),
            pauseOverride ?? false
          )
        })
      )
    })

  const replaceQueued = <A>(
    rawInput: A,
    parse: (
      input: A
    ) =>
      | { success: true; data: QueuedSubmissionIdentity & Record<string, unknown> }
      | { success: false; error: { issues: { message: string }[] } },
    change: (
      item: QueuedSubmission,
      input: QueuedSubmissionIdentity & Record<string, unknown>,
      entries: ConversationEntry[]
    ) => ConversationEntry[],
    outcome: QueueOutcome['type'],
    allowedStatuses: QueuedSubmission['status'][] = ['pending'],
    claimedRequiresPaused = false,
    pauseAfterChange = false
  ): Effect.Effect<ConversationSnapshot, CoreError> =>
    Effect.gen(function* () {
      const parsed = parse(rawInput)
      if (!parsed.success) {
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid queue change')
        )
      }
      const input = parsed.data
      const sessionDir = yield* sessionDirectory(input.sessionId)
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const entries = yield* readEntries(sessionDir)
          const item = queuedEntry(entries, input.submissionId)
          const paused = (yield* Ref.get(queuePauseOverrides)).get(input.sessionId) ?? true
          if (
            !item ||
            !allowedStatuses.includes(item.status) ||
            (item.status === 'claimed' && claimedRequiresPaused && !paused)
          ) {
            return yield* Effect.fail(
              new CoreError('INVALID_INPUT', 'Queued Submission is not editable')
            )
          }
          const now = (yield* options.clock).toISOString()
          const replacements = change(item, input, entries).map((entry) => ({ ...entry, at: now }))
          const additions: ConversationEntry[] = [
            ...replacements,
            queueOutcome(outcome, input.submissionId, now)
          ]
          if (pauseAfterChange) {
            additions.push(
              conversationEntrySchema.parse({
                kind: 'queue-state',
                id: 'queue-state',
                at: now,
                paused: true
              })
            )
            yield* Ref.update(queuePauseOverrides, (current) =>
              new Map(current).set(input.sessionId, true)
            )
          }
          yield* appendMany(sessionDir, additions)
          return yield* summarizeCurrent(
            input.sessionId,
            sessionDir,
            replaceEntries(entries, additions),
            pauseAfterChange ? true : paused
          )
        })
      )
    })

  const editQueued = (
    input: EditQueuedSubmissionInput
  ): Effect.Effect<ConversationSnapshot, CoreError> =>
    replaceQueued(
      input,
      (value) => editQueuedSubmissionInputSchema.safeParse(value),
      (item, value, entries) => {
        const text = value['text'] as string
        const admitted = entries.find((entry) => entry.id === `user:${item.submissionId}`)
        return [
          { ...item, text, status: 'pending' as const },
          ...(admitted?.kind === 'message' && admitted.role === 'user'
            ? [{ ...admitted, text }]
            : [])
        ]
      },
      'edited',
      ['pending', 'claimed'],
      true,
      true
    )

  const moveQueued = (
    input: MoveQueuedSubmissionInput
  ): Effect.Effect<ConversationSnapshot, CoreError> =>
    replaceQueued(
      input,
      (value) => moveQueuedSubmissionInputSchema.safeParse(value),
      (item, value, entries) => {
        const active = entries
          .filter(
            (entry): entry is QueuedSubmission =>
              entry.kind === 'queued-submission' && isActiveQueuedSubmission(entry)
          )
          .sort((left, right) => left.position - right.position)
        const index = active.findIndex((entry) => entry.id === item.id)
        const offset = value['direction'] === 'earlier' ? -1 : 1
        const sibling = active[index + offset]
        return sibling
          ? [
              { ...item, position: sibling.position, status: 'pending' as const },
              { ...sibling, position: item.position }
            ]
          : [{ ...item, status: 'pending' as const }]
      },
      input.direction === 'earlier' ? 'moved-earlier' : 'moved-later',
      ['pending', 'claimed'],
      true
    )

  const prioritizeQueued = (
    rawInput: QueuedSubmissionIdentity
  ): Effect.Effect<ConversationSnapshot, CoreError> =>
    Effect.gen(function* () {
      const input = queuedSubmissionIdentitySchema.parse(rawInput)
      const sessionDir = yield* sessionDirectory(input.sessionId)
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const entries = yield* readEntries(sessionDir)
          const active = entries
            .filter(
              (entry): entry is QueuedSubmission =>
                entry.kind === 'queued-submission' && isActiveQueuedSubmission(entry)
            )
            .sort((left, right) => left.position - right.position)
          const index = active.findIndex((item) => item.submissionId === input.submissionId)
          const target = active[index]
          const paused = (yield* Ref.get(queuePauseOverrides)).get(input.sessionId) ?? true
          if (
            !target ||
            deriveState(entries, 0).activeRunId !== null ||
            (target.status === 'claimed' && !paused)
          ) {
            return yield* Effect.fail(
              new CoreError('INVALID_INPUT', 'Queued Submission cannot be sent now')
            )
          }
          const at = (yield* options.clock).toISOString()
          const replacements = active.slice(0, index).map((item) => ({
            ...item,
            at,
            position: item.position + 1
          }))
          replacements.push({
            ...target,
            at,
            position: active[0]?.position ?? 0,
            status: 'pending'
          })
          const additions: ConversationEntry[] = [
            ...replacements,
            conversationEntrySchema.parse({
              kind: 'queue-state',
              id: 'queue-state',
              at,
              paused: false
            }),
            queueOutcome('prioritized', input.submissionId, at)
          ]
          yield* appendMany(sessionDir, additions)
          yield* Ref.update(queuePauseOverrides, (current) =>
            new Map(current).set(input.sessionId, false)
          )
          return yield* summarizeCurrent(
            input.sessionId,
            sessionDir,
            replaceEntries(entries, additions),
            false
          )
        })
      )
    })

  const cancelQueued = (
    input: QueuedSubmissionIdentity
  ): Effect.Effect<ConversationSnapshot, CoreError> =>
    replaceQueued(
      input,
      (value) => queuedSubmissionIdentitySchema.safeParse(value),
      (item) => [{ ...item, status: 'cancelled' }],
      'cancelled',
      ['pending', 'claimed'],
      true
    )

  const setQueuePaused = (
    rawInput: SetConversationQueuePausedInput
  ): Effect.Effect<ConversationSnapshot, CoreError> =>
    Effect.gen(function* () {
      const input = setConversationQueuePausedInputSchema.parse(rawInput)
      const sessionDir = yield* sessionDirectory(input.sessionId)
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const entries = yield* readEntries(sessionDir)
          const entry = conversationEntrySchema.parse({
            kind: 'queue-state',
            id: 'queue-state',
            at: (yield* options.clock).toISOString(),
            paused: input.paused
          })
          const outcome = queueOutcome(input.paused ? 'paused' : 'resumed', null, entry.at)
          yield* appendMany(sessionDir, [entry, outcome])
          yield* Ref.update(queuePauseOverrides, (current) =>
            new Map(current).set(input.sessionId, input.paused)
          )
          return yield* summarizeCurrent(
            input.sessionId,
            sessionDir,
            replaceEntries(entries, [entry, outcome]),
            input.paused
          )
        })
      )
    })

  const claimQueued = (sessionId: string): Effect.Effect<QueuedSubmission | null, CoreError> =>
    Effect.gen(function* () {
      const sessionDir = yield* sessionDirectory(sessionId)
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const entries = yield* readEntries(sessionDir)
          const paused = (yield* Ref.get(queuePauseOverrides)).get(sessionId) ?? true
          if (paused || deriveState(entries, 0).activeRunId !== null) return null
          const claimed = entries.find(
            (entry): entry is QueuedSubmission =>
              entry.kind === 'queued-submission' && entry.status === 'claimed'
          )
          const pending = entries
            .filter(
              (entry): entry is QueuedSubmission =>
                entry.kind === 'queued-submission' && entry.status === 'pending'
            )
            .sort((left, right) => left.position - right.position)[0]
          const item = claimed ?? pending
          if (!item) return null
          const messageId = `user:${item.submissionId}`
          const message = entries.find((entry) => entry.id === messageId)
          if (
            message?.kind === 'message' &&
            (message.text !== item.text ||
              !sameAttachments(message.reviewAttachments, item.reviewAttachments))
          ) {
            return yield* Effect.fail(
              new CoreError(
                'INVALID_INPUT',
                'Submission identity was already used for different content'
              )
            )
          }
          const at = (yield* options.clock).toISOString()
          const replacement = { ...item, at, status: 'claimed' as const }
          const additions: ConversationEntry[] = [replacement]
          if (!message) {
            additions.push(
              conversationEntrySchema.parse({
                kind: 'message',
                id: messageId,
                at,
                runId: null,
                role: 'user',
                text: item.text,
                completeness: 'complete',
                source: item.source,
                submissionId: item.submissionId,
                // The admitted message carries exactly what was queued: the
                // snapshot travels with the message it belongs to.
                reviewAttachments: item.reviewAttachments,
                suggestedResponses: [],
                plainOptions: false
              })
            )
          }
          yield* appendMany(sessionDir, additions)
          return replacement
        })
      )
    })

  const observeQueuedLaunch = (
    input: QueuedSubmissionDispositionObservation
  ): Effect.Effect<QueuedSubmissionLaunchResult, CoreError> => {
    const transition =
      input.outcome === 'not-started'
        ? replaceQueued(
            input,
            (value) => queuedSubmissionIdentitySchema.safeParse(value),
            (item) => [{ ...item, status: 'pending' }],
            'launch-paused',
            ['claimed'],
            false,
            true
          )
        : replaceQueued(
            input,
            (value) => queuedSubmissionIdentitySchema.safeParse(value),
            (item) => [{ ...item, status: 'sent' }],
            input.outcome === 'reconciled' ? 'launch-reconciled' : 'launch-started',
            ['claimed']
          )
    return transition.pipe(Effect.map(() => ({ continueDraining: input.outcome === 'reconciled' })))
  }

  const begin = (
    input: BeginConversationRunInput
  ): Effect.Effect<ConversationSnapshot, CoreError> =>
    Effect.gen(function* () {
      const sessionDir = yield* sessionDirectory(input.sessionId)
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const entries = yield* readEntries(sessionDir)
          const existing = entries.find((entry) => entry.id === `boundary:${input.runId}:started`)
          if (existing) {
            if (
              existing.kind !== 'boundary' ||
              existing.submissionId !== input.submissionId ||
              existing.harness !== input.harness ||
              existing.skill !== input.skill ||
              existing.model !== input.model ||
              Boolean(existing.restorationNote) !== Boolean(input.restorationNote) ||
              existing.askedPermissionMode !== input.askedPermissionMode
            ) {
              return yield* Effect.fail(
                new CoreError(
                  'INVALID_INPUT',
                  'Run opening identity was reused with different data'
                )
              )
            }
            return yield* snapshot(input.sessionId, sessionDir)
          }
          const at = (yield* options.clock).toISOString()
          const entry = conversationEntrySchema.parse({
            kind: 'boundary',
            id: `boundary:${input.runId}:started`,
            at,
            runId: input.runId,
            boundary: 'run-started',
            summary: runBoundarySummary(input),
            ...(input.harness ? { harness: input.harness } : {}),
            ...(input.skill ? { skill: input.skill } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.restorationNote ? { restorationNote: true } : {}),
            ...(input.askedPermissionMode
              ? { askedPermissionMode: input.askedPermissionMode }
              : {}),
            submissionId: input.submissionId,
            recovery: null
          })
          yield* append(sessionDir, entry)
          yield* forgetRun(input.runId)
          return yield* snapshot(input.sessionId, sessionDir)
        })
      )
    })

  const putStream = (state: StreamState): Effect.Effect<StreamState> =>
    Ref.update(streams, (current) => new Map(current).set(state.messageId, state)).pipe(
      Effect.as(state)
    )

  const runStreams = (runId: string): Effect.Effect<StreamState[]> =>
    Ref.get(streams).pipe(
      Effect.map((current) => [...current.values()].filter((state) => state.runId === runId))
    )

  const forgetRun = (runId: string): Effect.Effect<void> =>
    Effect.all([
      Ref.update(
        streams,
        (current) => new Map([...current].filter(([, state]) => state.runId !== runId))
      ),
      Ref.update(adapters, (current) => without(current, runId)),
      Ref.update(drift, (current) => without(current, runId))
    ]).pipe(Effect.asVoid)

  const loadStream = (
    sessionDir: string,
    runId: string,
    itemId: string
  ): Effect.Effect<StreamState, CoreError> =>
    Effect.gen(function* () {
      const messageId = assistantMessageId(runId, itemId)
      const known = (yield* Ref.get(streams)).get(messageId)
      if (known) return known
      // Core may have restarted mid-Run: continue from the last checkpoint
      // rather than starting a second copy of the same message.
      const entries = yield* readEntries(sessionDir)
      const previous = entries.find((entry) => entry.id === messageId)
      return yield* putStream({
        runId,
        itemId,
        messageId,
        text: previous?.kind === 'message' ? previous.text : '',
        authoritative: false,
        suggestedResponses: previous?.kind === 'message' ? previous.suggestedResponses : [],
        checkpointedAt: 0
      })
    })

  const checkpoint = (
    sessionDir: string,
    state: StreamState,
    at: Date
  ): Effect.Effect<void, CoreError> =>
    Effect.gen(function* () {
      yield* putStream({ ...state, checkpointedAt: at.getTime() })
      yield* append(
        sessionDir,
        conversationEntrySchema.parse({
          kind: 'message',
          id: state.messageId,
          at: at.toISOString(),
          runId: state.runId,
          role: 'assistant',
          text: state.text,
          completeness: state.authoritative ? 'complete' : 'partial',
          source: 'harness',
          submissionId: null,
          suggestedResponses: state.suggestedResponses,
          plainOptions: state.suggestedResponses.length === 0 && hasPlainOptions(state.text)
        })
      )
    })

  const apply = (input: ApplyHarnessEventInput): Effect.Effect<number, CoreError> =>
    Effect.gen(function* () {
      const sessionDir = yield* sessionDirectory(input.sessionId)
      let journalPosition = 0
      yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          journalPosition = yield* journalSize(join(sessionDir, JOURNAL))
          const now = yield* options.clock
          const event = input.event
          switch (event.type) {
            case 'assistant-message': {
              const state = yield* loadStream(sessionDir, input.runId, event.id)
              const grown = yield* putStream({
                ...state,
                text: event.text,
                authoritative: event.complete
              })
              // A growing message persists on a coalescing interval; a
              // completed one is durable at once.
              if (
                event.complete ||
                now.getTime() - grown.checkpointedAt >= CHECKPOINT_INTERVAL_MS
              ) {
                yield* checkpoint(sessionDir, grown, now)
              }
              return
            }
            case 'choices': {
              // Choices answer the newest message of this Run, which is the
              // one the person is looking at.
              const open = yield* runStreams(input.runId)
              const target = open.at(-1)
              if (!target) return
              yield* checkpoint(
                sessionDir,
                yield* putStream({ ...target, suggestedResponses: event.options }),
                now
              )
              return
            }
            case 'usage':
              yield* append(
                sessionDir,
                conversationEntrySchema.parse({
                  kind: 'usage',
                  id: `usage:${input.runId}`,
                  at: now.toISOString(),
                  runId: input.runId,
                  usage: event.usage
                })
              )
              return
            case 'thread-ready': {
              const entries = yield* readEntries(sessionDir)
              const started = entries.find(
                (entry) =>
                  entry.kind === 'boundary' && entry.id === `boundary:${input.runId}:started`
              )
              if (started?.kind !== 'boundary' || started.harness !== event.harness) {
                return yield* Effect.fail(
                  new CoreError('INVALID_INPUT', 'Harness Thread does not belong to this Run')
                )
              }
              yield* append(
                sessionDir,
                conversationEntrySchema.parse({
                  kind: 'thread',
                  id: `thread:${started.harness}`,
                  at: now.toISOString(),
                  runId: input.runId,
                  harness: event.harness,
                  threadId: event.threadId,
                  model: event.model
                })
              )
              // Managed settings outrank what the app asked for, so the mode a
              // Run really ran under belongs in the Conversation rather than
              // only in an activity panel nobody has open. A Run whose record
              // says only what was chosen is one that lies about itself.
              const asked = started.askedPermissionMode
              if (event.permissionMode !== undefined && asked !== undefined) {
                if (event.permissionMode !== asked) {
                  yield* append(
                    sessionDir,
                    conversationEntrySchema.parse({
                      kind: 'boundary',
                      id: `boundary:${input.runId}:permission-mode`,
                      at: now.toISOString(),
                      runId: input.runId,
                      boundary: 'configuration',
                      summary: `This Run is running as ${event.permissionMode}, not the ${asked} this app asked for. Your machine's settings decide.`
                    })
                  )
                }
              }
              return
            }
            case 'context-compacted': {
              // The Harness compacted its own Thread. It still holds it, so
              // nothing about continuity changes and nothing is reseeded; the
              // Conversation records it so the person can see why the agent's
              // memory of the early turns is now a summary.
              const entries = yield* readEntries(sessionDir)
              const already = entries.filter(
                (entry) => entry.kind === 'boundary' && entry.boundary === 'compacted'
              ).length
              const tail = entries.findLast((entry) => entry.kind === 'message')
              yield* append(
                sessionDir,
                conversationEntrySchema.parse({
                  kind: 'boundary',
                  id: compactionEntryId(`native:${input.runId}:${String(already + 1)}`),
                  at: now.toISOString(),
                  runId: input.runId,
                  boundary: 'compacted',
                  summary: 'The Harness summarized its own memory of the turns before this',
                  compaction: {
                    summary:
                      redactCredentials(event.summary).slice(0, MAX_COMPACTION_SUMMARY) ||
                      'The Harness kept its own summary and did not say what is in it.',
                    // The newest turn is where what it still remembers whole
                    // begins, as far as this app can honestly say.
                    tailFromEntryId: tail?.id ?? `boundary:${input.runId}:started`,
                    native: true
                  }
                })
              )
              return
            }
            case 'unsupported':
              yield* Ref.update(drift, (current) =>
                new Map(current).set(input.runId, (current.get(input.runId) ?? 0) + 1)
              )
              return
            case 'command': {
              // Keyed by the Harness's own id for the call, so the command
              // recorded when it started is the one replaced when it finishes
              // rather than a second entry beside it. Reloading keeps the last
              // write for an id, which is the finished one.
              const id = `command:${input.runId}:${event.id}`
              // The Harness's own figure when it gives one; otherwise measured
              // between the start this Conversation saw — kept in the
              // projection, so a long Run does not re-read its whole journal
              // per step — and the finish. A command never seen starting
              // keeps an honest null.
              const startedAt = event.running
                ? undefined
                : yield* commandStartedAt(sessionDir, input.runId, id)
              const durationMs =
                event.durationMs ??
                (startedAt !== undefined
                  ? Math.max(0, now.getTime() - Date.parse(startedAt))
                  : null)
              const interrupted = event.interrupted ?? false
              yield* append(
                sessionDir,
                conversationEntrySchema.parse({
                  kind: 'command',
                  id,
                  at: now.toISOString(),
                  runId: input.runId,
                  command: describeCommand(event.command),
                  output: describeOutput(event.output),
                  failed: event.failed,
                  running: event.running,
                  interrupted,
                  // An interrupted command's result never arrived, so there is
                  // no finish to measure to.
                  durationMs: event.running || interrupted ? null : durationMs,
                  exitCode: event.exitCode
                })
              )
              return
            }
            case 'approval-request': {
              // Kept relative to the Checkout, as a file change already is: an
              // absolute path is this machine's, not this Conversation's.
              const checkout = yield* options.checkoutFor(input.sessionId)
              const relative = (value: string): string =>
                redactCredentials(value).replaceAll(checkout, '.')
              // Keyed by the Harness's own tool-use id, so the answer replaces
              // the request rather than landing beside it. Redacted and bounded
              // like any other durable content: a request carries whatever the
              // agent was about to run.
              yield* append(
                sessionDir,
                conversationEntrySchema.parse({
                  kind: 'approval',
                  id: approvalEntryId(input.runId, event.id),
                  at: now.toISOString(),
                  runId: input.runId,
                  requestId: event.id,
                  tool: event.tool,
                  summary: relative(event.summary).slice(0, 2_000),
                  detail: relative(event.detail).slice(0, MAX_APPROVAL_DETAIL),
                  proposedRule: event.proposedRule,
                  decision: null,
                  message: '',
                  remembered: false
                })
              )
              return
            }
            case 'approval-resolved': {
              const entries = yield* readEntries(sessionDir)
              const requested = entries.find(
                (entry) => entry.id === approvalEntryId(input.runId, event.id)
              )
              // An answer to a request this Conversation never saw, or a second
              // answer to one already settled, changes nothing: the first
              // answer is the one the agent was given.
              if (requested?.kind !== 'approval' || requested.decision !== null) return
              yield* append(sessionDir, {
                ...requested,
                at: now.toISOString(),
                decision: event.decision,
                message: redactCredentials(event.message).slice(0, 2_000),
                remembered: event.remembered
              })
              return
            }
            case 'file-change': {
              // What the Run did to the Checkout is part of what happened in
              // the Conversation, so it is durable rather than only streamed.
              //
              // The ordinal comes from the durable projection rather than from
              // memory: a restart part-way through a Run would otherwise start
              // again at one, and an id that repeats is an entry that
              // overwrites the change before it. The projection is checked
              // against the journal on every read, so this is the journal's
              // own count, answered without re-reading it per step.
              const ordinal = (yield* stepCount(sessionDir, input.runId, 'file-change')) + 1
              yield* append(
                sessionDir,
                conversationEntrySchema.parse({
                  kind: 'file-change',
                  id: `file-change:${input.runId}:${ordinal}`,
                  at: now.toISOString(),
                  runId: input.runId,
                  // Only what the Harness actually said: guessing a deletion
                  // from an empty diff would name something it never claimed.
                  changeKind: event.changeKind ?? 'changed',
                  ...describeChange(
                    event.path,
                    event.hunks,
                    yield* options.checkoutFor(input.sessionId)
                  )
                })
              )
              return
            }
            case 'tool': {
              // A tool call that read a file is a step of the Run's record; one
              // that names no file stays in the sanitized activity stream only.
              if (event.path === undefined) return
              const checkout = yield* options.checkoutFor(input.sessionId)
              const ordinal = (yield* stepCount(sessionDir, input.runId, 'read')) + 1
              yield* append(
                sessionDir,
                conversationEntrySchema.parse({
                  kind: 'read',
                  id: `read:${input.runId}:${ordinal}`,
                  at: now.toISOString(),
                  runId: input.runId,
                  // Kept relative to the Checkout: an absolute path is this
                  // machine's, not this Conversation's.
                  path: redactCredentials(event.path).replaceAll(checkout, '.').slice(0, 1_000)
                })
              )
              return
            }
            case 'subagent': {
              // Keyed by the Harness's own dispatch id, so every report of the
              // same subagent replaces the one before it rather than stacking
              // a row per progress line — the bargain a command already makes.
              const id = `subagent:${input.runId}:${event.id}`
              const startedAt =
                (yield* subagentStartedAt(sessionDir, input.runId, id)) ?? now.toISOString()
              const ended = event.status !== 'working'
              yield* append(
                sessionDir,
                conversationEntrySchema.parse({
                  kind: 'subagent',
                  id,
                  at: now.toISOString(),
                  startedAt,
                  runId: input.runId,
                  dispatchId: event.id,
                  name: event.name,
                  role: event.role ?? null,
                  brief: event.brief ?? null,
                  status: event.status,
                  activity: event.activity ?? null,
                  result: event.result ?? null,
                  steps: event.steps,
                  // The Harness's own figure when it gives one; otherwise
                  // measured from the dispatch this Conversation saw. A
                  // subagent still working is not yet a duration.
                  durationMs: ended
                    ? (event.durationMs ?? Math.max(0, now.getTime() - Date.parse(startedAt)))
                    : null
                })
              )
              return
            }
            case 'plan': {
              // One entry per Run, rewritten in place. Every rewrite is the
              // same Plan changing rather than a new one, and a row per
              // rewrite would make the Conversation a diff log of a list.
              const id = `plan:${input.runId}`
              const existing = (yield* readEntries(sessionDir)).find(
                (entry) => entry.kind === 'plan' && entry.id === id
              )
              yield* append(
                sessionDir,
                conversationEntrySchema.parse({
                  kind: 'plan',
                  id,
                  at: now.toISOString(),
                  // Kept from the first sighting: `at` moves with every
                  // rewrite, and a Plan written early and revised late would
                  // otherwise read as one the agent only just thought of.
                  startedAt: existing?.kind === 'plan' ? existing.startedAt : now.toISOString(),
                  runId: input.runId,
                  explanation: event.explanation,
                  steps: event.steps.map((step) => ({
                    step: redactCredentials(step.step),
                    activeForm:
                      step.activeForm === null ? null : redactCredentials(step.activeForm),
                    status: step.status
                  }))
                })
              )
              return
            }
            case 'reasoning':
            case 'retrying':
            case 'completed':
            case 'failed':
              // Reasoning summaries belong to the sanitized activity stream
              // only.
              return
          }
        })
      )
      return journalPosition
    })

  /**
   * Records what a Run changed that nobody reported. The Harness accounts for
   * its own edits; a shell command it ran accounts for nothing, so a Checkout
   * compared before and after the Run is the only way those are ever seen.
   *
   * A path the Harness already reported in this Run is left alone: it is the
   * same change, described better, and recording it twice would double what
   * the panel says the Run did.
   */
  const projectCheckoutChanges = (
    files: CheckoutChange[],
    existing: ConversationEntry[],
    runId: string,
    checkout: string,
    at: Date
  ): ConversationEntry[] => {
    const already = existing.filter(
      (entry) => entry.kind === 'file-change' && entry.runId === runId
    )
    const accounted = new Set(
      already.map((entry) => (entry.kind === 'file-change' ? entry.path : ''))
    )
    let ordinal = already.length
    return files.flatMap((file) => {
      const described = describeChange(file.path, parseGitPatch(file.diff), checkout)
      if (accounted.has(described.path)) return []
      accounted.add(described.path)
      ordinal += 1
      return [
        conversationEntrySchema.parse({
          kind: 'file-change',
          id: `file-change:${runId}:${ordinal}`,
          at: at.toISOString(),
          runId,
          source: 'checkout',
          changeKind: file.changeKind,
          ...described,
          shortened: described.shortened || file.diff === ''
        })
      ]
    })
  }

  const finalize = (input: FinalizeRunInput): Effect.Effect<ConversationSnapshot, CoreError> =>
    Effect.gen(function* () {
      const sessionDir = yield* sessionDirectory(input.sessionId)
      // Drain a truncated final protocol line before the lock is taken, so
      // the last thing the Harness said is part of what is finalized.
      const trailing = (yield* Ref.get(adapters)).get(input.runId)?.flush() ?? []
      for (const event of trailing) {
        yield* apply({ sessionId: input.sessionId, runId: input.runId, event })
      }
      const open = yield* runStreams(input.runId)
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* options.clock
          const before = yield* readEntries(sessionDir)
          const existingEnd = before.find((entry) => entry.id === `boundary:${input.runId}:ended`)
          if (existingEnd) {
            if (
              input.transitionFingerprint !== undefined &&
              (existingEnd.kind !== 'boundary' ||
                existingEnd.transitionFingerprint !== input.transitionFingerprint)
            ) {
              return yield* Effect.fail(
                new CoreError(
                  'INVALID_INPUT',
                  'Run completion identity was reused with different data'
                )
              )
            }
            if (input.checkoutChanges?.length) {
              const checkout = yield* options.checkoutFor(input.sessionId)
              const missing = projectCheckoutChanges(
                input.checkoutChanges,
                before,
                input.runId,
                checkout,
                now
              )
              if (missing.length) yield* appendMany(sessionDir, missing)
            }
            yield* forgetRun(input.runId)
            return yield* snapshot(input.sessionId, sessionDir)
          }
          // Every message this Run left open is settled the same way: complete
          // if the Run completed, otherwise labelled partial.
          for (const state of open) {
            if (!state.text) continue
            yield* checkpoint(
              sessionDir,
              { ...state, authoritative: state.authoritative || input.outcome === 'completed' },
              now
            )
          }
          const entries = yield* readEntries(sessionDir)
          // A request the Run ended before anyone answered is settled here, so
          // it cannot read back as one somebody allowed — and so the Session is
          // recoverable rather than stuck behind a request nothing can answer.
          for (const entry of entries) {
            if (entry.kind !== 'approval') continue
            if (entry.runId !== input.runId || entry.decision !== null) continue
            yield* append(sessionDir, {
              ...entry,
              at: now.toISOString(),
              decision: 'abandoned',
              message: 'The Run ended before this was answered'
            })
          }
          const started = entries.find(
            (entry) => entry.kind === 'boundary' && entry.id === `boundary:${input.runId}:started`
          )
          const submissionId = started?.kind === 'boundary' ? started.submissionId : null
          const producedAssistantText = open.some((state) => state.text !== '')
          const contacted =
            producedAssistantText ||
            entries.some((entry) => entry.kind === 'usage' && entry.runId === input.runId)
          const unmodelled = (yield* Ref.get(drift)).get(input.runId) ?? 0
          const terminal = conversationEntrySchema.parse({
            kind: 'boundary',
            id: `boundary:${input.runId}:ended`,
            at: now.toISOString(),
            runId: input.runId,
            boundary: BOUNDARY_FOR_OUTCOME[input.outcome],
            summary: redactCredentials(input.summary).slice(0, 500),
            submissionId,
            recovery: describeRecovery(input, {
              contacted,
              producedAssistantText,
              unmodelled,
              submissionId
            }),
            ...(input.transitionFingerprint
              ? { transitionFingerprint: input.transitionFingerprint }
              : {}),
            ...(input.checkoutObservation
              ? { checkoutObservation: input.checkoutObservation }
              : {}),
            ...(input.queueDisposition ? { queueDisposition: input.queueDisposition } : {}),
            terminalOutcome: input.outcome,
            ...(input.terminalActivityKind
              ? { terminalActivityKind: input.terminalActivityKind }
              : {})
          })
          const checkout = yield* options.checkoutFor(input.sessionId)
          const checkoutAdditions = projectCheckoutChanges(
            input.checkoutChanges ?? [],
            entries,
            input.runId,
            checkout,
            now
          )
          // The fingerprinted ending comes first. A torn append can therefore
          // only be repaired by a retry carrying the exact same transition.
          const additions: ConversationEntry[] = [terminal, ...checkoutAdditions]
          if (input.queuePaused !== undefined) {
            additions.push(
              conversationEntrySchema.parse({
                kind: 'queue-state',
                id: 'queue-state',
                at: now.toISOString(),
                paused: input.queuePaused
              })
            )
          }
          yield* appendMany(sessionDir, additions)
          if (input.queuePaused !== undefined) {
            yield* Ref.update(queuePauseOverrides, (current) =>
              new Map(current).set(input.sessionId, input.queuePaused ?? true)
            )
          }
          yield* forgetRun(input.runId)
          return yield* snapshot(input.sessionId, sessionDir)
        })
      )
    })

  /**
   * Writes down what the app did to the Checkout, at the person's request.
   *
   * It appends and only appends. The Run it names keeps its boundary, its
   * steps, and its diffs — undoing a Run is a second thing that happened, not
   * a reason to pretend the first one did not (ADR 0006).
   */
  const recordAppAction = (
    input: RecordAppActionInput
  ): Effect.Effect<ConversationSnapshot, CoreError> =>
    Effect.gen(function* () {
      const parsed = recordAppActionInputSchema.parse(input)
      const sessionDir = yield* sessionDirectory(parsed.sessionId)
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* options.clock
          yield* append(
            sessionDir,
            conversationEntrySchema.parse({
              kind: 'app-action',
              // The operation is the identity: a record whose append failed
              // and was retried lands once, under the same name.
              id: `app-action:${parsed.operationId}`,
              at: now.toISOString(),
              action: parsed.action,
              sourceRunId: parsed.sourceRunId,
              outcomes: parsed.outcomes,
              unlisted: parsed.unlisted
            })
          )
          return yield* snapshot(parsed.sessionId, sessionDir)
        })
      )
    })

  const compactionPlan = (sessionId: string): Effect.Effect<CompactionPlan, CoreError> =>
    Effect.gen(function* () {
      const sessionDir = yield* sessionDirectory(sessionId)
      const entries = yield* readEntries(sessionDir)
      // A Run stopped in front of an Approval Request is a Run mid-decision.
      // Replacing what the agent remembers while it waits would answer the
      // question for it, from a context it can no longer see.
      if (deriveState(entries, 0).openApprovals.length > 0) {
        return yield* Effect.fail(
          new CoreError(
            'INVALID_INPUT',
            'This Session is waiting on an Approval Request; answer it before compacting'
          )
        )
      }
      const opening = entries.findLast(
        (entry) => entry.kind === 'boundary' && entry.boundary === 'run-started'
      )
      if (opening?.kind !== 'boundary') {
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', 'This Session has no Harness Thread to compact yet')
        )
      }
      const tailFrom = tailStart(entries)
      if (tailFrom === null) {
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', 'There is not enough of this Conversation to compact yet')
        )
      }
      // Everything the summary in force already accounts for is left out of
      // the material: a second compaction rewrites that summary rather than
      // reading the same turns a second time.
      //
      // Only a summary this app wrote counts. What a Harness kept for itself
      // is inside that Harness and cannot be read, let alone rewritten — so
      // treating its record as a summary in force would drop every turn before
      // it from the material and carry a note about it forward in their place.
      const carried = entries.findLast(
        (entry) =>
          entry.kind === 'boundary' && entry.compaction !== undefined && !entry.compaction.native
      )
      const from = carried ? entries.indexOf(carried) + 1 : 0
      const material = entries.slice(from, entries.indexOf(tailFrom))
      // The Harness that has been answering. A summary of this Conversation is
      // not somewhere to switch agents, so the one that wrote it is asked.
      const answering = entries.findLast(
        (entry): entry is Extract<ConversationEntry, { kind: 'boundary' }> =>
          entry.kind === 'boundary' && entry.harness !== undefined
      )
      return {
        sessionId,
        runId: opening.runId,
        tailFromEntryId: tailFrom.id,
        previousSummary:
          carried?.kind === 'boundary' ? (carried.compaction?.summary ?? null) : null,
        material: transcript(material),
        harness: answering?.harness ?? null
      }
    })

  const compact = (
    rawInput: RecordCompactionInput
  ): Effect.Effect<ConversationSnapshot, CoreError> =>
    Effect.gen(function* () {
      const parsed = recordCompactionInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid compaction')
        )
      }
      const input = parsed.data
      const sessionDir = yield* sessionDirectory(input.sessionId)
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const entries = yield* readEntries(sessionDir)
          const id = compactionEntryId(input.operationId)
          if (entries.some((entry) => entry.id === id)) {
            return yield* snapshot(input.sessionId, sessionDir)
          }
          // A tail nobody can find is a tail nothing would be seeded with, and
          // the Conversation would say it had carried turns across that it had
          // not.
          if (!entries.some((entry) => entry.id === input.tailFromEntryId)) {
            return yield* Effect.fail(
              new CoreError(
                'INVALID_INPUT',
                'The untouched tail begins at no entry of this Session'
              )
            )
          }
          const entry = conversationEntrySchema.parse({
            kind: 'boundary',
            id,
            at: (yield* options.clock).toISOString(),
            runId: input.runId,
            boundary: 'compacted',
            summary: input.native
              ? 'The Harness summarized its own memory of the turns before this'
              : 'The turns before this are a summary from here on; nothing above has changed',
            compaction: {
              summary: redactCredentials(input.summary).slice(0, MAX_COMPACTION_SUMMARY),
              tailFromEntryId: input.tailFromEntryId,
              native: input.native
            }
          })
          yield* append(sessionDir, entry)
          return yield* snapshot(input.sessionId, sessionDir)
        })
      )
    })

  const adapterFor = (
    runId: string,
    harness: HarnessId,
    launch?: CodexLaunch
  ): Effect.Effect<HarnessAdapter, CoreError> =>
    Effect.gen(function* () {
      const known = (yield* Ref.get(adapters)).get(runId)
      if (known) return known
      const factory = ADAPTER_FACTORIES[harness]
      // Without an Adapter the Harness's answers could never reach the
      // Conversation, so this is refused rather than silently swallowed.
      if (!factory) {
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', `${harness} cannot stream into a Conversation`)
        )
      }
      const created = factory(launch)
      yield* Ref.update(adapters, (current) => new Map(current).set(runId, created))
      return created
    })

  const open = (input: OpenHarnessInput): Effect.Effect<HarnessStream, CoreError> =>
    adapterFor(input.runId, input.harness, input.launch).pipe(
      Effect.map((adapter) => ({ events: [], outgoing: adapter.takeOutgoing() }))
    )

  const answer = (
    input: AnswerHarnessInput
  ): Effect.Effect<{ answered: boolean; outgoing: string[] }, CoreError> =>
    Ref.get(adapters).pipe(
      Effect.map((current) => {
        const adapter = current.get(input.runId)
        if (!adapter) return { answered: false, outgoing: [] }
        const answered = adapter.answerApproval(input.approvalId, {
          allow: input.allow,
          remember: input.remember
        })
        return { answered, outgoing: adapter.takeOutgoing() }
      })
    )

  const interrupt = (runId: string): Effect.Effect<string[], CoreError> =>
    Ref.get(adapters).pipe(
      Effect.map((current) => {
        const adapter = current.get(runId)
        if (!adapter) return []
        adapter.interrupt()
        return adapter.takeOutgoing()
      })
    )

  const ingest = (input: IngestHarnessOutputInput): Effect.Effect<HarnessStream, CoreError> =>
    Effect.gen(function* () {
      const adapter = yield* adapterFor(input.runId, input.harness)
      const events = adapter.ingest(input.chunk)
      const journalPositions: number[] = []
      for (const event of events) {
        journalPositions.push(
          yield* apply({ sessionId: input.sessionId, runId: input.runId, event })
        )
      }
      return { events, outgoing: adapter.takeOutgoing(), journalPositions }
    })

  return {
    get,
    state,
    submit,
    enqueue,
    editQueued,
    moveQueued,
    prioritizeQueued,
    cancelQueued,
    setQueuePaused,
    claimQueued,
    observeQueuedLaunch,
    begin,
    apply,
    open,
    answer,
    interrupt,
    ingest,
    finalize,
    recordAppAction,
    compactionPlan,
    compact
  }
}

/**
 * Whether two sets of Review Attachments are the same reviewed code. Identity
 * reuse is refused on any difference: a submission id that answers about
 * different code is a different submission wearing the same name.
 */
function sameAttachments(left: ReviewAttachment[], right: ReviewAttachment[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * How many message turns a compaction carries across whole. The turns nearest
 * the person's next message are the ones a summary is worst at replacing —
 * they are what was just said — so they are not summarized at all.
 */
const COMPACTION_TAIL_TURNS = 8

/**
 * How much of the Conversation one summary request is given. The end is kept
 * rather than the start: a second compaction already carries the earlier work
 * as a summary, and the turns nearest the tail are the ones that summary knows
 * least about.
 */
const MAX_COMPACTION_MATERIAL = 100_000

/** One compaction's durable identity, so a retried record lands once. */
function compactionEntryId(operationId: string): string {
  return `boundary:compacted:${operationId}`
}

/**
 * The first entry of the untouched tail, or nothing when there is no tail to
 * separate: a Conversation with nothing before its last few turns has nothing
 * a summary could stand in for.
 */
function tailStart(entries: ConversationEntry[]): ConversationEntry | null {
  const turns = entries.filter((entry) => entry.kind === 'message')
  if (turns.length <= COMPACTION_TAIL_TURNS) return null
  return turns[turns.length - COMPACTION_TAIL_TURNS] ?? null
}

/**
 * The Conversation as prose a Harness can be asked to summarize: who said
 * what, what was run and what it printed, what was changed, and what was
 * permitted. Everything else is app bookkeeping and says nothing about the
 * work.
 */
function transcript(entries: ConversationEntry[]): string {
  const lines = entries.flatMap((entry) => {
    switch (entry.kind) {
      case 'message':
        return [`${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.text}`]
      case 'command':
        return [
          `Ran: ${entry.command}${entry.failed ? ' (failed)' : ''}`,
          ...(entry.output ? [`Printed: ${entry.output}`] : [])
        ]
      case 'file-change':
        return [`Changed ${entry.path} (+${String(entry.added)} −${String(entry.removed)})`]
      case 'read':
        return [`Read ${entry.path}`]
      case 'approval':
        return entry.decision === null ? [] : [`Approval ${entry.decision}: ${entry.summary}`]
      case 'plan':
        return [`Plan: ${entry.steps.map((step) => step.step).join('; ')}`]
      case 'subagent':
        return [`Delegated to ${entry.name}: ${entry.result ?? entry.status}`]
      // App bookkeeping: what a Run's boundaries were, what it cost, which
      // Thread it ran on, what the queue did. None of it is the work.
      case 'boundary':
      case 'usage':
      case 'thread':
      case 'app-action':
      case 'queued-submission':
      case 'queue-state':
      case 'queue-outcome':
        return []
    }
  })
  const text = lines.join('\n')
  return text.length <= MAX_COMPACTION_MATERIAL
    ? text
    : `… earlier turns not carried …\n${text.slice(-MAX_COMPACTION_MATERIAL)}`
}

/** One approval's durable identity: the Run, and the Harness's tool-use id. */
function approvalEntryId(runId: string, toolUseId: string): string {
  return `approval:${runId}:${toolUseId}`
}

function runBoundarySummary(input: BeginConversationRunInput): string {
  // The Skill is whatever was installed and asked for; this app keeps no list
  // of names to prettify, because discovery is the only list there is.
  const harness = input.harness ? (HARNESS_RUN_LABELS[input.harness] ?? null) : null
  const work = input.skill
    ? `Run started via ${harness ?? 'a Harness'}, working to ${input.skill}`
    : null
  const started = work ?? (harness ? `Run started via ${harness}` : 'Run started')
  return input.restorationNote ? `${started}. Harness Thread restored from local history` : started
}

const ADAPTER_FACTORIES: Partial<Record<HarnessId, (launch?: CodexLaunch) => HarnessAdapter>> = {
  codex: (launch) => createCodexAdapter(launch),
  claude: () => createClaudeAdapter()
}

const HARNESS_RUN_LABELS: Partial<Record<HarnessId, string>> = {
  claude: 'Claude',
  codex: 'Codex'
}

function without<A>(current: ReadonlyMap<string, A>, key: string): ReadonlyMap<string, A> {
  const next = new Map(current)
  next.delete(key)
  return next
}

const BOUNDARY_FOR_OUTCOME: Record<
  FinalizeRunInput['outcome'],
  Extract<ConversationEntry, { kind: 'boundary' }>['boundary']
> = {
  completed: 'run-completed',
  stopped: 'run-stopped',
  failed: 'run-failed',
  'policy-violation': 'run-failed',
  'supervision-failed': 'run-failed'
}

/** Causes the Harness reports about itself, rather than ones this app infers. */
type StatedCause = 'authentication' | 'rate-limit' | 'context-exhausted'
const HARNESS_STATED: Record<StatedCause, true> = {
  authentication: true,
  'rate-limit': true,
  'context-exhausted': true
}

function isStatedCause(category: HarnessFailureCategory): category is StatedCause {
  return Object.hasOwn(HARNESS_STATED, category)
}

/** Categories whose cause is transient, so resending the same submission is safe. */
const RESENDABLE = new Set<ConversationRecovery['category']>([
  'authentication',
  'rate-limit',
  'process-crash',
  'uncertain-submission'
])

function describeRecovery(
  input: FinalizeRunInput,
  run: {
    contacted: boolean
    producedAssistantText: boolean
    /** Events the Adapter could not model. */
    unmodelled: number
    submissionId: string | null
  }
): ConversationRecovery | null {
  // A Run that ends without a single assistant message, having produced
  // protocol this app could not read, has not really succeeded — whatever
  // exit code the process gave. Saying so beats an empty Conversation.
  const spokeUnreadably = !run.producedAssistantText && run.unmodelled > 0
  if (input.outcome === 'completed') {
    return spokeUnreadably
      ? {
          category: 'protocol-unsupported',
          summary: redactCredentials(input.summary).slice(0, 500),
          resumableSubmissionId: null
        }
      : null
  }
  const category = ((): ConversationRecovery['category'] => {
    if (input.outcome === 'stopped') return 'stopped'
    if (input.outcome === 'policy-violation') return 'policy-violation'
    if (input.outcome === 'supervision-failed') return 'supervision-failed'
    // What the Harness said about itself beats anything inferred from the
    // shape of the Run, so an expired sign-in is never reported as drift.
    if (input.category !== null && isStatedCause(input.category)) return input.category
    if (spokeUnreadably) return 'protocol-unsupported'
    // A Run that failed without producing anything leaves the submission's
    // fate genuinely unknown, which is what the person needs to be told.
    if (!run.contacted) return 'uncertain-submission'
    return 'process-crash'
  })()
  return {
    category,
    summary: redactCredentials(input.summary).slice(0, 500),
    resumableSubmissionId: RESENDABLE.has(category) ? run.submissionId : null
  }
}

/** One more change to a file, folded into whatever this Session knew of it. */
function tally(
  known: ChangedFile | undefined,
  entry: Extract<ConversationEntry, { kind: 'file-change' }>
): ChangedFile {
  return {
    path: entry.path,
    changes: (known?.changes ?? 0) + 1,
    added: (known?.added ?? 0) + entry.added,
    removed: (known?.removed ?? 0) + entry.removed,
    // The latest thing to happen to it is what it is now: a file created and
    // then deleted in one Session is gone.
    changeKind: entry.changeKind,
    shortened: (known?.shortened ?? false) || entry.shortened,
    // One report from the agent is enough to account for the file; a Checkout
    // comparison only ever adds what nothing accounted for.
    reported: (known?.reported ?? false) || entry.source === 'harness',
    // A later write to a file that was put back means it is no longer put
    // back: the row describes what the file is now, and something has since
    // changed it again.
    restored: false
  }
}

function replaceEntries(
  entries: ConversationEntry[],
  replacements: ConversationEntry[]
): ConversationEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  for (const entry of replacements) byId.set(entry.id, entry)
  return [...byId.values()]
}

function summarize(
  sessionId: string,
  entries: ConversationEntry[],
  journalPosition: number,
  queuePausedOverride?: boolean
): ConversationSnapshot {
  // What the Session is doing is one rule, and it lives with the projection
  // the inbox reads (ticket 12f). Stating it twice would be two answers to
  // one question, free to disagree.
  const state = deriveState(entries, 0)
  let latestRunUsage: HarnessUsage | null = null
  let sessionUsage = emptyUsage()
  const harnessThreads: Partial<Record<HarnessId, string>> = {}
  // One row per file, in the order the Session first touched each: what this
  // work has done to the Project, kept as it was reported rather than read
  // back off disk.
  const changed = new Map<string, ChangedFile>()
  const queued = entries
    .filter((entry): entry is QueuedSubmission => entry.kind === 'queued-submission')
    .sort((left, right) => left.position - right.position || left.at.localeCompare(right.at))
  const active = queued.filter(isActiveQueuedSubmission)
  const paused = active.length > 0 ? (queuePausedOverride ?? true) : true
  const outcome = entries.findLast((entry) => entry.kind === 'queue-outcome')
  for (const entry of entries) {
    if (entry.kind === 'usage') {
      sessionUsage = addUsage(sessionUsage, entry.usage)
      latestRunUsage = entry.usage
    }
    if (entry.kind === 'thread') harnessThreads[entry.harness] = entry.threadId
    if (entry.kind === 'file-change') changed.set(entry.path, tally(changed.get(entry.path), entry))
    // Folded in the order things happened, so a file put back and then
    // changed again by a later Run reads as changed, not as restored. The
    // file-change entries themselves are never touched: the Run that made the
    // change, and the diff it made, stay exactly as they were recorded.
    if (entry.kind === 'app-action') {
      for (const outcome of entry.outcomes) {
        const known = changed.get(outcome.path)
        if (!known) continue
        changed.set(outcome.path, { ...known, restored: isRestored(outcome.outcome) })
      }
    }
  }
  return {
    sessionId,
    journalPosition,
    entries: entries.filter(
      (entry) =>
        entry.kind !== 'usage' &&
        entry.kind !== 'thread' &&
        entry.kind !== 'queued-submission' &&
        entry.kind !== 'queue-state' &&
        entry.kind !== 'queue-outcome'
    ),
    usage: { run: latestRunUsage, session: sessionUsage },
    recovery: state.recovery,
    harnessThreads,
    changedFiles: [...changed.values()],
    activeRunId: state.activeRunId,
    // The Run is blocked for exactly as long as a request stands unanswered.
    // The oldest is the one put to the person, so that answering it reveals
    // the next: a Harness may have several in flight, and picking the newest
    // would leave the ones behind it unanswerable.
    pendingApprovalId: state.openApprovals[0] ?? null,
    queue: {
      paused,
      items: queued.map((item) => {
        const activeIndex = active.findIndex((candidate) => candidate.id === item.id)
        const editable = item.status === 'pending' || (item.status === 'claimed' && paused)
        return {
          ...item,
          controls: {
            edit: editable,
            moveEarlier: editable && activeIndex > 0,
            moveLater: editable && activeIndex >= 0 && activeIndex < active.length - 1,
            cancel: editable,
            sendNow: editable && state.activeRunId === null
          }
        }
      }),
      outcome:
        outcome?.kind === 'queue-outcome'
          ? { type: outcome.type, submissionId: outcome.submissionId }
          : null
    }
  }
}
