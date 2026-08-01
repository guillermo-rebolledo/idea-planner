import { z } from 'zod'
import { ideaRelativePathSchema } from './portable-path'
import { providerIdSchema, type ProviderId } from './readiness'
import { permissionModeSchema, workflowSchema } from './run'

/**
 * The Conversation is the Idea's one permanent, user-visible history, and the
 * normalized harness event contract is the only thing allowed to change it.
 *
 * Every harness Adapter translates its provider's protocol into these events,
 * so Core, Main, and the Renderer never see raw provider frames. Portable
 * Conversation content holds user and assistant messages plus visible Run
 * boundaries; reasoning summaries, tool activity, and diagnostics stay in the
 * separate sanitized activity stream.
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
  /** Provider-reported context window, when the provider reports one. */
  contextWindow: z.number().int().positive().nullable(),
  contextUsed: z.number().int().nonnegative().nullable()
})
export type HarnessUsage = z.infer<typeof harnessUsageSchema>

/**
 * One normalized provider event. `unsupported` is how an Adapter reports a
 * frame it does not model: unknown protocol never fails a Run and never
 * reaches portable Conversation content.
 */
export const harnessEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('assistant-delta'), text: z.string().min(1) }),
  z.object({ type: z.literal('assistant-message'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), summary: z.string().min(1) }),
  z.object({ type: z.literal('tool'), name: z.string().min(1), summary: z.string().min(1) }),
  z.object({
    type: z.literal('choices'),
    question: z.string().max(2_000),
    options: z.array(suggestedResponseSchema).min(1).max(12)
  }),
  z.object({ type: z.literal('usage'), usage: harnessUsageSchema }),
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
 * the local history intact; none of them contacts a provider on its own.
 */
export const conversationRecoverySchema = z.object({
  category: z.enum([
    'authentication',
    'rate-limit',
    'context-exhausted',
    'process-crash',
    'stopped',
    'uncertain-submission',
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
    source: z.enum(['composer', 'suggested-response', 'provider']),
    /** Present on user messages: the stable id that makes resending safe. */
    submissionId: z.string().min(1).nullable().default(null),
    /** Offered only from provider-native structured choices. */
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
  })
])
export type ConversationEntry = z.infer<typeof conversationEntrySchema>

export const conversationSnapshotSchema = z.object({
  relativePath: ideaRelativePathSchema,
  entries: z.array(conversationEntrySchema),
  /** Usage for the most recent Run, and the Idea's running total. */
  usage: z.object({ run: harnessUsageSchema.nullable(), idea: harnessUsageSchema }),
  recovery: conversationRecoverySchema.nullable(),
  /** The Run the Conversation is currently waiting on, when there is one. */
  activeRunId: z.string().min(1).nullable()
})
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>

export const submitConversationMessageInputSchema = z.object({
  relativePath: ideaRelativePathSchema,
  submissionId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9._:-]+$/),
  text: z.string().min(1).max(100_000),
  source: z.enum(['composer', 'suggested-response'])
})
export type SubmitConversationMessageInput = z.infer<typeof submitConversationMessageInputSchema>

/** The Renderer's one command for developing an Idea through a Conversation. */
export const developIdeaInputSchema = submitConversationMessageInputSchema.extend({
  workflow: workflowSchema,
  provider: providerIdSchema,
  model: z.string().min(1).max(200),
  effort: z.string().min(1).max(50),
  permissionMode: permissionModeSchema
})
export type DevelopIdeaInput = z.infer<typeof developIdeaInputSchema>

export const ingestProviderOutputInputSchema = z.object({
  relativePath: ideaRelativePathSchema,
  runId: z.string().min(1),
  events: z.array(harnessEventSchema)
})

export const finalizeConversationRunInputSchema = z.object({
  relativePath: ideaRelativePathSchema,
  runId: z.string().min(1),
  outcome: z.enum(['completed', 'stopped', 'failed', 'policy-violation', 'supervision-failed']),
  category: harnessFailureCategorySchema.nullable(),
  summary: z.string().min(1).max(500)
})
export type FinalizeConversationRunInput = z.infer<typeof finalizeConversationRunInputSchema>

/** Pushed to the Renderer as it happens, ahead of any durable projection. */
export const conversationStreamEventSchema = z.object({
  relativePath: ideaRelativePathSchema,
  runId: z.string().min(1),
  messageId: z.string().min(1),
  event: harnessEventSchema
})
export type ConversationStreamEvent = z.infer<typeof conversationStreamEventSchema>

/**
 * The providers that can currently stream into a Conversation. A provider
 * without a harness Adapter would start a Run whose answers never arrive, so
 * developing an Idea is offered only for the ones listed here.
 */
export const CONVERSATION_PROVIDERS: readonly ProviderId[] = ['codex']

/** The Conversation message one Run streams into. Core owns this identity. */
export function assistantMessageId(runId: string): string {
  return `assistant:${runId}`
}

/**
 * The methodology this product invokes, with the attribution the upstream MIT
 * licence expects. The app never implies endorsement and never installs it.
 */
export const WORKFLOW_ATTRIBUTION = {
  author: 'Matt Pocock',
  website: 'https://www.mattpocock.com',
  repository: 'https://github.com/mattpocock/skills',
  licence: 'MIT',
  notice:
    'Planning workflows are based on Matt Pocock’s open-source skills. He does not endorse this app.'
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
