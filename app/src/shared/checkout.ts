import { z } from 'zod'
import { suggestSessionTitle } from './title'

/**
 * Where a Session's work happens. `local` is the Project's own working copy,
 * edited in place (ADR 0004); `worktree` is an isolated git worktree of the
 * same Project, so the agent's edits land beside the person's copy rather
 * than in it.
 *
 * A Checkout is fixed when the Session is created and never moves: a Session
 * whose working directory changed underneath it would be reporting diffs
 * against a place the person is no longer looking at.
 */
export const checkoutSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }),
  z.object({ kind: z.literal('worktree'), path: z.string().min(1) })
])
export type Checkout = z.infer<typeof checkoutSchema>

export const worktreeBootstrapSkipReasonSchema = z.enum([
  'invalid-path',
  'missing',
  'tracked',
  'not-ignored',
  'symlink',
  'not-regular',
  'permission-denied',
  'destination-exists',
  'copy-failed'
])
export type WorktreeBootstrapSkipReason = z.infer<typeof worktreeBootstrapSkipReasonSchema>

/**
 * The filenames considered while preparing an isolated Checkout. Contents
 * never cross this boundary: only Project-relative names and typed outcomes
 * are durable or visible to the Renderer.
 */
export const worktreeBootstrapResultSchema = z.object({
  outcome: z.enum(['copied', 'partial', 'skipped']),
  copied: z.array(z.string().min(1)),
  skipped: z.array(z.object({ path: z.string().min(1), reason: worktreeBootstrapSkipReasonSchema }))
})
export type WorktreeBootstrapResult = z.infer<typeof worktreeBootstrapResultSchema>

/**
 * What Git is doing in a Checkout right now. This is observed state, never
 * stored: both the person and an agent can begin or finish an operation from
 * outside the app.
 */
export const checkoutStateSchema = z.enum([
  'clean',
  'merge',
  'rebase',
  'squash-merge',
  'cherry-pick',
  'revert',
  'unresolved-index',
  'unsafe-root'
])
export type CheckoutState = z.infer<typeof checkoutStateSchema>

/** Git discovery failures stay distinct from a successfully observed state. */
export const checkoutStateObservationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('observed'), state: checkoutStateSchema }),
  z.object({ status: z.literal('git-unavailable') }),
  z.object({ status: z.literal('not-a-repository') })
])
export type CheckoutStateObservation = z.infer<typeof checkoutStateObservationSchema>

/** The default when a Session is started without saying: the working copy. */
export const LOCAL_CHECKOUT: Checkout = { kind: 'local' }

/**
 * What a new Session asks for, before it is settled. `isolated` is the ask —
 * "make me an isolated checkout from this base branch" — which Main answers
 * by creating the linked worktree and settling it into `worktree` before the
 * Session exists. A raw worktree path is deliberately not accepted here: the
 * window never has one to name, and an input nothing sends is attack surface.
 */
export const checkoutRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }),
  z.object({ kind: z.literal('isolated'), baseBranch: z.string().min(1).max(200) })
])
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>

/**
 * The branch an isolated checkout is cut onto, derived from the message that
 * starts the Session the same way its title is — deterministic and local. A
 * taken name is the creator's problem to suffix, not this function's.
 */
export function isolatedBranchName(message: string): string {
  const slug = suggestSessionTitle(message)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug || 'session'
}

/**
 * The Project's local branches, for choosing an isolated checkout's base.
 * Observed when asked, never stored: branches move under any store.
 */
export const branchListSchema = z.object({
  /** Most recently committed first, capped — a base is a recent branch. */
  branches: z.array(z.string().min(1)).max(200),
  /** The branch the working copy is on, or null when detached. */
  current: z.string().min(1).nullable()
})
export type BranchList = z.infer<typeof branchListSchema>

/** The directory a Checkout names, given the Project it belongs to. */
export function checkoutDirectory(projectRoot: string, checkout: Checkout): string {
  return checkout.kind === 'local' ? projectRoot : checkout.path
}

/**
 * The "where am I?" facts the title bar states about a Session: which
 * Checkout it works on, the directory that is, and the branch that directory
 * is on right now. The branch is observed when asked, never stored — the
 * agent, or the person in a terminal, can move it at any time.
 */
export const checkoutFactsSchema = z.object({
  checkout: checkoutSchema,
  /** The absolute directory the Checkout names. */
  path: z.string().min(1),
  /** The branch the Checkout is on, or null when detached or unreadable. */
  branch: z.string().min(1).nullable(),
  /** The operation Git is performing, or why Git could not be observed. */
  state: checkoutStateObservationSchema
})
export type CheckoutFacts = z.infer<typeof checkoutFactsSchema>
