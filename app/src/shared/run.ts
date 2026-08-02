import { z } from 'zod'
import { harnessIdSchema } from './readiness'

/**
 * The name the app's own MCP server is registered under. Main writes it into
 * each Harness's configuration and derives Claude's tool-allow pattern from it;
 * the adapters match tool names against it. A drift between those would fail
 * silently at runtime rather than at compile time, so they read one constant.
 */
export const MCP_SERVER_NAME = 'app'
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`

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

/**
 * The name of the Skill a Run is configured with. It names an installed
 * instruction document, so it stays a plain validated string: which Skills
 * exist is discovered, never enumerated by the contract.
 */
export const skillNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9-]*$/)
export type SkillName = z.infer<typeof skillNameSchema>

export const permissionModeSchema = z.enum(['ask', 'auto'])
export type PermissionMode = z.infer<typeof permissionModeSchema>

/**
 * The collapsed activity stream. It is sanitized and deliberately separate
 * from Conversation content: `reasoning` carries only
 * Harness-supplied summaries, never requested hidden chain-of-thought.
 */
export const runActivityKindSchema = z.enum([
  'lifecycle',
  'allowed',
  'blocked',
  'output',
  'error',
  'reasoning'
])
export type RunActivityKind = z.infer<typeof runActivityKindSchema>

export const runConfigurationSchema = z.object({
  harness: harnessIdSchema,
  executable: z.string().min(1),
  executableHash: z.string().length(64),
  harnessVersion: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().min(1),
  skill: z.object({
    name: skillNameSchema,
    path: z.string().min(1),
    hash: z.string().length(64)
  }),
  environment: z.record(z.string()),
  workingDirectory: z.string().min(1),
  permissionMode: permissionModeSchema
})
export type RunConfiguration = z.infer<typeof runConfigurationSchema>

export const acceptRunInputSchema = z.object({
  submissionId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9._:-]+$/),
  sessionId: z.string().min(1),
  prompt: z.string().min(1).max(100_000),
  configuration: runConfigurationSchema
})
export type AcceptRunInput = z.infer<typeof acceptRunInputSchema>

export const runSnapshotSchema = z.object({
  id: z.string().min(1),
  submissionId: z.string().min(1),
  sessionId: z.string().min(1),
  prompt: z.string(),
  configuration: runConfigurationSchema,
  status: runStatusSchema,
  acceptedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  activity: z.array(
    z.object({
      id: z.string().min(1),
      at: z.string().datetime(),
      kind: runActivityKindSchema,
      summary: z.string().min(1)
    })
  )
})
export type RunSnapshot = z.infer<typeof runSnapshotSchema>

export const startRunInputSchema = acceptRunInputSchema
  .pick({
    submissionId: true,
    sessionId: true,
    prompt: true
  })
  .extend({
    harness: harnessIdSchema,
    model: z.string().min(1),
    effort: z.string().min(1),
    skill: skillNameSchema,
    permissionMode: permissionModeSchema
  })
export type StartRunInput = z.infer<typeof startRunInputSchema>

export const stopRunInputSchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1)
})
export type StopRunInput = z.infer<typeof stopRunInputSchema>

export const recordRunEventInputSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  status: runStatusSchema.optional(),
  kind: runActivityKindSchema,
  summary: z.string().min(1).max(2_000)
})
export type RecordRunEventInput = z.infer<typeof recordRunEventInputSchema>
