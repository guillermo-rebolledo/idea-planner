import { randomUUID } from 'node:crypto'
import { checkoutDirectory, type SessionSummary } from '@shared/contract'
import { MAX_UNDO_OUTCOMES, type UndoOutcome } from '@shared/conversation'
import {
  applyRunUndoInputSchema,
  isRestored,
  OUTCOME_OF_CLASSIFICATION,
  prepareRunUndoInputSchema,
  type ApplyRunUndoInput,
  type PrepareRunUndoInput,
  type RunUndoApplication,
  type RunUndoPreparation,
  type UndoMode,
  type UndoPath
} from '@shared/run-undo'
import { applyInversePatch, currentTreeDigest, observeCheckoutState, planRestoration } from './git'
import type { SessionSnapshotStore } from './snapshot-store'

/**
 * Undoing a Run: reading what putting it back would mean, and — separately,
 * and only when the person says so — doing it (ADR 0006).
 *
 * The two halves are deliberately two calls with a handle between them. What
 * is reviewed and what is applied must be provably the same operation against
 * the same tree, and the only way to prove that is to bind the review to a
 * digest and measure again at the last possible moment. A window that could
 * name its own patch would make that binding decoration.
 */

/** How much of the patch crosses to the window. Applying uses the whole one. */
const MAX_SHOWN_PATCH_BYTES = 512 * 1024

/**
 * How many reviews may stand at once. Each holds a whole patch, and opening
 * the dialog and closing it again is free — so without a bound, reading what
 * several Runs would undo would keep every one of those patches alive for the
 * life of the process. The oldest goes first; a review that has aged out is
 * refused as stale, which is what it is.
 */
const MAX_PENDING_REVIEWS = 8

/** One reviewed restoration, waiting for a confirmation that may never come. */
interface PendingUndo {
  sessionId: string
  runId: string
  checkout: string
  /** The Session's own object store, which is where scratch files go too. */
  store: string
  mode: UndoMode
  paths: UndoPath[]
  /** The whole patch, uncapped: what is applied is never what was truncated. */
  patch: string
  treeDigest: string
}

export interface RunUndoDeps {
  store: SessionSnapshotStore
  /** The Session, for its Project root and which kind of Checkout it works in. */
  session: (sessionId: string) => Promise<SessionSummary>
  /**
   * Appends the durable record of what was actually done. Undo never rewrites
   * the Run it undoes, so this only ever adds.
   */
  recordAppAction: (input: {
    sessionId: string
    operationId: string
    sourceRunId: string
    outcomes: UndoOutcome[]
    unlisted: number
  }) => Promise<void>
  newOperationId?: () => string
}

export class RunUndoService {
  /**
   * Reviews still open, by operation id. Deliberately in memory: a review is
   * an assertion about a tree at a moment, and after a restart every such
   * assertion is stale. Losing them costs a second look and nothing else.
   */
  private readonly pending = new Map<string, PendingUndo>()

  constructor(private readonly deps: RunUndoDeps) {}

  /**
   * What undoing this Run would mean right now.
   *
   * The mode is decided here rather than by the window, because it is a safety
   * decision: only an isolated Checkout whose every affected path still holds
   * exactly what the Run left there may be restored without reading the patch.
   * Any divergence at all downgrades the whole operation, not the diverged
   * paths alone — a person told "this is a direct restore" and then shown a
   * partial one was told something false.
   */
  async prepare(rawInput: PrepareRunUndoInput): Promise<RunUndoPreparation> {
    const input = prepareRunUndoInputSchema.parse(rawInput)
    const session = await this.deps.session(input.sessionId)
    const record = await this.deps.store.read(input.sessionId, input.runId)
    // A Run from before snapshots were retained, or one whose capture was
    // skipped, has nothing to restore from. Said plainly rather than offered
    // and then failed.
    if (!record?.before || !record.after) {
      return { status: 'unavailable', reason: 'no-snapshot' }
    }
    const store = this.deps.store.directoryFor(input.sessionId)
    // The Checkout the Run actually ran in, as it was recorded then. A Session
    // never moves Checkout, but reading it from the record rather than
    // recomputing it means a restoration can never land somewhere else.
    const checkout = record.checkout || checkoutDirectory(session.projectRoot, session.checkout)
    // Undo is the app operation whose correctness requires a stable Checkout
    // (MEM-93). Snapshotting deliberately tolerates a merge in progress —
    // a Run must be able to work through one — but planning to write into a
    // half-finished merge is a different thing entirely.
    const observation = await observeCheckoutState(checkout)
    if (observation.status !== 'observed') {
      return { status: 'unavailable', reason: observation.status }
    }
    if (observation.state !== 'clean') return { status: 'blocked', state: observation.state }
    const planned = await planRestoration({
      checkout,
      store,
      before: record.before,
      after: record.after
    })
    if (planned.status === 'skipped') {
      return planned.reason === 'checkout-state'
        ? { status: 'blocked', state: planned.state }
        : { status: 'unavailable', reason: planned.reason }
    }
    const { paths, patch, treeDigest } = planned.plan
    if (paths.length === 0) return { status: 'unavailable', reason: 'nothing-to-undo' }

    const everyPathSafe = paths.every((path) => path.classification === 'safe')
    const mode: UndoMode =
      session.checkout.kind === 'worktree' && everyPathSafe ? 'direct' : 'review'
    const operationId = (this.deps.newOperationId ?? randomUUID)()
    // Insertion order is age order, so the first key is the oldest review.
    while (this.pending.size >= MAX_PENDING_REVIEWS) {
      const oldest = this.pending.keys().next()
      if (oldest.done) break
      this.pending.delete(oldest.value)
    }
    this.pending.set(operationId, {
      sessionId: input.sessionId,
      runId: input.runId,
      checkout,
      store,
      mode,
      paths,
      patch,
      treeDigest
    })
    const shown = patch.slice(0, MAX_SHOWN_PATCH_BYTES)
    return {
      status: 'ready',
      operationId,
      mode,
      runId: input.runId,
      paths,
      patch: shown,
      patchShortened: shown.length < patch.length
    }
  }

  /**
   * Carries out a reviewed restoration, or refuses it.
   *
   * The tree is measured again here, after the person has confirmed and before
   * anything is written. An editor saving a buffer in that window is the
   * ordinary case, not the exotic one, and the only safe answer to it is to
   * stop: nothing is touched and the review is discarded, so the next attempt
   * is made against what is really there.
   */
  async apply(rawInput: ApplyRunUndoInput): Promise<RunUndoApplication> {
    const input = applyRunUndoInputSchema.parse(rawInput)
    const operation = this.pending.get(input.operationId)
    // A review this process never issued, one already used, or one belonging
    // to another Session. All three are the same answer: look again.
    if (operation?.sessionId !== input.sessionId) return { status: 'stale' }

    const observation = await observeCheckoutState(operation.checkout)
    if (observation.status !== 'observed') {
      this.pending.delete(input.operationId)
      return { status: 'unavailable', reason: observation.status }
    }
    if (observation.state !== 'clean') {
      // Kept, not discarded: the operation is fine, the moment is not, and
      // finishing the rebase is all that stands between here and applying it.
      return { status: 'blocked', state: observation.state }
    }
    const digest = await currentTreeDigest(operation.checkout, operation.store)
    if (digest === null || digest !== operation.treeDigest) {
      this.pending.delete(input.operationId)
      return { status: 'stale' }
    }
    // Consumed before the write, so a crash mid-apply cannot be followed by a
    // second application of the same patch: the next attempt has to be
    // reviewed against the tree as it then is.
    this.pending.delete(input.operationId)
    const applied = await applyInversePatch({
      checkout: operation.checkout,
      store: operation.store,
      patch: operation.patch
    })
    // Refused means git wrote nothing, which is the same thing the person
    // needs to hear as a stale review: look again. Failed means it started and
    // did not finish, and there is no honest way to describe the tree.
    if (applied.status === 'refused') return { status: 'stale' }
    if (applied.status === 'failed') return { status: 'failed' }

    const outcomes: UndoOutcome[] = operation.paths.map((path) => ({
      path: path.path,
      outcome: OUTCOME_OF_CLASSIFICATION[path.classification]
    }))
    const listed = outcomes.slice(0, MAX_UNDO_OUTCOMES)
    // The record is written under the operation id, so appending it twice is
    // appending it once — which makes one retry free. Past that the files have
    // still moved, and a record that could not be written is not a reason to
    // report that they did not.
    const record = {
      sessionId: operation.sessionId,
      operationId: input.operationId,
      sourceRunId: operation.runId,
      outcomes: listed,
      unlisted: outcomes.length - listed.length
    }
    await this.deps
      .recordAppAction(record)
      .catch(() => this.deps.recordAppAction(record))
      .catch(() => undefined)
    return {
      // Partial means something was left undone, which is only ever a diverged
      // path. A path that was already back is not a shortfall — reporting
      // "1 of 2" for it would invent a failure nobody had.
      status: outcomes.every((outcome) => isRestored(outcome.outcome)) ? 'restored' : 'partial',
      runId: operation.runId,
      outcomes: listed
    }
  }

  /** Drops reviews belonging to a Session that has just been deleted. */
  forget(sessionId: string): void {
    for (const [id, operation] of this.pending) {
      if (operation.sessionId === sessionId) this.pending.delete(id)
    }
  }
}
