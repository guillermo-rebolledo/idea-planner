import { describe, expect, it } from 'vitest'
import type { WorktreeBootstrapResult } from './checkout'
import {
  carriedCounts,
  describeDuration,
  EMPTY_CHECKOUT_COST_RECORD,
  MAX_RECORDED_CHECKOUTS,
  measureBootstrap,
  recordCheckoutCost,
  recordFirstCommand,
  skipTallies,
  type CheckoutCostRecord,
  type CheckoutFirstCommand
} from './checkout-cost'

function bootstrapResult(over: Partial<WorktreeBootstrapResult> = {}): WorktreeBootstrapResult {
  return {
    outcome: 'copied',
    copied: [],
    skipped: [],
    provenance: null,
    durationMs: 0,
    ...over
  }
}

function cost(
  path: string,
  at = '2026-08-10T04:32:19.000Z'
): CheckoutCostRecord['checkouts'][number] {
  return measureBootstrap({ path, at, result: bootstrapResult({ durationMs: 12 }) })
}

const SUCCEEDED: CheckoutFirstCommand = {
  outcome: 'succeeded',
  at: '2026-08-10T04:33:00.000Z',
  exitCode: 0,
  durationMs: 4200
}

describe('what a bootstrap carried', () => {
  // The trailing slash is the only thing separating a cloned dependency tree
  // from a copied `.env`, which is why the bootstrap result keeps it.
  it('counts a carried directory apart from a carried file', () => {
    const result = bootstrapResult({
      copied: ['node_modules/', 'packages/web/node_modules/', '.env.local']
    })

    expect(carriedCounts(result)).toEqual({ directories: 2, files: 1 })
  })

  it('counts nothing carried as nothing rather than as one empty name', () => {
    expect(carriedCounts(bootstrapResult())).toEqual({ directories: 0, files: 0 })
  })

  // Tallies, not paths: a Project with forty thousand ignored files must not
  // produce a record forty thousand lines longer than one with two.
  it('gathers skips by reason, most-refused first', () => {
    const result = bootstrapResult({
      outcome: 'partial',
      copied: ['.env.local'],
      skipped: [
        { path: 'a', reason: 'tracked' },
        { path: 'b', reason: 'not-ignored' },
        { path: 'c', reason: 'tracked' },
        { path: 'd', reason: 'tracked' }
      ]
    })

    expect(skipTallies(result)).toEqual([
      { reason: 'tracked', count: 3 },
      { reason: 'not-ignored', count: 1 }
    ])
  })

  // Zero is the only number an untimed bootstrap can honestly carry, and the
  // surface draws it as "not timed" rather than as instant.
  it('reads a bootstrap nobody timed as no measurement', () => {
    const measured = measureBootstrap({
      path: '/w/fix',
      at: '2026-08-10T04:32:19.000Z',
      result: bootstrapResult({ durationMs: null })
    })

    expect(measured.durationMs).toBe(0)
    expect(measured.firstCommand).toBeNull()
  })
})

describe('the record of what Checkouts cost', () => {
  it('keeps the newest first', () => {
    const record = recordCheckoutCost(
      recordCheckoutCost(EMPTY_CHECKOUT_COST_RECORD, cost('/w/first')),
      cost('/w/second')
    )

    expect(record.checkouts.map((entry) => entry.path)).toEqual(['/w/second', '/w/first'])
  })

  // A Worktree can be reclaimed and a new one cut on the same branch name.
  // Two entries for one directory would leave the older one claiming a first
  // command that happened in a Checkout nobody can look at any more.
  it('replaces the entry for a Checkout bootstrapped again rather than adding beside it', () => {
    const first = recordCheckoutCost(EMPTY_CHECKOUT_COST_RECORD, cost('/w/fix'))
    const withCommand = recordFirstCommand(first, '/w/fix', SUCCEEDED)

    const again = recordCheckoutCost(withCommand, cost('/w/fix', '2026-08-11T09:00:00.000Z'))

    expect(again.checkouts).toHaveLength(1)
    expect(again.checkouts[0]?.at).toBe('2026-08-11T09:00:00.000Z')
    expect(again.checkouts[0]?.firstCommand).toBeNull()
  })

  // The bound is the whole point: the record must not grow with how much work
  // has been done in the app.
  it('drops the oldest once it is full, however many Sessions there have been', () => {
    let record = EMPTY_CHECKOUT_COST_RECORD
    for (let index = 0; index < MAX_RECORDED_CHECKOUTS * 4; index++) {
      record = recordCheckoutCost(record, cost(`/w/checkout-${String(index)}`))
    }

    expect(record.checkouts).toHaveLength(MAX_RECORDED_CHECKOUTS)
    expect(record.checkouts[0]?.path).toBe(`/w/checkout-${String(MAX_RECORDED_CHECKOUTS * 4 - 1)}`)
    expect(record.checkouts.at(-1)?.path).toBe(`/w/checkout-${String(MAX_RECORDED_CHECKOUTS * 3)}`)
  })
})

describe('whether the Checkout was usable', () => {
  it('notes the first command against the Checkout it ran in', () => {
    const record = recordCheckoutCost(
      recordCheckoutCost(EMPTY_CHECKOUT_COST_RECORD, cost('/w/other')),
      cost('/w/fix')
    )

    const noted = recordFirstCommand(record, '/w/fix', SUCCEEDED)

    expect(noted.checkouts.find((entry) => entry.path === '/w/fix')?.firstCommand).toEqual(
      SUCCEEDED
    )
    expect(noted.checkouts.find((entry) => entry.path === '/w/other')?.firstCommand).toBeNull()
  })

  // The hundredth command — run after an agent has spent an hour installing
  // whatever was missing — says nothing about whether the Checkout arrived
  // usable, which is the only question this record asks.
  it('keeps the first command and ignores every one after it', () => {
    const record = recordFirstCommand(
      recordCheckoutCost(EMPTY_CHECKOUT_COST_RECORD, cost('/w/fix')),
      '/w/fix',
      { outcome: 'failed', at: '2026-08-10T04:33:00.000Z', exitCode: 127, durationMs: 90 }
    )

    const later = recordFirstCommand(record, '/w/fix', SUCCEEDED)

    expect(later.checkouts[0]?.firstCommand).toMatchObject({ outcome: 'failed', exitCode: 127 })
  })

  // An entry with a command and no bootstrap would be a cost nobody measured.
  it('invents no entry for a Checkout the record has never heard of', () => {
    const record = recordCheckoutCost(EMPTY_CHECKOUT_COST_RECORD, cost('/w/fix'))

    expect(recordFirstCommand(record, '/w/elsewhere', SUCCEEDED)).toEqual(record)
  })
})

describe('reading a duration', () => {
  it('stays in the units the reader thinks in', () => {
    expect(describeDuration(0)).toBe('0 ms')
    expect(describeDuration(430)).toBe('430 ms')
    expect(describeDuration(1500)).toBe('1.5 s')
    expect(describeDuration(59_400)).toBe('59.4 s')
    expect(describeDuration(120_000)).toBe('2 min')
    expect(describeDuration(94_382)).toBe('1 min 34 s')
  })

  // A clock that stepped backwards mid-bootstrap is not a negative cost.
  it('never reports a negative duration', () => {
    expect(describeDuration(-5)).toBe('0 ms')
  })
})
