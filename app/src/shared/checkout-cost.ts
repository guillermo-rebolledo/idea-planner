import { z } from 'zod'
import { worktreeBootstrapSkipReasonSchema, type WorktreeBootstrapResult } from './checkout'

/**
 * What one isolated Checkout cost to become usable.
 *
 * ADR 0004 rejected isolation as the baseline on a cost asserted in a single
 * sentence — "a fresh worktree has no `node_modules`, `.env`, or build cache,
 * so the first test run either fails or costs a full install" — and never
 * measured. Carrying the Project's ignored directories in is the answer to
 * that sentence, and every decision after it rests on the sentence being
 * true. The person running Argos should be able to find out whether it is.
 *
 * So: how long the bootstrap took, how much it carried, what it refused to
 * carry and why, and how the first command a Run ran in the Checkout went.
 * The last one is the question, not an adornment on it — a Checkout prepared
 * in two seconds that then cannot run the Project's own tests was not cheap,
 * it was broken, and a record of timings alone would report that as a success.
 *
 * It stays on the machine. Argos has no telemetry, this is not the start of
 * one, and nothing here is ever sent anywhere: the only reader is the person
 * sitting in front of it.
 */

/**
 * How many Checkouts the record keeps. A fixed ceiling rather than a window of
 * days, because the point is that this cannot grow with how much work has been
 * done in the app — a person who has run a thousand Sessions has the same
 * sized record as one who has run two, and the oldest entries are the ones
 * nobody was going to read.
 */
export const MAX_RECORDED_CHECKOUTS = 50

/**
 * How the first command a Run ran in a bootstrapped Checkout went.
 *
 * `interrupted` is deliberately neither of the other two: a Run stopped
 * mid-command never reported how it went, and calling that a failure would
 * blame the bootstrap for the person clicking Stop.
 */
export const checkoutFirstCommandOutcomeSchema = z.enum(['succeeded', 'failed', 'interrupted'])
export type CheckoutFirstCommandOutcome = z.infer<typeof checkoutFirstCommandOutcomeSchema>

/**
 * The first command, as this record keeps it.
 *
 * Deliberately without the command itself. The Conversation already holds
 * that, redacted, where the person reads it in context; here it would be a
 * second place a shell line — the one input to the app that routinely carries
 * a token in an argument — comes to rest, in a file whose whole justification
 * is that it is cheap to keep forever. Whether the Checkout worked is the
 * question, and the outcome answers it.
 */
export const checkoutFirstCommandSchema = z.object({
  outcome: checkoutFirstCommandOutcomeSchema,
  /** When the command finished. */
  at: z.string().datetime(),
  /** As the Harness reported it. Null when it says only that it failed. */
  exitCode: z.number().int().nullable().default(null),
  /** How long it ran, when the Harness or the Conversation could say. */
  durationMs: z.number().int().nonnegative().nullable().default(null)
})
export type CheckoutFirstCommand = z.infer<typeof checkoutFirstCommandSchema>

/** How much a bootstrap carried, in the two units Git itself reports. */
export const carriedCountsSchema = z.object({
  /**
   * Whole directories, each cloned copy-on-write. Git collapses a wholly
   * ignored directory into one name, so this counts `node_modules`, not the
   * hundred thousand files in it — which is also why it is the honest figure
   * for what the bootstrap did rather than an understatement of it.
   */
  directories: z.number().int().nonnegative(),
  /** Ignored configuration files, each copied. */
  files: z.number().int().nonnegative()
})
export type CarriedCounts = z.infer<typeof carriedCountsSchema>

/** One skip reason and how many paths gave it. */
export const skipTallySchema = z.object({
  reason: worktreeBootstrapSkipReasonSchema,
  count: z.number().int().positive()
})
export type SkipTally = z.infer<typeof skipTallySchema>

/**
 * One bootstrapped Checkout's entry. Counts and typed reasons rather than the
 * paths themselves: the Session's own bootstrap result already names those,
 * and this has to stay the same size whether a Project carries one ignored
 * file or forty thousand.
 */
export const checkoutCostSchema = z.object({
  /** The Checkout this measures, which is also how a later Run finds it. */
  path: z.string().min(1),
  /** When the bootstrap ran. */
  at: z.string().datetime(),
  /** How long it took, start to finish, including every attempt at it. */
  durationMs: z.number().int().nonnegative(),
  carried: carriedCountsSchema,
  /** What was not carried, tallied by the reason the bootstrap gave. */
  skipped: z.array(skipTallySchema),
  /**
   * Null until a Run runs a command here — which is not the same as a Checkout
   * whose first command failed, and the surface must not read them as one.
   */
  firstCommand: checkoutFirstCommandSchema.nullable().default(null)
})
export type CheckoutCost = z.infer<typeof checkoutCostSchema>

/** The whole record, newest first. */
export const checkoutCostRecordSchema = z.object({
  checkouts: z.array(checkoutCostSchema).max(MAX_RECORDED_CHECKOUTS)
})
export type CheckoutCostRecord = z.infer<typeof checkoutCostRecordSchema>

export const EMPTY_CHECKOUT_COST_RECORD: CheckoutCostRecord = { checkouts: [] }

/**
 * How much a bootstrap carried, read off the names it reported. A carried
 * directory keeps Git's trailing slash, which is the only thing that tells the
 * two apart — and the reason the bootstrap result keeps that slash at all.
 */
export function carriedCounts(result: WorktreeBootstrapResult): CarriedCounts {
  const directories = result.copied.filter((path) => path.endsWith('/')).length
  return { directories, files: result.copied.length - directories }
}

/** What was skipped, gathered by reason, most-refused first. */
export function skipTallies(result: WorktreeBootstrapResult): SkipTally[] {
  const counts = new Map<SkipTally['reason'], number>()
  for (const entry of result.skipped) {
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1)
  }
  return [...counts]
    .map(([reason, count]) => ({ reason, count }))
    .sort(
      (left, right) => right.count - left.count || left.reason.localeCompare(right.reason, 'en')
    )
}

/** One bootstrap, reduced to what the record keeps of it. */
export function measureBootstrap(input: {
  path: string
  at: string
  result: WorktreeBootstrapResult
}): CheckoutCost {
  return {
    path: input.path,
    at: input.at,
    // A bootstrap that could not read its own clock is not a free one; it is
    // one nobody timed. Zero is the only number this can honestly carry, and
    // the surface says "not timed" rather than drawing it as instant.
    durationMs: input.result.durationMs ?? 0,
    carried: carriedCounts(input.result),
    skipped: skipTallies(input.result),
    firstCommand: null
  }
}

/**
 * The record with this Checkout's cost in it, newest first and bounded.
 *
 * A path already in the record is replaced rather than added beside: a
 * Worktree can be reclaimed and a new one cut on the same branch name, and two
 * entries for one directory would leave the older claiming a first command
 * that happened in a Checkout that no longer exists.
 */
export function recordCheckoutCost(
  record: CheckoutCostRecord,
  cost: CheckoutCost
): CheckoutCostRecord {
  return {
    checkouts: [cost, ...record.checkouts.filter((entry) => entry.path !== cost.path)].slice(
      0,
      MAX_RECORDED_CHECKOUTS
    )
  }
}

/**
 * The record with the first command run in this Checkout noted against it.
 *
 * Only the first, and only ever once: the question is whether the Checkout
 * arrived usable, which the hundredth command in it — run after an agent has
 * spent an hour installing whatever was missing — cannot answer. A Checkout
 * this record has never heard of is left alone rather than invented, because
 * an entry with a command and no bootstrap would be a cost nobody measured.
 */
export function recordFirstCommand(
  record: CheckoutCostRecord,
  path: string,
  command: CheckoutFirstCommand
): CheckoutCostRecord {
  return {
    checkouts: record.checkouts.map((entry) =>
      entry.path === path && entry.firstCommand === null
        ? { ...entry, firstCommand: command }
        : entry
    )
  }
}

/**
 * A duration as a person reads one. Sub-second in milliseconds because that is
 * the range this whole record exists to distinguish from a full install, and
 * minutes once it is past them, because "94382 ms" is a number nobody converts.
 */
export function describeDuration(milliseconds: number): string {
  const value = Math.max(0, milliseconds)
  if (value < 1000) return `${String(Math.round(value))} ms`
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return seconds === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(seconds)} s`
}
