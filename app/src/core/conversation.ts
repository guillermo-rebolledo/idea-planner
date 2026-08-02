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
  type ChangedFile,
  type DiffHunk,
  submitConversationMessageInputSchema,
  type ConversationEntry,
  type ConversationRecovery,
  type ConversationSnapshot,
  type FinalizeConversationRunInput,
  type HarnessEvent,
  type CodexLaunch,
  type HarnessFailureCategory,
  type HarnessStream,
  type HarnessUsage,
  type SuggestedResponse
} from '@shared/conversation'
import type { HarnessId } from '@shared/readiness'
import type { SkillName } from '@shared/run'
import { createCodexAdapter, type HarnessAdapter } from './harness/codex'
import { createClaudeAdapter } from './harness/claude'

/**
 * The Session's one permanent Conversation, inside the app-owned Session
 * directory (ADR 0002). Nothing about it is written into the Project.
 *
 * Durable truth is an append-only JSONL journal: later entries with the same
 * id supersede earlier ones, so a coalesced streaming checkpoint costs one
 * append and an interrupted Run still reads back as labelled partial content.
 * Everything presented is projected from that journal in memory.
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
): { path: string; hunks: DiffHunk[]; added: number; removed: number } {
  const relative = path.startsWith(`${checkout}/`) ? path.slice(checkout.length + 1) : path
  let budget = MAX_DIFF_LINES
  const kept: DiffHunk[] = []
  for (const hunk of hunks) {
    if (budget <= 0) break
    const lines = hunk.lines.slice(0, budget).map((line) => redactCredentials(line))
    budget -= lines.length
    kept.push({ ...hunk, lines })
  }
  return {
    path: redactCredentials(relative),
    // A change with nothing left to show is still a change that happened.
    hunks: kept.length > 0 ? kept : [{ ...hunks[0], lines: [] } as DiffHunk],
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

export interface ConversationEffects {
  get(sessionId: string): Effect.Effect<ConversationSnapshot, CoreError>
  submit(input: unknown): Effect.Effect<ConversationSnapshot, CoreError>
  begin(input: BeginConversationRunInput): Effect.Effect<ConversationSnapshot, CoreError>
  apply(input: ApplyHarnessEventInput): Effect.Effect<void, CoreError>
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
  finalize(input: FinalizeConversationRunInput): Effect.Effect<ConversationSnapshot, CoreError>
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
  // One writer at a time: a streaming checkpoint must never interleave with a
  // submission or a finalize on the same journal.
  const writeLock = Effect.runSync(Effect.makeSemaphore(1))

  const sessionDirectory = options.directoryFor

  const readEntries = (sessionDir: string): Effect.Effect<ConversationEntry[], CoreError> =>
    Effect.tryPromise({
      try: async () => {
        const raw = await readFile(join(sessionDir, JOURNAL), 'utf8').catch(() => '')
        const byId = new Map<string, ConversationEntry>()
        for (const line of raw.split('\n')) {
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
        return [...byId.values()]
      },
      catch: () => new CoreError('IO_ERROR', 'The Conversation history could not be read')
    })

  const append = (sessionDir: string, entry: ConversationEntry): Effect.Effect<void, CoreError> =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(sessionDir, { recursive: true, mode: 0o700 })
        await appendFile(join(sessionDir, JOURNAL), `${JSON.stringify(entry)}\n`, 'utf8')
      },
      catch: () => new CoreError('IO_ERROR', 'The Conversation could not be saved')
    })

  const snapshot = (
    sessionId: string,
    sessionDir: string
  ): Effect.Effect<ConversationSnapshot, CoreError> =>
    readEntries(sessionDir).pipe(Effect.map((entries) => summarize(sessionId, entries)))

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
      const sessionDir = yield* sessionDirectory(input.sessionId)
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const entries = yield* readEntries(sessionDir)
          const id = `user:${input.submissionId}`
          const existing = entries.find((entry) => entry.id === id)
          if (existing) {
            // A resent submission is the same submission: never a second
            // message, and never a silently different one.
            if (existing.kind !== 'message' || existing.text !== input.text) {
              return yield* Effect.fail(
                new CoreError(
                  'INVALID_INPUT',
                  'Submission identity was already used for different content'
                )
              )
            }
            return summarize(input.sessionId, entries)
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
            suggestedResponses: [],
            plainOptions: false
          })
          yield* append(sessionDir, entry)
          return summarize(input.sessionId, [...entries, entry])
        })
      )
    })

  const begin = (
    input: BeginConversationRunInput
  ): Effect.Effect<ConversationSnapshot, CoreError> =>
    Effect.gen(function* () {
      const sessionDir = yield* sessionDirectory(input.sessionId)
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
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

  const apply = (input: ApplyHarnessEventInput): Effect.Effect<void, CoreError> =>
    Effect.gen(function* () {
      const sessionDir = yield* sessionDirectory(input.sessionId)
      yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
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
              yield* append(
                sessionDir,
                conversationEntrySchema.parse({
                  kind: 'command',
                  id: `command:${input.runId}:${event.id}`,
                  at: now.toISOString(),
                  runId: input.runId,
                  command: describeCommand(event.command),
                  output: describeOutput(event.output),
                  failed: event.failed,
                  running: event.running
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
              // The ordinal is counted from the journal rather than from
              // memory: a restart part-way through a Run would otherwise start
              // again at one, and an id that repeats is an entry that
              // overwrites the change before it.
              const written = yield* readEntries(sessionDir)
              const ordinal =
                written.filter(
                  (entry) => entry.kind === 'file-change' && entry.runId === input.runId
                ).length + 1
              yield* append(
                sessionDir,
                conversationEntrySchema.parse({
                  kind: 'file-change',
                  id: `file-change:${input.runId}:${ordinal}`,
                  at: now.toISOString(),
                  runId: input.runId,
                  ...describeChange(
                    event.path,
                    event.hunks,
                    yield* options.checkoutFor(input.sessionId)
                  )
                })
              )
              return
            }
            case 'reasoning':
            case 'tool':
            case 'retrying':
            case 'completed':
            case 'failed':
              // Reasoning summaries and tool calls belong to the sanitized
              // activity stream only.
              return
          }
        })
      )
    })

  const finalize = (
    input: FinalizeConversationRunInput
  ): Effect.Effect<ConversationSnapshot, CoreError> =>
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
          yield* append(
            sessionDir,
            conversationEntrySchema.parse({
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
              })
            })
          )
          yield* forgetRun(input.runId)
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
      for (const event of events) {
        yield* apply({ sessionId: input.sessionId, runId: input.runId, event })
      }
      return { events, outgoing: adapter.takeOutgoing() }
    })

  return { get, submit, begin, apply, open, answer, interrupt, ingest, finalize }
}

/** One approval's durable identity: the Run, and the Harness's tool-use id. */
function approvalEntryId(runId: string, toolUseId: string): string {
  return `approval:${runId}:${toolUseId}`
}

function runBoundarySummary(input: BeginConversationRunInput): string {
  // The Skill is whatever was installed and asked for; this app keeps no list
  // of names to prettify, because discovery is the only list there is.
  const harness = input.harness === 'claude' ? 'Claude' : input.harness === 'codex' ? 'Codex' : null
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

function without<A>(current: ReadonlyMap<string, A>, key: string): ReadonlyMap<string, A> {
  const next = new Map(current)
  next.delete(key)
  return next
}

const BOUNDARY_FOR_OUTCOME: Record<
  FinalizeConversationRunInput['outcome'],
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
  input: FinalizeConversationRunInput,
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
    removed: (known?.removed ?? 0) + entry.removed
  }
}

function summarize(sessionId: string, entries: ConversationEntry[]): ConversationSnapshot {
  let activeRunId: string | null = null
  let recovery: ConversationRecovery | null = null
  let latestRunUsage: HarnessUsage | null = null
  let sessionUsage = emptyUsage()
  const harnessThreads: Partial<Record<HarnessId, string>> = {}
  // One row per file, in the order the Session first touched each: what this
  // work has done to the Project, kept as it was reported rather than read
  // back off disk.
  const changed = new Map<string, ChangedFile>()
  for (const entry of entries) {
    if (entry.kind === 'boundary') {
      if (entry.boundary === 'run-started') {
        activeRunId = entry.runId
        recovery = null
      } else if (entry.runId === activeRunId) {
        activeRunId = null
        recovery = entry.recovery
      }
    }
    if (entry.kind === 'usage') {
      sessionUsage = addUsage(sessionUsage, entry.usage)
      latestRunUsage = entry.usage
    }
    if (entry.kind === 'thread') harnessThreads[entry.harness] = entry.threadId
    if (entry.kind === 'file-change') changed.set(entry.path, tally(changed.get(entry.path), entry))
  }
  return {
    sessionId,
    entries: entries.filter((entry) => entry.kind !== 'usage' && entry.kind !== 'thread'),
    usage: { run: latestRunUsage, session: sessionUsage },
    recovery,
    harnessThreads,
    changedFiles: [...changed.values()],
    activeRunId,
    // The Run is blocked for exactly as long as a request stands unanswered.
    // The oldest is the one put to the person, so that answering it reveals
    // the next: a Harness may have several in flight, and picking the newest
    // would leave the ones behind it unanswerable.
    pendingApprovalId:
      entries.find((entry) => entry.kind === 'approval' && entry.decision === null)?.id ?? null
  }
}
