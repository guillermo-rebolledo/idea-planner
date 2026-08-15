import { z } from 'zod'

/**
 * Reclaiming the isolated Checkouts Argos made (ADR 0008).
 *
 * Argos has never removed a worktree, deliberately: git is the undo for files
 * and the app does not touch a person's work uninvited. That rule was written
 * when creating one was expensive enough to be rare. Isolation is now the
 * default for a Project's second concurrent Session, so worktrees appear
 * without a decision being taken — and a cloned dependency directory becomes
 * real disk the moment an agent installs into it.
 *
 * So: a surface that says what is there, and a removal the person asks for.
 * Nothing here ever runs on its own. No sweep, no prompt on quit, no cleanup
 * on Delete or Archive — this is Run Undo's grammar, and it is the difference
 * between an app that offers to tidy and one that decides for you what on your
 * disk is disposable.
 */

/**
 * How many Worktrees one Project reports at once. Each costs a directory walk,
 * and a list past this is not one anybody reads either.
 */
export const MAX_LISTED_WORKTREES = 200

/** How the Session that made a Worktree stands now. */
export const worktreeSessionStateSchema = z.enum(['active', 'archived'])
export type WorktreeSessionState = z.infer<typeof worktreeSessionStateSchema>

/** The Session a Worktree belongs to, when one still claims it. */
export const worktreeSessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  state: worktreeSessionStateSchema,
  /**
   * True while a Run this app process is responsible for is working in it.
   * Removing the directory an agent is writing into is the one thing this
   * surface refuses outright rather than confirming.
   */
  busy: z.boolean()
})
export type WorktreeSession = z.infer<typeof worktreeSessionSchema>

/**
 * What a Worktree holds that removing it would take with it. Both facts are
 * observed when asked and never stored: the person can commit, push, or dirty
 * a Checkout in a terminal at any time.
 */
export const worktreeContentsSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('observed'),
    /** Edits, additions, or deletions that no commit holds. */
    uncommittedChanges: z.boolean(),
    /**
     * Commits reachable from this Checkout's HEAD and from no other ref in the
     * repository — no other branch, no remote-tracking branch, no tag.
     *
     * Deliberately stronger than "not pushed": a Project with no remote at all
     * would otherwise report every Worktree as holding unpushed work, which is
     * true and useless. What the person needs to know is whether removing this
     * takes commits that exist nowhere else.
     */
    commitsOnlyHere: z.boolean()
  }),
  /** Git could not answer for it — no git, or no longer a repository. */
  z.object({ status: z.literal('unreadable') })
])
export type WorktreeContents = z.infer<typeof worktreeContentsSchema>

/**
 * What the directory is using on disk **now** — the blocks its files hold,
 * which is the figure `du` reports — rather than anything about what it cost
 * to create.
 *
 * It is an upper bound on what removing one frees. A Checkout is bootstrapped
 * by cloning, and cloned files share their blocks with the Project until
 * something writes to them; no tool on the machine can see that sharing per
 * file, so the surface says it in words instead of pretending to a number.
 */
export const worktreeDiskUsageSchema = z.object({
  bytes: z.number().int().nonnegative(),
  /**
   * False when the walk stopped early or a directory refused to be read, so
   * the figure is a floor rather than the answer. Said out loud rather than
   * rounded away: a number nobody qualified is one people act on.
   */
  complete: z.boolean()
})
export type WorktreeDiskUsage = z.infer<typeof worktreeDiskUsageSchema>

/** One isolated Checkout Argos made, and everything the decision needs. */
export const reclaimableWorktreeSchema = z.object({
  /** The absolute directory, which is also how removal names it. */
  path: z.string().min(1),
  /** The branch it is on, or null when detached or unreadable. */
  branch: z.string().min(1).nullable(),
  /**
   * The Session that works here, or null when none does — deleted, or a start
   * that never finished. Either way the directory is still on disk, which is
   * exactly why it has to be listed.
   */
  session: worktreeSessionSchema.nullable(),
  contents: worktreeContentsSchema,
  disk: worktreeDiskUsageSchema
})
export type ReclaimableWorktree = z.infer<typeof reclaimableWorktreeSchema>

/**
 * Every Worktree Argos made for one Project. Enumerated from the app's own
 * state directory rather than from git, so a Worktree whose Session is gone —
 * and one git itself has forgotten — is still accounted for.
 */
export const worktreeInventorySchema = z.object({
  projectRoot: z.string().min(1),
  /**
   * Opaque, and the only handle the window ever holds. It stands for what this
   * list said each Worktree held, which is what removal is checked against —
   * the window cannot describe a Checkout back to Main, so it cannot claim to
   * have shown a warning it never drew.
   */
  operationId: z.string().uuid(),
  worktrees: z.array(reclaimableWorktreeSchema).max(MAX_LISTED_WORKTREES),
  /**
   * How many were found beyond the ones listed. Zero means the list is
   * everything: a cap nobody is told about turns a partial answer into a wrong
   * one.
   */
  unlisted: z.number().int().nonnegative()
})
export type WorktreeInventory = z.infer<typeof worktreeInventorySchema>

export const removeWorktreesInputSchema = z.object({
  projectRoot: z.string().min(1),
  /** The list this confirmation answers, so what was read can be re-checked. */
  operationId: z.string().uuid(),
  /** Exactly the directories the person selected; nothing is inferred. */
  paths: z.array(z.string().min(1)).min(1).max(MAX_LISTED_WORKTREES)
})
export type RemoveWorktreesInput = z.infer<typeof removeWorktreesInputSchema>

export const worktreeRemovalOutcomeSchema = z.enum([
  'removed',
  /**
   * It was not there. A Worktree removed in a terminal between reading the
   * list and confirming it is not a failure — the person asked for it to be
   * gone, and it is gone.
   */
  'already-gone',
  /**
   * It holds something the list the person confirmed did not show — work
   * written while they were reading it. Nothing was touched, and that is a
   * promise the surface may repeat.
   */
  'changed',
  'failed'
])
export type WorktreeRemovalOutcome = z.infer<typeof worktreeRemovalOutcomeSchema>

export const worktreeRemovalSchema = z.object({
  path: z.string().min(1),
  outcome: worktreeRemovalOutcomeSchema,
  /** Why, when it failed. One line, and never a raw git transcript. */
  detail: z.string().min(1).max(300).nullable().default(null)
})
export type WorktreeRemoval = z.infer<typeof worktreeRemovalSchema>

/**
 * What happened to each selected Worktree, one entry per selection. One that
 * could not be removed never prevents the rest: they are separate directories,
 * and the person asked for all of them.
 */
export const worktreeRemovalResultSchema = z.object({
  removals: z.array(worktreeRemovalSchema)
})

/**
 * Whether removing this now would take work the list the person confirmed
 * never showed them.
 *
 * Only ever in that direction. A Checkout that has become *safer* since it was
 * read — the changes committed, the commits pushed — is removed without
 * complaint: the person was warned about more than is there, which is not a
 * reason to refuse what they asked for. What is refused is a Checkout that has
 * gained something, and a Checkout that could be read then and cannot be now,
 * because "I could not check" is not "there is nothing to lose".
 */
export function holdsUnshownWork(shown: WorktreeContents, now: WorktreeContents): boolean {
  // The list already said it did not know, and the person confirmed anyway.
  if (shown.status === 'unreadable') return false
  if (now.status === 'unreadable') {
    return !shown.uncommittedChanges && !shown.commitsOnlyHere
  }
  return (
    (now.uncommittedChanges && !shown.uncommittedChanges) ||
    (now.commitsOnlyHere && !shown.commitsOnlyHere)
  )
}
export type WorktreeRemovalResult = z.infer<typeof worktreeRemovalResultSchema>

/**
 * A disk figure in the units a person reads. Binary units, because that is
 * what every other developer tool on the machine reports, and one decimal
 * below ten so `1.4 GB` does not read as `1 GB`.
 */
export function describeDiskSize(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'] as const
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  if (unit === 0) return `${String(Math.round(value))} bytes`
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unit] ?? 'bytes'}`
}
