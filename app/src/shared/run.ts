import { z } from 'zod'
import { ideaRelativePathSchema } from './portable-path'
import { providerIdSchema } from './readiness'

export const runStatusSchema = z.enum([
  'accepted',
  'starting',
  'running',
  'waiting',
  'completed',
  'failed',
  'stopped',
  'policy-violation',
  'supervision-failed'
])
export type RunStatus = z.infer<typeof runStatusSchema>

export const workflowSchema = z.enum([
  'setup',
  'grilling',
  'wayfinder',
  'domain-modeling',
  'research',
  'to-spec',
  'to-tickets'
])
export type PlanningWorkflow = z.infer<typeof workflowSchema>

export const permissionModeSchema = z.enum(['ask', 'auto'])
export type PermissionMode = z.infer<typeof permissionModeSchema>

export const runConfigurationSchema = z.object({
  provider: providerIdSchema,
  executable: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().min(1),
  workflow: workflowSchema,
  skill: z.object({
    name: z.string().min(1),
    path: z.string().min(1),
    hash: z.string().length(64)
  }),
  environment: z.record(z.string()),
  workingDirectory: z.string().min(1),
  permissionMode: permissionModeSchema,
  permissionProfile: z.literal('planning-v1')
})
export type RunConfiguration = z.infer<typeof runConfigurationSchema>

export const acceptRunInputSchema = z.object({
  submissionId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9._:-]+$/),
  relativePath: ideaRelativePathSchema,
  prompt: z.string().min(1).max(100_000),
  configuration: runConfigurationSchema
})
export type AcceptRunInput = z.infer<typeof acceptRunInputSchema>

export const runSnapshotSchema = z.object({
  id: z.string().min(1),
  submissionId: z.string().min(1),
  relativePath: ideaRelativePathSchema,
  prompt: z.string(),
  configuration: runConfigurationSchema,
  status: runStatusSchema,
  acceptedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  activity: z.array(
    z.object({
      id: z.string().min(1),
      at: z.string().datetime(),
      kind: z.enum(['lifecycle', 'allowed', 'blocked', 'output', 'error']),
      summary: z.string().min(1)
    })
  )
})
export type RunSnapshot = z.infer<typeof runSnapshotSchema>

export const startRunInputSchema = acceptRunInputSchema
  .pick({
    submissionId: true,
    relativePath: true,
    prompt: true
  })
  .extend({
    provider: providerIdSchema,
    model: z.string().min(1),
    effort: z.string().min(1),
    workflow: workflowSchema,
    permissionMode: permissionModeSchema
  })
export type StartRunInput = z.infer<typeof startRunInputSchema>

export const stopRunInputSchema = z.object({
  runId: z.string().min(1),
  relativePath: ideaRelativePathSchema
})
export type StopRunInput = z.infer<typeof stopRunInputSchema>

export const recordRunEventInputSchema = z.object({
  relativePath: ideaRelativePathSchema,
  runId: z.string().min(1),
  status: runStatusSchema.optional(),
  kind: z.enum(['lifecycle', 'allowed', 'blocked', 'output', 'error']),
  summary: z.string().min(1).max(2_000)
})
export type RecordRunEventInput = z.infer<typeof recordRunEventInputSchema>
