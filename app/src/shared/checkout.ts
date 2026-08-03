import { z } from 'zod'

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

/** The default when a Session is started without saying: the working copy. */
export const LOCAL_CHECKOUT: Checkout = { kind: 'local' }

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
  branch: z.string().min(1).nullable()
})
export type CheckoutFacts = z.infer<typeof checkoutFactsSchema>
