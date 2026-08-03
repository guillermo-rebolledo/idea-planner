import { z } from 'zod'
import { proposedRuleSchema } from './approval'
import { harnessIdSchema } from './readiness'
import { permissionModeSchema, skillNameSchema } from './run'

/**
 * The Conversation is the Session's one permanent, user-visible history, and
 * the normalized harness event contract is the only thing allowed to change it.
 *
 * Every harness Adapter translates its Harness's protocol into these events,
 * so Core, Main, and the Renderer never see raw Harness frames. Conversation
 * content holds user and assistant messages plus visible Run boundaries;
 * reasoning summaries, tool activity, and diagnostics stay in the separate
 * sanitized activity stream.
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

/** What happened to a file: it appeared, its text changed, or it went. */
export const changeKindSchema = z.enum(['added', 'changed', 'deleted'])
export type ChangeKind = z.infer<typeof changeKindSchema>

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
  z.object({ type: z.literal('tool'), name: z.string().min(1), summary: z.string().min(1) }),
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
    running: z.boolean().default(false)
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
    recovery: conversationRecoverySchema.nullable().default(null)
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
    running: z.boolean().default(false)
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
  })
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
  reported: z.boolean()
})
export type ChangedFile = z.infer<typeof changedFileSchema>

/** One file a Checkout comparison found changed, with git's own patch. */
export const checkoutChangeSchema = z.object({
  path: z.string().min(1),
  changeKind: changeKindSchema,
  diff: z.string()
})

/** A Run its Conversation still has open, which after a restart means nobody closed it. */
export const unfinishedRunSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1)
})
export type UnfinishedRun = z.infer<typeof unfinishedRunSchema>

export const recordCheckoutChangesInputSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  files: z.array(checkoutChangeSchema).max(500)
})
export type RecordCheckoutChangesInput = z.infer<typeof recordCheckoutChangesInputSchema>

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
  pendingApprovalId: z.string().min(1).nullable().default(null)
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
  source: z.enum(['composer', 'suggested-response'])
})
export type SubmitConversationMessageInput = z.infer<typeof submitConversationMessageInputSchema>

/** The Renderer's one command for developing a Session through a Conversation. */
export const developSessionInputSchema = submitConversationMessageInputSchema.extend({
  /** Absent when the message asks for no particular methodology. */
  skill: skillNameSchema.optional(),
  harness: harnessIdSchema,
  model: z.string().min(1).max(200),
  effort: z.string().min(1).max(50).nullable(),
  permissionMode: permissionModeSchema
})
export type DevelopSessionInput = z.infer<typeof developSessionInputSchema>

export const finalizeConversationRunInputSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  outcome: z.enum(['completed', 'stopped', 'failed', 'policy-violation', 'supervision-failed']),
  category: harnessFailureCategorySchema.nullable(),
  summary: z.string().min(1).max(500)
})
export type FinalizeConversationRunInput = z.infer<typeof finalizeConversationRunInputSchema>

/** Pushed to the Renderer as it happens, ahead of any durable projection. */
export const conversationStreamEventSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  event: harnessEventSchema
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

/** Removes credential-shaped text before anything is stored or presented. */
export function redactCredentials(value: string): string {
  return value.replace(
    /(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,
    '$1=[REDACTED: credential]'
  )
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
