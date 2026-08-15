import { useEffect, useState } from 'react'
import {
  describeDuration,
  MAX_RECORDED_CHECKOUTS,
  type CheckoutCost,
  type CheckoutCostRecord,
  type WorktreeBootstrapSkipReason
} from '@shared/contract'
import { moment } from '@renderer/lib/utils'

/**
 * What isolated Checkouts have cost on this Mac (MEM-136).
 *
 * ADR 0004 chose to edit the Project in place on one asserted price — a fresh
 * worktree has no dependencies, so its first command either fails or costs a
 * full install — and carrying those dependencies in is the answer to it. This
 * is where the person checks the arithmetic themselves, on their own machine
 * and their own repositories, rather than taking a sentence in a document at
 * its word.
 *
 * The first command is drawn beside the timing rather than under it, because
 * it is the half that decides what the timing meant: a Checkout prepared in
 * half a second whose first command then failed did not cost half a second.
 */

/** What a skip reason means, in the person's terms rather than the enum's. */
const SKIP_TEXT: Record<WorktreeBootstrapSkipReason, string> = {
  'invalid-path': 'named an invalid path',
  missing: 'was no longer there',
  tracked: 'is tracked by Git',
  'not-ignored': 'is not ignored',
  symlink: 'is a symlink',
  'not-regular': 'is neither a file nor a directory',
  'permission-denied': 'could not be read',
  'destination-exists': 'was already in the Checkout',
  'clone-unsupported': 'is on a filesystem that cannot clone',
  'copy-failed': 'could not be copied'
}

function carriedText(cost: CheckoutCost): string {
  const parts: string[] = []
  if (cost.carried.directories > 0) {
    parts.push(
      `${String(cost.carried.directories)} director${cost.carried.directories === 1 ? 'y' : 'ies'}`
    )
  }
  if (cost.carried.files > 0) {
    parts.push(`${String(cost.carried.files)} file${cost.carried.files === 1 ? '' : 's'}`)
  }
  return parts.length === 0 ? 'Carried nothing' : `Carried ${parts.join(' and ')}`
}

/**
 * The one line that answers the question. Never knowing and failing are kept
 * apart on purpose: a Checkout no Run has run a command in yet says nothing
 * about whether it works, and drawing that as a pass would be the record
 * quietly agreeing with the assertion it exists to test.
 */
function firstCommandText(cost: CheckoutCost): { text: string; tone: 'good' | 'bad' | 'quiet' } {
  const first = cost.firstCommand
  if (first === null) return { text: 'No command has run here yet', tone: 'quiet' }
  const took = first.durationMs === null ? '' : ` in ${describeDuration(first.durationMs)}`
  switch (first.outcome) {
    case 'succeeded':
      return { text: `First command succeeded${took}`, tone: 'good' }
    case 'failed':
      return {
        text: `First command failed${first.exitCode === null ? '' : ` (exit ${String(first.exitCode)})`}${took}`,
        tone: 'bad'
      }
    case 'interrupted':
      return { text: 'First command was interrupted before it reported', tone: 'quiet' }
  }
}

/** The last segment of a Checkout path: how the person knows the directory. */
function checkoutName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

export function CheckoutCostsPanel(): React.JSX.Element {
  const [record, setRecord] = useState<CheckoutCostRecord | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let live = true
    window.shell
      .getCheckoutCosts()
      .then((read) => {
        if (live) setRecord(read)
      })
      .catch(() => {
        if (live) setError(true)
      })
    return () => {
      live = false
    }
  }, [])

  const checkouts = record?.checkouts ?? []

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl">
        <section aria-labelledby="checkout-costs-title">
          <h3 id="checkout-costs-title" className="text-xs font-medium">
            What isolated Checkouts cost
          </h3>
          <p className="mt-1.5 max-w-xl text-2xs leading-relaxed text-muted-foreground">
            An isolated Checkout is prepared by cloning the Project&rsquo;s ignored directories into
            it, so it arrives with its dependencies rather than needing an install. This is what
            that has actually cost here, and whether the Checkout worked afterwards.
          </p>
          <p className="mt-1.5 max-w-xl text-2xs leading-relaxed text-muted-foreground">
            Kept on this Mac in Argos&rsquo;s own folder, for the last {MAX_RECORDED_CHECKOUTS}{' '}
            Checkouts. Argos sends none of it anywhere, and nothing here is measured by asking
            anything outside this machine.
          </p>

          {record === null && !error && (
            <p className="mt-3 text-xs text-muted-foreground">Reading the record…</p>
          )}
          {error && <p className="mt-3 text-xs text-destructive">The record could not be read.</p>}
          {record !== null && checkouts.length === 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              No isolated Checkout has been bootstrapped yet, so there is nothing to compare.
            </p>
          )}

          {checkouts.length > 0 && (
            <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface">
              {checkouts.map((cost) => {
                const first = firstCommandText(cost)
                return (
                  <li key={cost.path} className="px-4 py-3">
                    <div className="flex items-baseline gap-3">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={cost.path}>
                        {checkoutName(cost.path)}
                      </span>
                      <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                        {/* A bootstrap nobody timed is said so rather than
                            drawn as one that took no time — and `0 ms` is the
                            second of those, not the first. */}
                        {cost.durationMs === null ? 'not timed' : describeDuration(cost.durationMs)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-2xs text-muted-foreground">
                      {carriedText(cost)} · {moment(cost.at)}
                    </p>
                    <p
                      className={
                        first.tone === 'good'
                          ? 'mt-0.5 text-2xs text-positive'
                          : first.tone === 'bad'
                            ? 'mt-0.5 text-2xs text-destructive'
                            : 'mt-0.5 text-2xs text-muted-foreground'
                      }
                    >
                      {first.text}
                    </p>
                    {cost.skipped.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {cost.skipped.map((tally) => (
                          <li key={tally.reason} className="text-2xs text-muted-foreground">
                            {tally.count} skipped — {SKIP_TEXT[tally.reason]}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
