import { z } from 'zod'
import { proposedRuleSchema } from './approval'
import { harnessIdSchema } from './readiness'
import { MAX_REVIEW_ATTACHMENTS, reviewAttachmentSchema } from './review-attachment'
import { permissionModeSchema, runActivityKindSchema, skillNameSchema } from './run'

export { redactCredentials } from './redaction'

/**
 * The Conversation is the Session's one permanent, user-visible history, and
 * the normalized harness event contract is the only thing allowed to change it.
 *
 * Each Core protocol Adapter terminates its Harness's raw frames and emits
 * these events; only normalized events leave that boundary for Main and the
 * Renderer. Conversation content holds user and assistant messages plus visible
 * Run boundaries; reasoning summaries, tool activity, and diagnostics stay in
 * the separate sanitized activity stream.
 */

export const suggestedResponseSchema = z.object({
  id: z.string().min(1).max(200),
  /** What the person reads on the button. */
  label: z.string().min(1).max(200),
  /** The exact user message sent when the person selects it. */
  value: z.string().min(1).max(2_000)
})
export type SuggestedResponse = z.infer<typeof suggestedResponseSchema>

/**
 * How much of one Approval Request's tool input is worth carrying. A request
 * can hold a whole file's contents, and one that displaces the Conversation
 * around it is one nobody can read anyway.
 */
export const MAX_APPROVAL_DETAIL = 4_000

/**
 * How an Approval Request ended. `abandoned` is what an unanswered request
 * becomes when its Run ends first — a request nobody answered must never read
 * back as one somebody allowed.
 */
export const approvalDecisionSchema = z.enum(['allowed', 'denied', 'abandoned'])
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>

export const harnessFailureCategorySchema = z.enum([
  'authentication',
  'rate-limit',
  'context-exhausted',
  'process-crash',
  'protocol',
  'unknown'
])
export type HarnessFailureCategory = z.infer<typeof harnessFailureCategorySchema>

export const harnessUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  /** Harness-reported context window, when the Harness reports one. */
  contextWindow: z.number().int().positive().nullable(),
  contextUsed: z.number().int().nonnegative().nullable()
})
export type HarnessUsage = z.infer<typeof harnessUsageSchema>

/**
 * What a subagent is doing, in the four states the Harnesses can actually
 * distinguish. `interrupted` is neither success nor failure: the Run ended, or
 * the agent was closed, before anything was reported back.
 */
export const subagentStatusSchema = z.enum(['working', 'done', 'failed', 'interrupted'])
export type SubagentStatus = z.infer<typeof subagentStatusSchema>

/**
 * How much of a subagent's brief and report is kept. A subagent is handed a
 * prompt and returns prose, and both are written by a model with no length
 * budget; this is the same order as an approval's detail.
 */
export const MAX_SUBAGENT_TEXT = 8_000

/** What happened to a file: it appeared, its text changed, or it went. */
export const changeKindSchema = z.enum(['added', 'changed', 'deleted'])
export type ChangeKind = z.infer<typeof changeKindSchema>

/**
 * What actually happened to one path when a Run was undone. Kept here because
 * it is a durable Conversation shape before it is anything else: what the app
 * did, in the app's own record, path by path.
 */
export const undoOutcomeSchema = z.object({
  path: z.string().min(1),
  outcome: z.enum([
    /** Put back the way it was before the Run. */
    'restored',
    /** Left alone because it had changed since the Run. */
    'skipped-diverged',
    /** Left alone because it was already back the way it was. */
    'skipped-already-restored'
  ])
})
export type UndoOutcome = z.infer<typeof undoOutcomeSchema>

/**
 * How many paths one undo names. A codemod can touch thousands, and a list
 * beyond this is not one anybody reads; the count of the rest is still told.
 */
export const MAX_UNDO_OUTCOMES = 500

/** One contiguous run of changed lines, as the Harness computed it. */
export const diffHunkSchema = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  /** Unified-diff lines, each already prefixed with ' ', '-' or '+'. */
  lines: z.array(z.string())
})
export type DiffHunk = z.infer<typeof diffHunkSchema>

/**
 * What a set of hunks added and removed. One definition, because a diff that
 * counts differently in the panel than in the Conversation is a diff nobody
 * can quote.
 */
export function countDiffLines(hunks: DiffHunk[]): { added: number; removed: number } {
  const lines = hunks.flatMap((hunk) => hunk.lines)
  return {
    added: lines.filter((line) => line.startsWith('+')).length,
    removed: lines.filter((line) => line.startsWith('-')).length
  }
}

/**
 * One normalized Harness event. `unsupported` is how an Adapter reports a
 * frame it does not model: unknown protocol never fails a Run and never
 * reaches Conversation content.
 */
export const harnessEventSchema = z.discriminatedUnion('type', [
  /**
   * One assistant message, identified by the Harness's own item id. A Run may
   * produce several. `text` is always the whole message so far, so a later
   * event supersedes an earlier one; `complete` says the Harness finished it.
   */
  z.object({
    type: z.literal('assistant-message'),
    id: z.string().min(1).max(200),
    text: z.string(),
    complete: z.boolean()
  }),
  z.object({ type: z.literal('reasoning'), summary: z.string().min(1) }),
  /**
   * One file the Harness changed in the Checkout, with the hunks it computed.
   * The change is already on disk when this arrives: edits land in place and
   * git is the only undo (ADR 0004), so this reports what happened rather than
   * proposing it.
   */
  z.object({
    type: z.literal('file-change'),
    path: z.string().min(1),
    /** What the Harness says happened to it, when it says at all. */
    changeKind: changeKindSchema.optional(),
    hunks: z.array(diffHunkSchema).min(1)
  }),
  z.object({
    type: z.literal('tool'),
    name: z.string().min(1),
    summary: z.string().min(1),
    /**
     * The file the tool read, when it read one. A read becomes a durable step
     * of the Run; a tool call that names no file stays activity only.
     */
    path: z.string().min(1).optional()
  }),
  /**
   * One command the Harness ran in the Checkout, and what it printed. Kept
   * apart from `tool` because the output is the point: a Run that compiles or
   * tests something says nothing useful without it.
   */
  z.object({
    type: z.literal('command'),
    /** The Harness's own id for the call, so a result can be paired to it. */
    id: z.string().min(1).max(200),
    command: z.string().min(1),
    output: z.string(),
    failed: z.boolean(),
    running: z.boolean().default(false),
    /**
     * The Run ended before this command's result ever arrived. Not a failure
     * and not a clean finish: whatever it printed, and whether it worked, was
     * never reported.
     */
    interrupted: z.boolean().optional(),
    /** As the Harness reported it. Null when it says only that it failed. */
    exitCode: z.number().int().nullable().default(null),
    /** Null when the Harness reported none and nothing saw the start. */
    durationMs: z.number().int().nonnegative().nullable().default(null)
  }),
  /**
   * One subagent the Run dispatched, in whatever state it is now. The whole
   * state travels every time, so a later event supersedes an earlier one and
   * nothing has to be assembled from a sequence of deltas — the same bargain
   * `command` makes, for the same reason: the Harnesses report a subagent by
   * repeatedly describing it, not by describing what changed.
   */
  z.object({
    type: z.literal('subagent'),
    /** The Harness's own id for the dispatch, which every later report names. */
    id: z.string().min(1).max(200),
    /** What it was called: Claude's description, or Codex's agent path. */
    name: z.string().min(1).max(200),
    /** The kind of worker, when the Harness names one. */
    role: z.string().min(1).max(100).optional(),
    /**
     * What it was sent to do, in full. Absent under a Harness that does not
     * carry the dispatch prompt — the surface says less rather than guessing.
     */
    brief: z.string().max(MAX_SUBAGENT_TEXT).optional(),
    status: subagentStatusSchema,
    /** The one line saying what it is on now, while it is working. */
    activity: z.string().min(1).max(500).optional(),
    /** What it reported back. Only ever present once it has ended. */
    result: z.string().max(MAX_SUBAGENT_TEXT).optional(),
    /** How many steps it has taken, when the Harness counts them. */
    steps: z.number().int().nonnegative().nullable().default(null),
    durationMs: z.number().int().nonnegative().nullable().default(null)
  }),
  z.object({
    type: z.literal('choices'),
    question: z.string().max(2_000),
    options: z.array(suggestedResponseSchema).min(1).max(12)
  }),
  /**
   * The agent asking before it edits or runs anything, in Ask mode. It is
   * served natively by the app's own approval tool
   * (`docs/harness-permission-mapping.md`), so `id` is the Harness's own
   * tool-use id and the Run is blocked for as long as this stands.
   */
  z.object({
    type: z.literal('approval-request'),
    id: z.string().min(1).max(200),
    tool: z.string().min(1).max(200),
    /** What is being asked for, in one line: the command, or the path. */
    summary: z.string().min(1).max(2_000),
    /** The rest of the tool input, so the person judges the real request. */
    detail: z.string().max(MAX_APPROVAL_DETAIL),
    /**
     * The Standing Approval that would stop this being asked again, when one
     * can be narrowed honestly. Null means the person answers this every time,
     * which is a better answer than a rule too broad to judge.
     */
    proposedRule: proposedRuleSchema.nullable().default(null)
  }),
  z.object({
    type: z.literal('approval-resolved'),
    id: z.string().min(1).max(200),
    decision: approvalDecisionSchema,
    /** What the agent is told when the person declines. */
    message: z.string().max(2_000).default(''),
    /** True when the person also granted the Standing Approval on offer. */
    remembered: z.boolean().default(false)
  }),
  z.object({ type: z.literal('usage'), usage: harnessUsageSchema }),
  z.object({
    type: z.literal('thread-ready'),
    harness: harnessIdSchema,
    /**
     * The mode the Harness reports it is actually running under. Managed
     * settings outrank command-line arguments, so what the app asked for is
     * not necessarily what is running.
     */
    permissionMode: z.string().min(1).max(100).optional(),
    threadId: z.string().min(1).max(200),
    model: z.string().min(1).max(200)
  }),
  z.object({
    type: z.literal('retrying'),
    attempt: z.number().int().positive(),
    delayMs: z.number().int().nonnegative(),
    category: z.enum(['rate-limit', 'harness'])
  }),
  z.object({ type: z.literal('completed') }),
  z.object({
    type: z.literal('failed'),
    category: harnessFailureCategorySchema,
    summary: z.string().min(1).max(2_000)
  }),
  z.object({ type: z.literal('unsupported'), detail: z.string().min(1).max(200) })
])
export type HarnessEvent = z.infer<typeof harnessEventSchema>

/**
 * What a Codex Run needs before it can start. It crosses to Core as a payload
 * rather than reaching the Harness through argv: the app-server protocol takes
 * all of it, and the person's own configuration is never touched (ADR 0003).
 *
 * The wire values are the ones the installed binary accepts — kebab-case, not
 * the camelCase its published documentation shows. `app/src/core/harness/codex.ts`
 * asserts at compile time that these still match the generated contract.
 */
export const codexLaunchSchema = z.object({
  cwd: z.string().min(1),
  approvalPolicy: z.enum(['untrusted', 'on-request', 'never']),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  model: z.string().min(1).optional(),
  /** Null when the chosen model has no reasoning level to ask for. */
  effort: z.string().min(1).nullable(),
  developerInstructions: z.string(),
  prompt: z.string().min(1).max(100_000),
  resumeThreadId: z.string().min(1).max(200).optional()
})
export type CodexLaunch = z.infer<typeof codexLaunchSchema>

/**
 * One pass of Harness protocol: what it said, and what it is owed in reply.
 * Only Codex is owed anything; Claude broadcasts and is never answered.
 */
export interface HarnessStream {
  events: HarnessEvent[]
  outgoing: string[]
}

export const messageCompletenessSchema = z.enum(['complete', 'partial'])
export type MessageCompleteness = z.infer<typeof messageCompletenessSchema>

export const conversationBoundarySchema = z.enum([
  'run-started',
  'run-completed',
  'run-stopped',
  'run-failed',
  'configuration'
])
export type ConversationBoundaryKind = z.infer<typeof conversationBoundarySchema>

/**
 * What the person can safely do after a Run ended badly. Every category keeps
 * the local history intact; none of them contacts a Harness on its own.
 */
export const conversationRecoverySchema = z.object({
  category: z.enum([
    'authentication',
    'rate-limit',
    'context-exhausted',
    'process-crash',
    'stopped',
    'uncertain-submission',
    'protocol-unsupported',
    'policy-violation',
    'supervision-failed'
  ]),
  summary: z.string().min(1).max(500),
  /** The submission the person may resend unchanged; ids stay idempotent. */
  resumableSubmissionId: z.string().min(1).nullable()
})
export type ConversationRecovery = z.infer<typeof conversationRecoverySchema>

export const queuedSubmissionStatusSchema = z.enum(['pending', 'claimed', 'sent', 'cancelled'])
export type QueuedSubmissionStatus = z.infer<typeof queuedSubmissionStatusSchema>

export const queuedSubmissionEntrySchema = z.object({
  kind: z.literal('queued-submission'),
  /** Stable across every replacement written for this Queued Submission. */
  id: z.string().min(1),
  at: z.string().datetime(),
  submissionId: z.string().min(1).max(200),
  text: z.string().min(1).max(100_000),
  source: z.enum(['composer', 'suggested-response']),
  harness: harnessIdSchema,
  model: z.string().min(1).max(200),
  effort: z.string().min(1).max(50).nullable(),
  skill: skillNameSchema.nullable(),
  permissionMode: permissionModeSchema,
  /**
   * The exact reviewed code this submission carries, kept as it was read.
   * A journal written by an older build may hold something this no longer
   * models; that degrades to none rather than dropping the whole submission,
   * because losing a queued message is worse than losing what it quoted.
   */
  reviewAttachments: z
    .array(reviewAttachmentSchema)
    .max(MAX_REVIEW_ATTACHMENTS)
    .default([])
    .catch([]),
  status: queuedSubmissionStatusSchema,
  /** Explicit order among all non-terminal items. */
  position: z.number().int().nonnegative()
})
export type QueuedSubmission = z.infer<typeof queuedSubmissionEntrySchema>

export const queuedSubmissionControlsSchema = z.object({
  edit: z.boolean(),
  moveEarlier: z.boolean(),
  moveLater: z.boolean(),
  cancel: z.boolean(),
  sendNow: z.boolean()
})

export const queuedSubmissionViewSchema = queuedSubmissionEntrySchema.extend({
  /** Durable policy projected by Core; Renderer never re-decides eligibility. */
  controls: queuedSubmissionControlsSchema
})
export type QueuedSubmissionView = z.infer<typeof queuedSubmissionViewSchema>

export function isActiveQueuedSubmission(item: QueuedSubmission): boolean {
  return item.status === 'pending' || item.status === 'claimed'
}

export const queueStateEntrySchema = z.object({
  kind: z.literal('queue-state'),
  id: z.literal('queue-state'),
  at: z.string().datetime(),
  paused: z.boolean()
})

export const queueOutcomeTypeSchema = z.enum([
  'enqueued',
  'edited',
  'moved-earlier',
  'moved-later',
  'cancelled',
  'paused',
  'resumed',
  'prioritized',
  'launch-started',
  'launch-reconciled',
  'launch-paused'
])

export const queueOutcomeEntrySchema = z.object({
  kind: z.literal('queue-outcome'),
  id: z.literal('queue-outcome'),
  at: z.string().datetime(),
  type: queueOutcomeTypeSchema,
  submissionId: z.string().min(1).max(200).nullable()
})
export type QueueOutcome = Pick<z.infer<typeof queueOutcomeEntrySchema>, 'type' | 'submissionId'>

export const conversationEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    id: z.string().min(1),
    at: z.string().datetime(),
    runId: z.string().min(1).nullable(),
    role: z.enum(['user', 'assistant']),
    text: z.string(),
    completeness: messageCompletenessSchema,
    source: z.enum(['composer', 'suggested-response', 'harness']),
    /** Present on user messages: the stable id that makes resending safe. */
    submissionId: z.string().min(1).nullable().default(null),
    /**
     * The reviewed code the person attached to this message. Kept beside the
     * prose rather than inside it: the Conversation shows what they wrote,
     * and only the Harness prompt carries the snapshots. Messages written
     * before attachments existed read back with none, which is what they had,
     * and one an older build wrote differently degrades to none rather than
     * costing the Conversation the message itself.
     */
    reviewAttachments: z
      .array(reviewAttachmentSchema)
      .max(MAX_REVIEW_ATTACHMENTS)
      .default([])
      .catch([]),
    /** Offered only from Harness-native structured choices. */
    suggestedResponses: z.array(suggestedResponseSchema).default([]),
    /**
     * True when the assistant's prose enumerates options the app cannot read
     * as structured choices. The person answers by typing instead.
     */
    plainOptions: z.boolean().default(false)
  }),
  z.object({
    kind: z.literal('boundary'),
    id: z.string().min(1),
    at: z.string().datetime(),
    runId: z.string().min(1),
    boundary: conversationBoundarySchema,
    summary: z.string().min(1).max(500),
    harness: harnessIdSchema.optional(),
    skill: skillNameSchema.optional(),
    model: z.string().min(1).max(200).optional(),
    restorationNote: z.boolean().optional(),
    /** The native mode this app asked the Harness for, to compare with what it reports. */
    askedPermissionMode: z.string().min(1).max(100).optional(),
    /** The submission that started this Run, so a resend stays idempotent. */
    submissionId: z.string().min(1).nullable().default(null),
    recovery: conversationRecoverySchema.nullable().default(null),
    /** Stable identity of a deep lifecycle ending; absent on earlier journals. */
    transitionFingerprint: z.string().length(64).optional(),
    /** Whether Main could compare the Checkout before this ending was committed. */
    checkoutObservation: z.enum(['observed', 'unavailable']).optional(),
    /** Core's durable decision about what completion permits Main to launch next. */
    queueDisposition: z.enum(['advance', 'pause']).optional(),
    /** Exact terminal Run projection, so every outcome can be repaired after a crash. */
    terminalOutcome: z
      .enum(['completed', 'stopped', 'failed', 'policy-violation', 'supervision-failed'])
      .optional(),
    /** Exact terminal activity projection, so restart does not rewrite its meaning. */
    terminalActivityKind: runActivityKindSchema.optional()
  }),
  z.object({
    kind: z.literal('usage'),
    id: z.string().min(1),
    at: z.string().datetime(),
    runId: z.string().min(1),
    usage: harnessUsageSchema
  }),
  z.object({
    kind: z.literal('thread'),
    id: z.string().min(1),
    at: z.string().datetime(),
    runId: z.string().min(1),
    harness: harnessIdSchema,
    threadId: z.string().min(1).max(200),
    model: z.string().min(1).max(200)
  }),
  /**
   * A command the Run ran, kept in the Conversation because what it printed is
   * usually the answer the person was waiting for.
   */
  z.object({
    kind: z.literal('command'),
    id: z.string().min(1),
    at: z.string().datetime(),
    runId: z.string().min(1),
    command: z.string().min(1),
    output: z.string(),
    failed: z.boolean(),
    /**
     * Still running. The Harness carries no partial output, so this is the
     * earliest the app can say anything: the command appears the moment it
     * starts and its output fills in when it lands.
     */
    running: z.boolean().default(false),
    /**
     * The Run ended before the command's result arrived. Distinct from failed:
     * nothing was ever reported about how it went, so no duration is measured
     * and no output is claimed.
     */
    interrupted: z.boolean().default(false),
    /** As the Harness reported it. Null when it says only that it failed. */
    exitCode: z.number().int().nullable().default(null),
    /**
     * How long it ran. The Harness's own figure when it gives one; otherwise
     * measured between the start the Conversation saw and the finish. Null
     * for a command never seen starting, or one whose result never arrived.
     */
    durationMs: z.number().int().nonnegative().nullable().default(null)
  }),
  /**
   * A file the Run read. A step of the Run's record rather than Conversation
   * prose: together with commands and file changes it is what the Run
   * actually did, re-readable after the Run is gone.
   *
   * No duration: no Harness reports how long a read took, and a field that is
   * null everywhere is a promise the record cannot keep. It returns when a
   * Harness supplies one.
   */
  z.object({
    kind: z.literal('read'),
    id: z.string().min(1),
    at: z.string().datetime(),
    runId: z.string().min(1),
    /** Relative to the Checkout, as every durable path is. */
    path: z.string().min(1)
  }),
  /**
   * Something the agent asked permission for, and what the person answered.
   * It belongs to the Conversation rather than to an activity panel: it is a
   * decision the person made, and the record of it outlives the Run.
   */
  z.object({
    kind: z.literal('approval'),
    id: z.string().min(1),
    at: z.string().datetime(),
    runId: z.string().min(1),
    /** The Harness's own id for the call, which the answer is addressed to. */
    requestId: z.string().min(1).max(200),
    tool: z.string().min(1).max(200),
    summary: z.string().min(1).max(2_000),
    detail: z.string().max(MAX_APPROVAL_DETAIL),
    /** The rule the person was offered, and could still be offered again. */
    proposedRule: proposedRuleSchema.nullable().default(null),
    /** Null while the request stands, which is what blocks the Run. */
    decision: approvalDecisionSchema.nullable().default(null),
    message: z.string().max(2_000).default(''),
    /** True when answering it also granted the Standing Approval on offer. */
    remembered: z.boolean().default(false)
  }),
  /**
   * A file the Harness changed, kept in the Conversation because it is part of
   * what happened in it. The Checkout is the record of the change itself; this
   * is the record of the Run having made it.
   */
  z.object({
    kind: z.literal('file-change'),
    id: z.string().min(1),
    at: z.string().datetime(),
    runId: z.string().min(1),
    path: z.string().min(1),
    hunks: z.array(diffHunkSchema).min(1),
    /**
     * What happened to the file. A deletion shown as a change is a row nobody
     * can read: every line of it is removed either way.
     */
    changeKind: changeKindSchema.default('changed'),
    /**
     * True when the diff kept is only the start of the one that happened. The
     * counts are still the whole change; the lines on screen are not.
     */
    shortened: z.boolean().default(false),
    /**
     * Who observed it. `harness` is the agent reporting its own edit;
     * `checkout` is the app finding it by comparing the Checkout before and
     * after the Run, which is the only way a change made by a shell command
     * is ever seen (ticket 12c).
     */
    source: z.enum(['harness', 'checkout']).default('harness'),
    /**
     * What the change did, counted before the diff was shortened for storage.
     * A long change keeps only the first of its lines, and counting those
     * would report a smaller change than the one that happened.
     */
    added: z.number().int().nonnegative().default(0),
    removed: z.number().int().nonnegative().default(0)
  }),
  /**
   * A subagent the Run dispatched. Durable rather than live-only for the same
   * reason a command is: what a Run delegated, and what came back, is part of
   * what happened in the Conversation, and is worth re-reading after the Run
   * that spawned it is gone.
   *
   * A subagent whose Run ended before it reported becomes `interrupted` — the
   * stream ending is itself the fact — rather than being left working forever
   * or promoted to an outcome nobody gave.
   */
  z.object({
    kind: z.literal('subagent'),
    id: z.string().min(1),
    at: z.string().datetime(),
    /**
     * When it was dispatched, kept through every later write. `at` moves with
     * each report, so without this a subagent working for a minute would read
     * as one that had just started.
     */
    startedAt: z.string().datetime(),
    runId: z.string().min(1),
    /** The Harness's own id for the dispatch, kept so later reports find it. */
    dispatchId: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    /** The kind of worker, when the Harness names one. */
    role: z.string().min(1).max(100).nullable().default(null),
    /** Absent under a Harness that does not carry the dispatch prompt. */
    brief: z.string().max(MAX_SUBAGENT_TEXT).nullable().default(null),
    status: subagentStatusSchema,
    activity: z.string().max(500).nullable().default(null),
    result: z.string().max(MAX_SUBAGENT_TEXT).nullable().default(null),
    steps: z.number().int().nonnegative().nullable().default(null),
    durationMs: z.number().int().nonnegative().nullable().default(null)
  }),
  /**
   * Something the app itself did to the Checkout, at the person's explicit
   * request. Only undoing a Run is one of these today.
   *
   * It is an entry of its own rather than a rewrite of the Run it undoes:
   * the Run happened, its diff is what happened, and a Conversation that
   * edited itself to say otherwise would be a record nobody could trust
   * (ADR 0006). The Run stays exactly as it was written, and this says what
   * was done about it afterwards — including which paths were left alone.
   *
   * It belongs to no Run: nothing was running when the person asked for it.
   */
  z.object({
    kind: z.literal('app-action'),
    id: z.string().min(1),
    at: z.string().datetime(),
    action: z.literal('run-undo'),
    /** The Run that was put back, so the record names where this came from. */
    sourceRunId: z.string().min(1),
    /** Every path considered, and what actually happened to it. */
    outcomes: z.array(undoOutcomeSchema).max(MAX_UNDO_OUTCOMES),
    /**
     * How many paths were considered, when more were considered than are
     * listed. Zero means the list is everything: a cap nobody is told about
     * turns a partial answer into a wrong one.
     */
    unlisted: z.number().int().nonnegative().default(0)
  }),
  queuedSubmissionEntrySchema,
  queueStateEntrySchema,
  queueOutcomeEntrySchema
])
export type ConversationEntry = z.infer<typeof conversationEntrySchema>

/**
 * One file this Session's agent changed, gathered from what the Harness
 * reported at the time rather than from the repository now. The Checkout is
 * edited in place (ADR 0004), so a Project that was already dirty when the
 * Session started would hand `git diff` the person's own edits as the agent's.
 */
export const changedFileSchema = z.object({
  /** Relative to the Checkout, as the Conversation recorded it. */
  path: z.string().min(1),
  /** How many separate times the agent wrote to it, across every Run. */
  changes: z.number().int().positive(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  changeKind: changeKindSchema,
  /** True when any of the diffs behind this row were shortened for storage. */
  shortened: z.boolean(),
  /**
   * Whether the agent said it changed this. False means the app found it by
   * comparing the Checkout before and after the Run — the change happened,
   * and nothing in the Conversation accounts for it.
   */
  reported: z.boolean(),
  /**
   * True when the app has since put this file back (ADR 0006). The row stays,
   * and so do the Run and the diff behind it: the change did happen, and the
   * honest thing to say is that it happened and was then undone — not to
   * quietly delete the evidence of either.
   *
   * Rows written before undo existed read back as not restored, which is
   * exactly what they were.
   */
  restored: z.boolean().default(false)
})
export type ChangedFile = z.infer<typeof changedFileSchema>

/** One file a Checkout comparison found changed, with git's own patch. */
export const checkoutChangeSchema = z.object({
  path: z.string().min(1),
  changeKind: changeKindSchema,
  diff: z.string()
})
export type CheckoutChange = z.infer<typeof checkoutChangeSchema>

/** A Run its Conversation still has open, which after a restart means nobody closed it. */
export const unfinishedRunSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1)
})
export type UnfinishedRun = z.infer<typeof unfinishedRunSchema>

export const conversationSnapshotSchema = z.object({
  sessionId: z.string().min(1),
  entries: z.array(conversationEntrySchema),
  /** Usage for the most recent Run, and the Session's running total. */
  usage: z.object({ run: harnessUsageSchema.nullable(), session: harnessUsageSchema }),
  recovery: conversationRecoverySchema.nullable(),
  /** The latest Harness Thread behind this Conversation, per Harness. */
  harnessThreads: z.object({
    codex: z.string().min(1).optional(),
    claude: z.string().min(1).optional()
  }),
  /**
   * What this Session has done to the Project, one row per file. It answers
   * "what is the state of this work" without reading the chat log, and the
   * app never offers to accept or reject any of it: the change is already on
   * disk and git is the only undo (ADR 0004).
   */
  changedFiles: z.array(changedFileSchema),
  /** The Run the Conversation is currently waiting on, when there is one. */
  activeRunId: z.string().min(1).nullable(),
  /**
   * The approval the Run is blocked on, when one stands. Ticket 12 owns
   * Session status, so blocked lives on the Run and this is where the app
   * reads it from.
   */
  pendingApprovalId: z.string().min(1).nullable().default(null),
  queue: z
    .object({
      paused: z.boolean(),
      /** Terminal items remain here so recovery can prove what happened. */
      items: z.array(queuedSubmissionViewSchema),
      /** Latest durable queue result, suitable for announcements. */
      outcome: queueOutcomeEntrySchema
        .pick({ type: true, submissionId: true })
        .nullable()
        .default(null)
    })
    .default({ paused: true, items: [], outcome: null })
})
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>

export const submitConversationMessageInputSchema = z.object({
  sessionId: z.string().min(1),
  submissionId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9._:-]+$/),
  text: z.string().min(1).max(100_000),
  source: z.enum(['composer', 'suggested-response']),
  reviewAttachments: z.array(reviewAttachmentSchema).max(MAX_REVIEW_ATTACHMENTS).default([])
})
export type SubmitConversationMessageInput = z.input<typeof submitConversationMessageInputSchema>

/**
 * How a message is answered: everything chosen in a composer's chip row. The
 * same shape wherever a message is sent from, so the launch screen and the
 * Conversation cannot drift into configuring a Run differently.
 */
export const runRequestSchema = z.object({
  /** Absent when the message asks for no particular methodology. */
  skill: skillNameSchema.optional(),
  harness: harnessIdSchema,
  model: z.string().min(1).max(200),
  effort: z.string().min(1).max(50).nullable(),
  permissionMode: permissionModeSchema
})
export type RunRequest = z.infer<typeof runRequestSchema>

export const enqueueQueuedSubmissionInputSchema =
  submitConversationMessageInputSchema.merge(runRequestSchema)
export type EnqueueQueuedSubmissionInput = z.input<typeof enqueueQueuedSubmissionInputSchema>

export const editQueuedSubmissionInputSchema = z.object({
  sessionId: z.string().min(1),
  submissionId: z.string().min(1).max(200),
  text: z.string().min(1).max(100_000)
})
export type EditQueuedSubmissionInput = z.infer<typeof editQueuedSubmissionInputSchema>

export const moveQueuedSubmissionInputSchema = z.object({
  sessionId: z.string().min(1),
  submissionId: z.string().min(1).max(200),
  direction: z.enum(['earlier', 'later'])
})
export type MoveQueuedSubmissionInput = z.infer<typeof moveQueuedSubmissionInputSchema>

export const queuedSubmissionIdentitySchema = z.object({
  sessionId: z.string().min(1),
  submissionId: z.string().min(1).max(200)
})
export type QueuedSubmissionIdentity = z.infer<typeof queuedSubmissionIdentitySchema>

export const setConversationQueuePausedInputSchema = z.object({
  sessionId: z.string().min(1),
  paused: z.boolean()
})
export type SetConversationQueuePausedInput = z.infer<typeof setConversationQueuePausedInputSchema>

export const queuedSubmissionLaunchObservationSchema = queuedSubmissionIdentitySchema.extend({
  outcome: z.enum(['started', 'not-started'])
})
export type QueuedSubmissionLaunchObservation = z.infer<
  typeof queuedSubmissionLaunchObservationSchema
>

export const queuedSubmissionDispositionObservationSchema = queuedSubmissionIdentitySchema.extend({
  outcome: z.enum(['started', 'reconciled', 'not-started'])
})
export type QueuedSubmissionDispositionObservation = z.infer<
  typeof queuedSubmissionDispositionObservationSchema
>

export const queuedSubmissionLaunchResultSchema = z.object({
  continueDraining: z.boolean()
})
export type QueuedSubmissionLaunchResult = z.infer<typeof queuedSubmissionLaunchResultSchema>

export const queuedSubmissionLaunchPlanSchema = z.object({
  sessionId: z.string().min(1),
  item: queuedSubmissionEntrySchema,
  /** Stable Run identity selected by Core; may be a derived retry identity. */
  runSubmissionId: z.string().min(1).max(200),
  /** Exact Harness prompt, including durable review attachments. */
  prompt: z.string().min(1)
})
export type QueuedSubmissionLaunchPlan = z.infer<typeof queuedSubmissionLaunchPlanSchema>

export const queuedSubmissionChangeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('enqueue'), input: enqueueQueuedSubmissionInputSchema }),
  z.object({ type: z.literal('edit'), input: editQueuedSubmissionInputSchema }),
  z.object({ type: z.literal('move'), input: moveQueuedSubmissionInputSchema }),
  z.object({ type: z.literal('cancel'), input: queuedSubmissionIdentitySchema }),
  z.object({ type: z.literal('pause'), sessionId: z.string().min(1) }),
  z.object({ type: z.literal('resume'), sessionId: z.string().min(1) }),
  z.object({ type: z.literal('send-now'), input: queuedSubmissionIdentitySchema })
])
export type QueuedSubmissionChange = z.infer<typeof queuedSubmissionChangeSchema>

/**
 * What the app did to the Checkout on the person's behalf, for the record.
 *
 * The operation id is the entry's identity, so a restoration whose record
 * failed to append and was retried is written once rather than twice.
 */
export const recordAppActionInputSchema = z.object({
  sessionId: z.string().min(1),
  operationId: z.string().min(1).max(200),
  action: z.literal('run-undo'),
  sourceRunId: z.string().min(1),
  outcomes: z.array(undoOutcomeSchema).max(MAX_UNDO_OUTCOMES),
  unlisted: z.number().int().nonnegative().default(0)
})
export type RecordAppActionInput = z.input<typeof recordAppActionInputSchema>

/** The Renderer's one command for developing a Session through a Conversation. */
export const developSessionInputSchema =
  submitConversationMessageInputSchema.merge(runRequestSchema)
export type DevelopSessionInput = z.input<typeof developSessionInputSchema>

/**
 * The submission identity of the message that created a Session. Named here
 * rather than spelled out where it is used: Core writes the message under it
 * and Main answers that same message with the first Run, and a submission
 * resent under a different identity would be a second message.
 */
export function startingSubmissionId(sessionId: string): string {
  return `start-${sessionId}`
}

/** App-owned Run boundaries that no Harness Adapter can report for itself. */
export const conversationLifecycleEventSchema = z.object({
  type: z.enum(['started', 'stopped'])
})
export type ConversationLifecycleEvent = z.infer<typeof conversationLifecycleEventSchema>

/** What Main pushes after Core has durably applied the event it represents. */
export const conversationEventSchema = z.union([
  conversationLifecycleEventSchema,
  harnessEventSchema
])
export type ConversationEvent = z.infer<typeof conversationEventSchema>

/** Pushed to the Renderer as it happens, after its durable projection. */
export const conversationStreamEventSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  /** Explicitly tells independent consumers which durable projection became stale. */
  invalidation: z.enum(['none', 'mailbox']),
  event: conversationEventSchema
})
export type ConversationStreamEvent = z.infer<typeof conversationStreamEventSchema>

/**
 * The model value meaning "whatever the Harness is configured to use". The
 * app never guesses a model name an account may not be entitled to.
 */
export const HARNESS_DEFAULT_MODEL = 'default'

/** The durable identity of one assistant message inside a Run. */
export function assistantMessageId(runId: string, itemId: string): string {
  return `assistant:${runId}:${itemId}`
}

/**
 * The methodology this product invokes, with the attribution the upstream MIT
 * licence expects. The app never implies endorsement and never installs it.
 */
export const SKILL_ATTRIBUTION = {
  author: 'Matt Pocock',
  website: 'https://www.mattpocock.com',
  repository: 'https://github.com/mattpocock/skills',
  licence: 'MIT',
  notice: 'Skills are based on Matt Pocock’s open-source skills. He does not endorse this app.'
} as const

const ENUMERATED_OPTION = /^\s*(?:[-*+]\s+|\(?\d{1,2}[.)]\s+|[a-d][.)]\s+)\S/

/**
 * Whether an assistant message merely lists options in prose. Such lists are
 * ambiguous — the app cannot tell an answer menu from ordinary content — so
 * they never become Suggested Responses and the person types a reply instead.
 */
export function hasPlainOptions(text: string): boolean {
  const lines = text.split('\n').filter((line) => ENUMERATED_OPTION.test(line))
  return lines.length >= 2
}

export function emptyUsage(): HarnessUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    contextWindow: null,
    contextUsed: null
  }
}

export function addUsage(total: HarnessUsage, next: HarnessUsage): HarnessUsage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    totalTokens: total.totalTokens + next.totalTokens,
    // The window is a property of the latest Run, not a sum.
    contextWindow: next.contextWindow ?? total.contextWindow,
    contextUsed: next.contextUsed ?? total.contextUsed
  }
}
