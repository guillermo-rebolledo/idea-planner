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
  z.object({
    kind: z.literal('worktree'),
    path: z.string().min(1),
    /** The chosen PR target. Absent only on Sessions written before ADR 0007. */
    baseBranch: z.string().min(1).max(200).optional()
  })
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
  // The filesystem cannot copy-on-write clone, so a directory was not carried.
  'clone-unsupported',
  'copy-failed'
])
export type WorktreeBootstrapSkipReason = z.infer<typeof worktreeBootstrapSkipReasonSchema>

/**
 * Where an isolated Checkout's carried state came from: the Project's commit
 * when the bootstrap ran, the branch that commit was on, and when it ran.
 *
 * Provenance and nothing more. Whether what was carried suits the Checkout's
 * base is a question about lockfiles, and the bootstrap deliberately knows
 * nothing about ecosystems — it asks Git what is ignored and carries the
 * answer — so a verdict here would be a guess wearing a fact's clothes.
 */
export const worktreeBootstrapProvenanceSchema = z.object({
  /** The Project's HEAD when the bootstrap ran, in full. */
  commit: z.string().regex(/^[0-9a-f]{7,64}$/),
  /** The branch that commit was on, or null when the Project was detached. */
  branch: z.string().min(1).nullable(),
  /** When the state was carried. */
  at: z.string().datetime()
})
export type WorktreeBootstrapProvenance = z.infer<typeof worktreeBootstrapProvenanceSchema>

/**
 * The names considered while preparing an isolated Checkout — a carried
 * directory keeps Git's trailing slash, so `node_modules/` reads as the tree
 * it is. Contents never cross this boundary: only Project-relative names and
 * typed outcomes are durable or visible to the Renderer.
 */
export const worktreeBootstrapResultSchema = z.object({
  outcome: z.enum(['copied', 'partial', 'skipped']),
  copied: z.array(z.string().min(1)),
  skipped: z.array(
    z.object({ path: z.string().min(1), reason: worktreeBootstrapSkipReasonSchema })
  ),
  /**
   * Null when Git could not be read, and on Sessions bootstrapped before this
   * was recorded. Both are an origin nobody knows — which is a different thing
   * from a Checkout nothing was ever carried into, and that is a Session with
   * no result at all rather than a result with no provenance.
   */
  provenance: worktreeBootstrapProvenanceSchema.nullable().default(null)
})
export type WorktreeBootstrapResult = z.infer<typeof worktreeBootstrapResultSchema>

/** Derives the aggregate outcome from the per-file results in one place. */
export function buildWorktreeBootstrapResult(
  copied: string[],
  skipped: WorktreeBootstrapResult['skipped'],
  provenance: WorktreeBootstrapProvenance | null
): WorktreeBootstrapResult {
  return {
    outcome:
      skipped.length === 0 && copied.length > 0
        ? 'copied'
        : copied.length > 0
          ? 'partial'
          : 'skipped',
    copied,
    skipped,
    provenance
  }
}

/** A commit as a person reads one: short, and never mistaken for a branch. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 7)
}

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
 * Why the New Session composer is proposing the Checkout it is proposing,
 * when the reason is something observed rather than the standing baseline.
 * The picker states it in one line: a default that moves for reasons nobody
 * can see reads as the app deciding behind the person's back.
 */
export type CheckoutDefaultReason = 'local-run-active'

export interface CheckoutDefault {
  kind: CheckoutRequest['kind']
  reason: CheckoutDefaultReason | null
  /**
   * True while this is the baseline standing in for an answer that has not
   * come back yet. It is the safe-looking one — Local — and the answer it is
   * waiting for is the only thing that could say otherwise, so it is not a
   * proposal to start a Session on.
   */
  provisional: boolean
}

/**
 * Which Checkout a new Session starts on when the person has not said (ADR
 * 0010). Two Sessions in one Project's working copy can write the same file
 * with neither the app nor the person told, so a Project already being worked
 * in hands the next Session an isolated Checkout of its own — the collision
 * is answered by the directory, not by narrating it after both writes landed.
 *
 * With nothing running the baseline of ADR 0004 stands: the person's editor
 * and dev server point at the working copy, so that is where work goes, and a
 * Project whose Sessions are always isolated keeps getting isolated ones.
 *
 * Nothing here is a refusal. It decides only what is proposed; the person
 * overrides in either direction and the picker argues with neither.
 *
 * Not knowing yet is its own answer rather than a quiet "no". Both of them
 * propose Local, and only one of them is safe to act on: the composer opens
 * before anything has been looked up, and treating that moment as a Project
 * with nothing running is how a Session gets sent into a working copy an
 * agent is already writing to.
 */
export function defaultCheckout(context: {
  /**
   * Whether a Run is working in this Project's Local Checkout right now, or
   * 'unknown' while the look that would say has not come back.
   */
  localRunActive: boolean | 'unknown'
  /** What this Project's most recent Session used, or null when it has none. */
  lastUsed: Checkout['kind'] | null
}): CheckoutDefault {
  if (context.localRunActive === true) {
    return { kind: 'isolated', reason: 'local-run-active', provisional: false }
  }
  return {
    kind: context.lastUsed === 'worktree' ? 'isolated' : 'local',
    reason: null,
    provisional: context.localRunActive === 'unknown'
  }
}

/**
 * What the composer's Checkout chip is actually asking for, from the three
 * things that have a say and nothing else: what the app proposed, what the
 * person picked, and what the last look at Git found to cut a worktree from.
 *
 * Each keeps its own place, and the order between them is the whole point.
 * A pick outranks a proposal, so a default cannot move under a choice already
 * made. An observation outranks neither — it is what was true when Git was
 * last asked, so a Project with nothing to cut from falls back to Local
 * without that fallback becoming somebody's decision, and a later look that
 * finds a branch puts the isolated ask straight back.
 */
export function resolveCheckout(context: {
  /** What the app would offer if nobody had said. */
  proposed: CheckoutDefault
  /** The kind the person picked, or undefined while they have not. */
  chosenKind?: CheckoutRequest['kind'] | undefined
  /**
   * The branch a worktree would be cut from: a name, `null` for looked and
   * there is nothing to cut from, `undefined` for not looked yet.
   */
  base?: string | null | undefined
}): {
  checkout: CheckoutRequest
  reason: CheckoutDefaultReason | null
  /** Whether this is settled enough to start a Session on. */
  sendable: boolean
} {
  const asked = context.chosenKind ?? context.proposed.kind
  // A Project with no branch to cut from cannot have an isolated Checkout,
  // whoever asked for one. Send stays live on Local rather than refusing with
  // nothing to say — and because this is derived, the ask survives the answer.
  const kind = asked === 'isolated' && context.base === null ? 'local' : asked
  const checkout: CheckoutRequest =
    kind === 'isolated' ? { kind: 'isolated', baseBranch: context.base ?? '' } : { kind: 'local' }
  return {
    checkout,
    // Two things are worth waiting a moment for, and both are the difference
    // between a Session that lands where it was meant to and one that does
    // not: an isolated ask with no base has nothing to cut from yet, and a
    // proposal still standing in for an answer is the Local one that a Run
    // working in that Checkout would have overruled. A Checkout the person
    // picked is theirs either way and waits for nothing.
    sendable:
      (checkout.kind !== 'isolated' || checkout.baseBranch !== '') &&
      (context.chosenKind !== undefined || !context.proposed.provisional),
    // The line explains a proposal. Once the person has answered it there is
    // nothing left to explain, and next to a Checkout that had to fall back it
    // would be explaining something that did not happen.
    reason:
      context.chosenKind === undefined && kind === context.proposed.kind
        ? context.proposed.reason
        : null
  }
}

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
