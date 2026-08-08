import { z } from 'zod'

export const pullRequestStateSchema = z.enum(['draft', 'open', 'merged', 'closed'])
export type PullRequestState = z.infer<typeof pullRequestStateSchema>

/** Remote GitHub state is an adornment on a Session, never its lifecycle status. */
export const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url().max(2_000),
  title: z.string().min(1).max(500),
  state: pullRequestStateSchema
})
export type PullRequest = z.infer<typeof pullRequestSchema>

export const preparePullRequestInputSchema = z.object({ sessionId: z.string().min(1) })
export type PreparePullRequestInput = z.infer<typeof preparePullRequestInputSchema>

export const pullRequestUnavailableReasonSchema = z.enum([
  'local-checkout',
  'local-unsafe',
  'detached-head',
  'checkout-busy',
  'gh-unavailable',
  'gh-unauthenticated',
  'github-unavailable'
])
export type PullRequestUnavailableReason = z.infer<typeof pullRequestUnavailableReasonSchema>

export const preparePullRequestResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    publishMode: z.enum(['local', 'worktree']),
    /** Reviewed Local Checkout tree; null means there is no uncommitted work. */
    expectedTree: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/u)
      .nullable(),
    baseBranch: z.string().min(1).max(500),
    headBranch: z.string().min(1).max(500),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(100_000)
  }),
  z.object({
    status: z.literal('unavailable'),
    reason: pullRequestUnavailableReasonSchema,
    detail: z.string().min(1).max(500).optional()
  })
])
export type PreparePullRequestResult = z.infer<typeof preparePullRequestResultSchema>

export const createPullRequestInputSchema = z.object({
  sessionId: z.string().min(1),
  baseBranch: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(100_000),
  publishMode: z.enum(['local', 'worktree']),
  expectedTree: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable()
})
export type CreatePullRequestInput = z.infer<typeof createPullRequestInputSchema>

export const createPullRequestResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['created', 'opened-existing']), pullRequest: pullRequestSchema }),
  z.object({
    status: z.literal('failed'),
    detail: z.string().min(1).max(500)
  })
])
export type CreatePullRequestResult = z.infer<typeof createPullRequestResultSchema>
