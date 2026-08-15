import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeBootstrapResult } from '@shared/checkout'
import { MAX_RECORDED_CHECKOUTS } from '@shared/checkout-cost'
import { CheckoutCostStore } from './checkout-cost-store'

let stateDir: string
let store: CheckoutCostStore

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'checkout-costs-'))
  store = new CheckoutCostStore(stateDir)
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

function result(over: Partial<WorktreeBootstrapResult> = {}): WorktreeBootstrapResult {
  return {
    outcome: 'copied',
    copied: ['node_modules/', '.env.local'],
    skipped: [],
    provenance: null,
    durationMs: 640,
    ...over
  }
}

async function bootstrap(path: string, over: Partial<WorktreeBootstrapResult> = {}): Promise<void> {
  await store.recordBootstrap({ path, at: '2026-08-10T04:32:19.000Z', result: result(over) })
}

describe('the record of what Checkouts cost', () => {
  it('is empty before anything has been bootstrapped', async () => {
    await expect(store.read()).resolves.toEqual({ checkouts: [] })
  })

  it('keeps how long a bootstrap took, what it carried, and what it refused', async () => {
    await bootstrap('/w/fix-crash', {
      outcome: 'partial',
      copied: ['node_modules/', 'packages/web/node_modules/', '.env.local'],
      skipped: [
        { path: '.env.tracked', reason: 'tracked' },
        { path: 'target/', reason: 'clone-unsupported' },
        { path: 'build/', reason: 'clone-unsupported' }
      ],
      durationMs: 1840
    })

    await expect(store.read()).resolves.toEqual({
      checkouts: [
        {
          path: '/w/fix-crash',
          at: '2026-08-10T04:32:19.000Z',
          durationMs: 1840,
          carried: { directories: 2, files: 1 },
          skipped: [
            { reason: 'clone-unsupported', count: 2 },
            { reason: 'tracked', count: 1 }
          ],
          firstCommand: null
        }
      ]
    })
  })

  // Zero is a real measurement and null is the absence of one. Asserted
  // through the file because JSON is where a nullable number is most easily
  // lost, and losing it would make the fastest Checkouts read as the ones
  // nobody managed to time.
  it('keeps a bootstrap that took no measurable time apart from one nobody timed', async () => {
    await bootstrap('/w/instant', { durationMs: 0 })
    await bootstrap('/w/untimed', { durationMs: null })

    const record = await store.read()
    expect(record.checkouts.find((entry) => entry.path === '/w/instant')?.durationMs).toBe(0)
    expect(record.checkouts.find((entry) => entry.path === '/w/untimed')?.durationMs).toBeNull()
  })

  // The actual question. A Checkout prepared in half a second whose first
  // command then failed did not cost half a second — it was not usable.
  it('records how the first command a Run ran in a Checkout went', async () => {
    await bootstrap('/w/fix-crash')

    await store.recordFirstCommand('/w/fix-crash', {
      outcome: 'failed',
      at: '2026-08-10T04:33:04.000Z',
      exitCode: 127,
      durationMs: 220
    })

    const record = await store.read()
    expect(record.checkouts[0]?.firstCommand).toEqual({
      outcome: 'failed',
      at: '2026-08-10T04:33:04.000Z',
      exitCode: 127,
      durationMs: 220
    })
  })

  it('leaves a Checkout it has never heard of alone', async () => {
    await bootstrap('/w/fix-crash')

    await store.recordFirstCommand('/w/somewhere-else', {
      outcome: 'succeeded',
      at: '2026-08-10T04:33:04.000Z',
      exitCode: 0,
      durationMs: 10
    })

    const record = await store.read()
    expect(record.checkouts).toHaveLength(1)
    expect(record.checkouts[0]?.firstCommand).toBeNull()
  })

  // The bound is an acceptance criterion, not an optimization: a person who
  // has run a thousand Sessions must have the same sized record as one who
  // has run two.
  it('stays bounded however many Checkouts are bootstrapped', async () => {
    for (let index = 0; index < MAX_RECORDED_CHECKOUTS + 25; index++) {
      await bootstrap(`/w/checkout-${String(index)}`)
    }

    const record = await store.read()
    expect(record.checkouts).toHaveLength(MAX_RECORDED_CHECKOUTS)
    expect(record.checkouts[0]?.path).toBe(`/w/checkout-${String(MAX_RECORDED_CHECKOUTS + 24)}`)
  })

  // Two Sessions can be started seconds apart, and a read-modify-write racing
  // another would silently drop one of them.
  it('loses no Checkout when several are bootstrapped at once', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_unused, index) => bootstrap(`/w/parallel-${String(index)}`))
    )

    const record = await store.read()
    expect(record.checkouts).toHaveLength(12)
  })

  // A diagnostic is not the person's work: a file this version cannot read is
  // started again rather than allowed to break the surface that shows it.
  it('starts again from an unreadable record rather than failing', async () => {
    await writeFile(join(stateDir, 'checkout-costs.json'), 'not json at all')

    await expect(store.read()).resolves.toEqual({ checkouts: [] })

    await bootstrap('/w/fix-crash')
    await expect(store.read()).resolves.toMatchObject({ checkouts: [{ path: '/w/fix-crash' }] })
  })

  it('leaves no staged file behind', async () => {
    await bootstrap('/w/fix-crash')

    await expect(
      readFile(join(stateDir, 'checkout-costs.json.staged'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  /*
   * Argos has no telemetry and this record does not introduce one. Asserted
   * rather than described, because "we did not add a network call" is exactly
   * the kind of claim that stops being true without anybody noticing.
   */
  it('makes no network call to write or read the record', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch')
    try {
      await bootstrap('/w/fix-crash')
      await store.recordFirstCommand('/w/fix-crash', {
        outcome: 'succeeded',
        at: '2026-08-10T04:33:04.000Z',
        exitCode: 0,
        durationMs: 10
      })
      await store.read()

      expect(fetched).not.toHaveBeenCalled()
    } finally {
      fetched.mockRestore()
    }
  })

  // Everything durable here is a path this app chose, a clock reading, a count
  // and a typed reason. No file contents, and no command line.
  it('writes nothing but names, counts, and typed outcomes', async () => {
    await bootstrap('/w/fix-crash', {
      outcome: 'partial',
      skipped: [{ path: '/etc/private-secret.env', reason: 'permission-denied' }]
    })
    await store.recordFirstCommand('/w/fix-crash', {
      outcome: 'failed',
      at: '2026-08-10T04:33:04.000Z',
      exitCode: 1,
      durationMs: 10
    })

    const written = await readFile(join(stateDir, 'checkout-costs.json'), 'utf8')
    expect(written).not.toContain('private-secret')
    expect(written).not.toContain('node_modules')
    expect(written).toContain('permission-denied')
  })
})
