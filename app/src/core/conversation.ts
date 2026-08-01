import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect, Ref } from 'effect'
import { CoreError, ideaRelativePathSchema } from '@shared/contract'
import {
  addUsage,
  conversationEntrySchema,
  emptyUsage,
  assistantMessageId,
  hasPlainOptions,
  redactCredentials,
  submitConversationMessageInputSchema,
  type ConversationEntry,
  type ConversationRecovery,
  type ConversationSnapshot,
  type FinalizeConversationRunInput,
  type HarnessEvent,
  type HarnessUsage,
  type SuggestedResponse
} from '@shared/conversation'
import type { ProviderId } from '@shared/readiness'
import { createCodexAdapter, type HarnessAdapter } from './harness/codex'

/**
 * The Idea's one permanent Conversation.
 *
 * Durable truth is an append-only JSONL journal: later entries with the same
 * id supersede earlier ones, so a coalesced streaming checkpoint costs one
 * append and an interrupted Run still reads back as labelled partial content.
 * The portable Markdown document is a projection of that journal and holds
 * only user messages, assistant messages, and visible Run boundaries.
 */

const JOURNAL = join('.idea', 'conversation.jsonl')
const DOCUMENT = join('planning', 'conversation.md')
/** Streaming deltas persist at most this often; every other change persists at once. */
const CHECKPOINT_INTERVAL_MS = 250

interface ConversationOptions {
  library: Effect.Effect<string | null>
  clock: Effect.Effect<Date>
}

export interface BeginConversationRunInput {
  relativePath: string
  runId: string
  submissionId: string
}

export interface ApplyHarnessEventInput {
  relativePath: string
  runId: string
  event: HarnessEvent
}

export interface IngestProviderOutputInput {
  relativePath: string
  runId: string
  provider: ProviderId
  chunk: string
}

export interface ConversationEffects {
  get(relativePath: string): Effect.Effect<ConversationSnapshot, CoreError>
  submit(input: unknown): Effect.Effect<ConversationSnapshot, CoreError>
  begin(input: BeginConversationRunInput): Effect.Effect<ConversationSnapshot, CoreError>
  apply(input: ApplyHarnessEventInput): Effect.Effect<void, CoreError>
  /** Parses one raw provider chunk and applies everything it completed. */
  ingest(input: IngestProviderOutputInput): Effect.Effect<HarnessEvent[], CoreError>
  finalize(input: FinalizeConversationRunInput): Effect.Effect<ConversationSnapshot, CoreError>
}

/** Everything a Run has streamed so far, rebuilt from the journal after a crash. */
interface StreamState {
  messageId: string
  text: string
  authoritative: boolean
  suggestedResponses: SuggestedResponse[]
  usage: HarnessUsage | null
  checkpointedAt: number
}

export function createConversationEffects(options: ConversationOptions): ConversationEffects {
  // Per ADR 0001 mutable Core state lives in Ref; entries are replaced rather
  // than mutated so a checkpoint always writes a consistent message.
  const streams = Effect.runSync(Ref.make<ReadonlyMap<string, StreamState>>(new Map()))
  const adapters = Effect.runSync(Ref.make<ReadonlyMap<string, HarnessAdapter>>(new Map()))
  // One writer at a time: a streaming checkpoint must never interleave with a
  // submission or a finalize on the same journal.
  const writeLock = Effect.runSync(Effect.makeSemaphore(1))

  const ideaDirectory = (relativePath: string): Effect.Effect<string, CoreError> =>
    options.library.pipe(
      Effect.flatMap((library) =>
        library === null
          ? Effect.fail(new CoreError('NO_LIBRARY_OPEN', 'Open an Idea Library before developing'))
          : Effect.try({
              try: () => join(library, ideaRelativePathSchema.parse(relativePath)),
              catch: () => new CoreError('INVALID_INPUT', 'The Idea reference is not portable')
            })
      )
    )

  const readEntries = (ideaDir: string): Effect.Effect<ConversationEntry[], CoreError> =>
    Effect.tryPromise({
      try: async () => {
        const raw = await readFile(join(ideaDir, JOURNAL), 'utf8').catch(() => '')
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

  const append = (ideaDir: string, entry: ConversationEntry): Effect.Effect<void, CoreError> =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(join(ideaDir, '.idea'), { recursive: true, mode: 0o700 })
        await appendFile(join(ideaDir, JOURNAL), `${JSON.stringify(entry)}\n`, 'utf8')
      },
      catch: () => new CoreError('IO_ERROR', 'The Conversation could not be saved')
    })

  const renderDocument = (ideaDir: string): Effect.Effect<void, CoreError> =>
    readEntries(ideaDir).pipe(
      Effect.flatMap((entries) =>
        Effect.tryPromise({
          try: async () => {
            const path = join(ideaDir, DOCUMENT)
            const existing = await readFile(path, 'utf8').catch(() => '')
            const staged = `${path}.staged`
            await mkdir(join(ideaDir, 'planning'), { recursive: true })
            await writeFile(staged, renderConversation(existing, entries), 'utf8')
            await rename(staged, path)
          },
          catch: () => new CoreError('IO_ERROR', 'The Conversation document could not be written')
        })
      )
    )

  const snapshot = (
    relativePath: string,
    ideaDir: string
  ): Effect.Effect<ConversationSnapshot, CoreError> =>
    readEntries(ideaDir).pipe(Effect.map((entries) => summarize(relativePath, entries)))

  const get = (relativePath: string): Effect.Effect<ConversationSnapshot, CoreError> =>
    ideaDirectory(relativePath).pipe(Effect.flatMap((ideaDir) => snapshot(relativePath, ideaDir)))

  const submit = (rawInput: unknown): Effect.Effect<ConversationSnapshot, CoreError> =>
    Effect.gen(function* () {
      const parsed = submitConversationMessageInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid message')
        )
      }
      const input = parsed.data
      const ideaDir = yield* ideaDirectory(input.relativePath)
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const entries = yield* readEntries(ideaDir)
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
            return summarize(input.relativePath, entries)
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
          yield* append(ideaDir, entry)
          yield* renderDocument(ideaDir)
          return summarize(input.relativePath, [...entries, entry])
        })
      )
    })

  const begin = (
    input: BeginConversationRunInput
  ): Effect.Effect<ConversationSnapshot, CoreError> =>
    Effect.gen(function* () {
      const ideaDir = yield* ideaDirectory(input.relativePath)
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const at = (yield* options.clock).toISOString()
          const entry = conversationEntrySchema.parse({
            kind: 'boundary',
            id: `boundary:${input.runId}:started`,
            at,
            runId: input.runId,
            boundary: 'run-started',
            summary: 'Run started',
            submissionId: input.submissionId,
            recovery: null
          })
          yield* append(ideaDir, entry)
          yield* forgetRun(input.runId)
          yield* renderDocument(ideaDir)
          return yield* snapshot(input.relativePath, ideaDir)
        })
      )
    })

  const putStream = (runId: string, state: StreamState): Effect.Effect<StreamState> =>
    Ref.update(streams, (current) => new Map(current).set(runId, state)).pipe(Effect.as(state))

  const forgetRun = (runId: string): Effect.Effect<void> =>
    Effect.all([
      Ref.update(streams, (current) => without(current, runId)),
      Ref.update(adapters, (current) => without(current, runId))
    ]).pipe(Effect.asVoid)

  const loadStream = (ideaDir: string, runId: string): Effect.Effect<StreamState, CoreError> =>
    Effect.gen(function* () {
      const known = (yield* Ref.get(streams)).get(runId)
      if (known) return known
      // Core may have restarted mid-Run: continue from the last checkpoint
      // rather than starting a second assistant message.
      const entries = yield* readEntries(ideaDir)
      const messageId = assistantMessageId(runId)
      const previous = entries.find((entry) => entry.id === messageId)
      return yield* putStream(runId, {
        messageId,
        text: previous?.kind === 'message' ? previous.text : '',
        authoritative: false,
        suggestedResponses: previous?.kind === 'message' ? previous.suggestedResponses : [],
        usage: null,
        checkpointedAt: 0
      })
    })

  const checkpoint = (
    ideaDir: string,
    runId: string,
    state: StreamState,
    at: Date
  ): Effect.Effect<void, CoreError> =>
    Effect.gen(function* () {
      yield* putStream(runId, { ...state, checkpointedAt: at.getTime() })
      yield* append(
        ideaDir,
        conversationEntrySchema.parse({
          kind: 'message',
          id: state.messageId,
          at: at.toISOString(),
          runId,
          role: 'assistant',
          text: state.text,
          completeness: state.authoritative ? 'complete' : 'partial',
          source: 'provider',
          submissionId: null,
          suggestedResponses: state.suggestedResponses,
          plainOptions: state.suggestedResponses.length === 0 && hasPlainOptions(state.text)
        })
      )
    })

  const apply = (input: ApplyHarnessEventInput): Effect.Effect<void, CoreError> =>
    Effect.gen(function* () {
      const ideaDir = yield* ideaDirectory(input.relativePath)
      yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* loadStream(ideaDir, input.runId)
          const now = yield* options.clock
          const event = input.event
          switch (event.type) {
            case 'assistant-delta': {
              const grown = yield* putStream(input.runId, {
                ...state,
                text: state.text + event.text
              })
              // Deltas persist on a coalescing interval; every other change is
              // durable at once.
              if (now.getTime() - grown.checkpointedAt >= CHECKPOINT_INTERVAL_MS) {
                yield* checkpoint(ideaDir, input.runId, grown, now)
              }
              return
            }
            case 'assistant-message':
              yield* checkpoint(
                ideaDir,
                input.runId,
                yield* putStream(input.runId, { ...state, text: event.text, authoritative: true }),
                now
              )
              return
            case 'choices':
              yield* checkpoint(
                ideaDir,
                input.runId,
                yield* putStream(input.runId, { ...state, suggestedResponses: event.options }),
                now
              )
              return
            case 'usage':
              yield* putStream(input.runId, { ...state, usage: event.usage })
              yield* append(
                ideaDir,
                conversationEntrySchema.parse({
                  kind: 'usage',
                  id: `usage:${input.runId}`,
                  at: now.toISOString(),
                  runId: input.runId,
                  usage: event.usage
                })
              )
              return
            case 'reasoning':
            case 'tool':
            case 'completed':
            case 'failed':
            case 'unsupported':
              // Reasoning summaries, tool calls, and unmodelled protocol
              // belong to the sanitized activity stream only.
              return
          }
        })
      )
    })

  const finalize = (
    input: FinalizeConversationRunInput
  ): Effect.Effect<ConversationSnapshot, CoreError> =>
    Effect.gen(function* () {
      const ideaDir = yield* ideaDirectory(input.relativePath)
      // Drain a truncated final protocol line before the lock is taken, so
      // the last thing the provider said is part of what is finalized.
      const trailing = (yield* Ref.get(adapters)).get(input.runId)?.flush() ?? []
      for (const event of trailing) {
        yield* apply({ relativePath: input.relativePath, runId: input.runId, event })
      }
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* loadStream(ideaDir, input.runId)
          const now = yield* options.clock
          if (state.text) {
            yield* checkpoint(
              ideaDir,
              input.runId,
              { ...state, authoritative: state.authoritative || input.outcome === 'completed' },
              now
            )
          }
          const entries = yield* readEntries(ideaDir)
          const started = entries.find(
            (entry) => entry.kind === 'boundary' && entry.id === `boundary:${input.runId}:started`
          )
          const submissionId = started?.kind === 'boundary' ? started.submissionId : null
          const contacted = state.text !== '' || state.usage !== null
          yield* append(
            ideaDir,
            conversationEntrySchema.parse({
              kind: 'boundary',
              id: `boundary:${input.runId}:ended`,
              at: now.toISOString(),
              runId: input.runId,
              boundary: BOUNDARY_FOR_OUTCOME[input.outcome],
              summary: redactCredentials(input.summary).slice(0, 500),
              submissionId,
              recovery: describeRecovery(input, contacted, submissionId)
            })
          )
          yield* forgetRun(input.runId)
          yield* renderDocument(ideaDir)
          return yield* snapshot(input.relativePath, ideaDir)
        })
      )
    })

  const ingest = (input: IngestProviderOutputInput): Effect.Effect<HarnessEvent[], CoreError> =>
    Effect.gen(function* () {
      const known = (yield* Ref.get(adapters)).get(input.runId)
      let adapter = known
      if (!adapter) {
        const factory: (() => HarnessAdapter) | undefined = ADAPTER_FACTORIES[input.provider]
        // Without an Adapter the provider's answers could never reach the
        // Conversation, so this is refused rather than silently swallowed.
        if (!factory) {
          return yield* Effect.fail(
            new CoreError('INVALID_INPUT', `${input.provider} cannot stream into a Conversation`)
          )
        }
        const created = factory()
        adapter = created
        yield* Ref.update(adapters, (current) => new Map(current).set(input.runId, created))
      }
      const events = adapter.ingest(input.chunk)
      for (const event of events) {
        yield* apply({ relativePath: input.relativePath, runId: input.runId, event })
      }
      return events
    })

  return { get, submit, begin, apply, ingest, finalize }
}

const ADAPTER_FACTORIES: Partial<Record<ProviderId, () => HarnessAdapter>> = {
  codex: createCodexAdapter
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

/** Categories whose cause is transient, so resending the same submission is safe. */
const RESENDABLE = new Set<ConversationRecovery['category']>([
  'authentication',
  'rate-limit',
  'process-crash',
  'uncertain-submission'
])

function describeRecovery(
  input: FinalizeConversationRunInput,
  contacted: boolean,
  submissionId: string | null
): ConversationRecovery | null {
  if (input.outcome === 'completed') return null
  const category = ((): ConversationRecovery['category'] => {
    if (input.outcome === 'stopped') return 'stopped'
    if (input.outcome === 'policy-violation') return 'policy-violation'
    if (input.outcome === 'supervision-failed') return 'supervision-failed'
    // A Run that failed without producing anything leaves the submission's
    // fate genuinely unknown, which is what the person needs to be told.
    if (!contacted) return 'uncertain-submission'
    if (input.category === null || input.category === 'unknown' || input.category === 'protocol') {
      return 'process-crash'
    }
    return input.category
  })()
  return {
    category,
    summary: redactCredentials(input.summary).slice(0, 500),
    resumableSubmissionId: RESENDABLE.has(category) ? submissionId : null
  }
}

function summarize(relativePath: string, entries: ConversationEntry[]): ConversationSnapshot {
  let activeRunId: string | null = null
  let recovery: ConversationRecovery | null = null
  let latestRunUsage: HarnessUsage | null = null
  let ideaUsage = emptyUsage()
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
      ideaUsage = addUsage(ideaUsage, entry.usage)
      latestRunUsage = entry.usage
    }
  }
  return {
    relativePath: ideaRelativePathSchema.parse(relativePath),
    entries: entries.filter((entry) => entry.kind !== 'usage'),
    usage: { run: latestRunUsage, idea: ideaUsage },
    recovery,
    activeRunId
  }
}

const BOUNDARY_LABEL: Record<Extract<ConversationEntry, { kind: 'boundary' }>['boundary'], string> =
  {
    'run-started': 'Run started',
    'run-completed': 'Run completed',
    'run-stopped': 'Run stopped',
    'run-failed': 'Run failed',
    configuration: 'Configuration changed'
  }

/**
 * Rewrites the portable Conversation body while preserving the document's
 * existing frontmatter, which carries its managed identity.
 */
function renderConversation(existing: string, entries: ConversationEntry[]): string {
  const frontmatter = existing.startsWith('---\n')
    ? existing.slice(0, existing.indexOf('\n---\n') + 5)
    : ''
  const body = entries.flatMap((entry) => {
    if (entry.kind === 'usage') return []
    if (entry.kind === 'boundary') {
      return [`_${BOUNDARY_LABEL[entry.boundary]} — ${entry.summary}_`, '']
    }
    const speaker = entry.role === 'user' ? 'You' : 'Assistant'
    const label =
      entry.completeness === 'partial'
        ? ` _(partial — the Run ended before this message finished)_`
        : ''
    return [`## ${speaker}${label}`, '', entry.text.trim(), '']
  })
  return [frontmatter || '', '# Conversation', '', ...body].join('\n').replace(/\n{3,}/g, '\n\n')
}
