import { z } from 'zod'
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
 * One normalized Harness event. `unsupported` is how an Adapter reports a
 * frame it does not model: unknown protocol never fails a Run and never
 * reaches Conversation content.
 */
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
    hunks: z.array(diffHunkSchema).min(1)
  })
])
export type ConversationEntry = z.infer<typeof conversationEntrySchema>

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
  /** The Run the Conversation is currently waiting on, when there is one. */
  activeRunId: z.string().min(1).nullable()
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
  skill: skillNameSchema,
  harness: harnessIdSchema,
  model: z.string().min(1).max(200),
  effort: z.string().min(1).max(50),
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
