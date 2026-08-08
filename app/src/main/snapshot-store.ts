import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  diffSnapshots,
  snapshotCheckout,
  type CheckoutSnapshot,
  type SnapshotComparison
} from './git'

/**
 * The Git objects this app keeps for itself, one store per Session (ADR 0006).
 *
 * A Session's store holds the tree of its Checkout before and after every Run,
 * so a Run can be put back long after it ended. It is content-addressed
 * because it is a Git object directory: two Runs that left a file identical
 * store that file once, and a Session with a hundred Runs over one repository
 * costs roughly what one copy of that repository costs.
 *
 * It follows Session lifetime exactly. Archiving a Session keeps it — an
 * archived Session is one somebody may come back to, and coming back to find
 * undo gone would make Archive quietly destructive. Deleting a Session removes
 * it, because deleting is the one act that means gone.
 */

const STORES = 'session-snapshots'
const RUNS = 'runs'

/** What was captured for one Run, kept so a restart can still read it. */
export const runSnapshotRecordSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  /** The directory the trees describe, absolute as the Session recorded it. */
  checkout: z.string().min(1),
  /**
   * The Checkout before the Harness was contacted. Null when the capture was
   * skipped — a Checkout State that made a stable read unsafe, or no Git at
   * all — which is what makes undo honestly unavailable rather than wrong.
   */
  before: z.string().min(1).nullable(),
  /**
   * The Checkout as the Run left it, written before any temporary state is
   * cleaned up. Null while the Run is still going, and null forever for a Run
   * the app never got to conclude and never recovered.
   */
  after: z.string().min(1).nullable(),
  capturedAt: z.string().datetime()
})
export type RunSnapshotRecord = z.infer<typeof runSnapshotRecordSchema>

export class SessionSnapshotStore {
  /**
   * @param privateRoot The app-owned directory Runs already live under. The
   *   stores sit beside them rather than inside a Run's own directory: a Run
   *   that ends badly has its directory removed, and the answer to "what did
   *   this change" must outlive that.
   */
  constructor(
    private readonly privateRoot: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Where one Session's objects live. Also what deleting a Session removes. */
  directoryFor(sessionId: string): string {
    return join(this.privateRoot, STORES, encodeURIComponent(sessionId))
  }

  /**
   * Records the Checkout as it is now, under one half of one Run.
   *
   * The tree is written to the store and the record updated afterwards, so a
   * crash between them leaves objects nobody names — which costs disk and
   * nothing else — rather than a record naming a tree that was never written.
   */
  async capture(input: {
    sessionId: string
    runId: string
    checkout: string
    phase: 'before' | 'after'
  }): Promise<CheckoutSnapshot> {
    const directory = this.directoryFor(input.sessionId)
    const snapshot = await snapshotCheckout(input.checkout, directory)
    const existing = await this.read(input.sessionId, input.runId)
    const tree = snapshot.status === 'taken' ? snapshot.tree : null
    await this.write({
      sessionId: input.sessionId,
      runId: input.runId,
      checkout: input.checkout,
      before: input.phase === 'before' ? tree : (existing?.before ?? null),
      after: input.phase === 'after' ? tree : (existing?.after ?? null),
      capturedAt: this.now().toISOString()
    })
    return snapshot
  }

  /** What was captured for one Run, or nothing anybody can act on. */
  read(sessionId: string, runId: string): Promise<RunSnapshotRecord | null> {
    return this.readPath(this.recordPath(sessionId, runId))
  }

  /** Compares the Session's original baseline with the publishable Checkout now. */
  async compareCurrent(sessionId: string, checkout: string): Promise<SnapshotComparison | null> {
    try {
      const runs = join(this.directoryFor(sessionId), RUNS)
      const records = (
        await Promise.all(
          (await readdir(runs, { withFileTypes: true }))
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map((entry) => this.readPath(join(runs, entry.name)))
        )
      )
        .filter((record): record is RunSnapshotRecord => record !== null)
        .filter((record) => record.checkout === checkout && record.before !== null)
        .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
      const baseline = records[0]?.before
      if (!baseline) return null
      const current = await snapshotCheckout(checkout, this.directoryFor(sessionId))
      return await diffSnapshots(
        checkout,
        this.directoryFor(sessionId),
        { status: 'taken', tree: baseline },
        current
      )
    } catch {
      return null
    }
  }

  /**
   * Removes everything kept for one Session. Called when the Session is
   * deleted — never when it is archived — and safe to call for a Session that
   * never had a store.
   */
  async forget(sessionId: string): Promise<void> {
    await rm(this.directoryFor(sessionId), { recursive: true, force: true })
  }

  /**
   * Removes stores whose Session no longer exists. A delete that crashed
   * halfway, or a Session removed by a build that did not keep stores, would
   * otherwise leave objects nobody can ever reach or account for.
   */
  async pruneUnknown(known: ReadonlySet<string>): Promise<void> {
    const root = join(this.privateRoot, STORES)
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (known.has(decodeURIComponent(entry.name))) continue
      await rm(join(root, entry.name), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Clears short-lived working files a crash left behind mid-capture. */
  async clearScratch(sessionId: string): Promise<void> {
    await rm(join(this.directoryFor(sessionId), 'scratch'), {
      recursive: true,
      force: true
    }).catch(() => undefined)
  }

  private recordPath(sessionId: string, runId: string): string {
    return join(this.directoryFor(sessionId), RUNS, `${encodeURIComponent(runId)}.json`)
  }

  /**
   * One record, or nothing. A record that is absent, unreadable, or not the
   * shape it claims is all the same answer here: there is nothing to restore
   * from, which is reported as undo being unavailable rather than guessed at.
   */
  private async readPath(path: string): Promise<RunSnapshotRecord | null> {
    const text = await readFile(path, 'utf8').catch(() => '')
    if (!text) return null
    try {
      const parsed = runSnapshotRecordSchema.safeParse(JSON.parse(text))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  /** Whole or not at all: a half-written record would name a tree twice over. */
  private async write(record: RunSnapshotRecord): Promise<void> {
    const path = this.recordPath(record.sessionId, record.runId)
    await mkdir(join(this.directoryFor(record.sessionId), RUNS), { recursive: true, mode: 0o700 })
    const staged = `${path}.staged`
    let renamed = false
    try {
      await writeFile(staged, JSON.stringify(record), { mode: 0o600 })
      await rename(staged, path)
      renamed = true
    } finally {
      if (!renamed) await rm(staged, { force: true }).catch(() => undefined)
    }
  }
}
