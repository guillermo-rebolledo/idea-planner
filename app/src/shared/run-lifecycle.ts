import { z } from 'zod'
import {
  checkoutChangeSchema,
  conversationSnapshotSchema,
  harnessFailureCategorySchema
} from './conversation'
import {
  runOpeningInputSchema,
  runActivityKindSchema,
  runSnapshotSchema,
  type SkillName
} from './run'

/**
 * The only shared Run lifecycle seam. Main submits native observations; Core
 * atomically owns Run records, Conversation boundaries, Checkout evidence,
 * queue disposition, idempotency, and repair. Effect values never cross it.
 */

/** One durable request to accept a Run and open its Conversation boundary. */
export const openRunLifecycleInputSchema = runOpeningInputSchema.extend({
  /** The durable message this attempt answers; retries keep the original identity. */
  conversationSubmissionId: z.string().min(1).max(200).optional(),
  restorationNote: z.boolean().optional(),
  /** The native mode Main asked the Harness for, used only for drift reporting. */
  askedPermissionMode: z.string().min(1).max(100).optional()
})
export type OpenRunLifecycleInput = z.infer<typeof openRunLifecycleInputSchema>

export const openRunLifecycleResultSchema = z.object({
  run: runSnapshotSchema,
  conversation: conversationSnapshotSchema
})
export type OpenRunLifecycleResult = z.infer<typeof openRunLifecycleResultSchema>

export const terminalRunStatusSchema = z.enum([
  'completed',
  'stopped',
  'failed',
  'policy-violation',
  'supervision-failed'
])
export type TerminalRunStatus = z.infer<typeof terminalRunStatusSchema>

export const checkoutObservationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('observed'), changes: z.array(checkoutChangeSchema).max(500) }),
  z.object({ status: z.literal('unavailable') })
])
export type CheckoutObservation = z.infer<typeof checkoutObservationSchema>

/** Native terminal facts Main can observe; Core maps them to product state. */
export const terminalRunObservationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('harness-completed'),
    kind: runActivityKindSchema,
    summary: z.string().min(1).max(500)
  }),
  z.object({
    type: z.literal('harness-failed'),
    kind: runActivityKindSchema,
    summary: z.string().min(1).max(500),
    category: harnessFailureCategorySchema.nullable()
  }),
  z.object({
    type: z.literal('person-stopped'),
    kind: runActivityKindSchema,
    summary: z.string().min(1).max(500)
  }),
  z.object({
    type: z.literal('policy-violation'),
    kind: runActivityKindSchema,
    summary: z.string().min(1).max(500)
  }),
  z.object({
    type: z.literal('supervision-failed'),
    kind: runActivityKindSchema,
    summary: z.string().min(1).max(500)
  })
])
export type TerminalRunObservation = z.infer<typeof terminalRunObservationSchema>

/** Main's one terminal observation; Core owns every product-state consequence. */
export const completeRunLifecycleInputSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  observation: terminalRunObservationSchema,
  checkoutObservation: checkoutObservationSchema
})
export type CompleteRunLifecycleInput = z.infer<typeof completeRunLifecycleInputSchema>

export const completeRunLifecycleResultSchema = z.object({
  run: runSnapshotSchema,
  conversation: conversationSnapshotSchema,
  queueDisposition: z.enum(['advance', 'pause'])
})
export type CompleteRunLifecycleResult = z.infer<typeof completeRunLifecycleResultSchema>

/** Boundary metadata is derived from frozen Run configuration in Core. */
export function lifecycleSkill(input: OpenRunLifecycleInput): SkillName | undefined {
  return input.configuration.skill?.name
}
