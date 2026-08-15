import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  checkoutCostRecordSchema,
  EMPTY_CHECKOUT_COST_RECORD,
  measureBootstrap,
  recordCheckoutCost,
  recordFirstCommand,
  type CheckoutCostRecord,
  type CheckoutFirstCommand
} from '@shared/checkout-cost'
import type { WorktreeBootstrapResult } from '@shared/checkout'

const RECORD = 'checkout-costs.json'

/**
 * What creating isolated Checkouts on this machine has actually cost, kept in
 * one bounded file in the app's own state directory.
 *
 * One file rather than one per Checkout, because the whole record is read at
 * once and written by two callers that must not disagree about which entries
 * the bound has already dropped. Every write goes through one promise chain
 * for the same reason: two Sessions can be started seconds apart, and a
 * read-modify-write racing another would silently lose one of them.
 *
 * Nothing here leaves the machine. There is no fetch, no upload, and no
 * caller outside Main's own IPC handler — the record exists so the person can
 * check ADR 0004's arithmetic themselves, not so anybody else can.
 */
export class CheckoutCostStore {
  /** Serializes read-modify-write so concurrent bootstraps cannot lose one. */
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly privateRoot: string) {}

  async read(): Promise<CheckoutCostRecord> {
    const text = await readFile(join(this.privateRoot, RECORD), 'utf8').catch(() => '')
    if (!text) return EMPTY_CHECKOUT_COST_RECORD
    try {
      const parsed = checkoutCostRecordSchema.safeParse(JSON.parse(text))
      // A record this version cannot read is a diagnostic, not the person's
      // work: starting it again costs nothing anybody will miss.
      return parsed.success ? parsed.data : EMPTY_CHECKOUT_COST_RECORD
    } catch {
      return EMPTY_CHECKOUT_COST_RECORD
    }
  }

  /** What one bootstrap of one Checkout cost, replacing any earlier entry. */
  async recordBootstrap(input: {
    path: string
    at: string
    result: WorktreeBootstrapResult
  }): Promise<void> {
    await this.update((record) => recordCheckoutCost(record, measureBootstrap(input)))
  }

  /**
   * How the first command a Run ran in a bootstrapped Checkout went. A
   * Checkout with no entry, or one whose first command is already recorded, is
   * left exactly as it was.
   */
  async recordFirstCommand(path: string, command: CheckoutFirstCommand): Promise<void> {
    await this.update((record) => recordFirstCommand(record, path, command))
  }

  private async update(change: (record: CheckoutCostRecord) => CheckoutCostRecord): Promise<void> {
    const queued = this.writes.then(async () => {
      const next = change(await this.read())
      await this.write(next)
    })
    // Held so the next caller waits for this one, and swallowed so one failed
    // write does not reject every write after it.
    this.writes = queued.catch(() => undefined)
    await queued
  }

  private async write(record: CheckoutCostRecord): Promise<void> {
    const path = join(this.privateRoot, RECORD)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const staged = `${path}.staged`
    let renamed = false
    try {
      await writeFile(staged, JSON.stringify(checkoutCostRecordSchema.parse(record), null, 2), {
        mode: 0o600
      })
      await rename(staged, path)
      renamed = true
    } finally {
      if (!renamed) await rm(staged, { force: true }).catch(() => undefined)
    }
  }
}
