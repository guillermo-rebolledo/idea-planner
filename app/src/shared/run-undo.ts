import { z } from 'zod'
import { changeKindSchema, undoOutcomeSchema } from './conversation'
import { checkoutStateSchema } from './checkout'

/**
 * Undoing a Run: putting the files it changed back the way they were, from
 * Git objects this app kept for itself (ADR 0006).
 *
 * Two shapes, because two Checkouts deserve different answers. An isolated
 * Checkout is the app's own directory, so when every path still holds exactly
 * what the Run left there it can simply be restored. The primary checkout is
 * where the person's editor is open, so it always shows the inverse patch
 * first. Either way nothing is applied until the app has re-checked, at the
 * last possible moment, that the tree is still the one that was reviewed.
 */

/** What one affected path is, measured against what the Run left there. */
export const undoPathClassificationSchema = z.enum([
  /** Still exactly as the Run left it, so the inverse patch will apply. */
  'safe',
  /** Changed since, by anyone. Left untouched, always. */
  'diverged',
  /** Already back to its pre-Run content. There is nothing to undo. */
  'already-restored'
])
export type UndoPathClassification = z.infer<typeof undoPathClassificationSchema>

/** One path the Run changed, and what undoing it would mean now. */
export const undoPathSchema = z.object({
  /** Relative to the Checkout, as git names it. */
  path: z.string().min(1),
  /** What the Run did to it, so the review reads as an inverse of that. */
  changeKind: changeKindSchema,
  classification: undoPathClassificationSchema
})
export type UndoPath = z.infer<typeof undoPathSchema>

/** Why undo is not on offer for a Run. Each reason is repaired differently. */
export const undoUnavailableReasonSchema = z.enum([
  /** The Run predates retained snapshots, or its capture was skipped. */
  'no-snapshot',
  /** The Run changed nothing there is anything to put back. */
  'nothing-to-undo',
  'git-unavailable',
  'not-a-repository'
])
export type UndoUnavailableReason = z.infer<typeof undoUnavailableReasonSchema>

/**
 * How the restoration would be carried out. `direct` is offered only for an
 * isolated Checkout whose every affected path is still exactly as the Run left
 * it; anything else is `review`, where the person reads the inverse patch and
 * confirms it.
 */
export const undoModeSchema = z.enum(['direct', 'review'])
export type UndoMode = z.infer<typeof undoModeSchema>

export const runUndoPreparationSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    /**
     * Opaque, and the only handle the window ever holds. It carries the
     * reviewed patch and the digest of the tree it was computed against; the
     * window cannot name a patch of its own.
     */
    operationId: z.string().uuid(),
    mode: undoModeSchema,
    /** The Run being put back, named so the record can say where this came from. */
    runId: z.string().min(1),
    paths: z.array(undoPathSchema),
    /**
     * The inverse patch as git rendered it, for reading. A direct restore
     * carries it too — the person may still want to see what they are about
     * to undo — but only `review` requires reading it first.
     */
    patch: z.string(),
    /** True when the patch was too large to carry, so only the list is shown. */
    patchShortened: z.boolean()
  }),
  /** A Checkout State that makes touching the tree unsafe (MEM-93). */
  z.object({ status: z.literal('blocked'), state: checkoutStateSchema }),
  z.object({ status: z.literal('unavailable'), reason: undoUnavailableReasonSchema })
])
export type RunUndoPreparation = z.infer<typeof runUndoPreparationSchema>

export const runUndoApplicationSchema = z.discriminatedUnion('status', [
  z.object({
    /** Every safe path was put back. */
    status: z.literal('restored'),
    runId: z.string().min(1),
    outcomes: z.array(undoOutcomeSchema)
  }),
  z.object({
    /** Some safe paths were put back and the rest were not; both are named. */
    status: z.literal('partial'),
    runId: z.string().min(1),
    outcomes: z.array(undoOutcomeSchema)
  }),
  /**
   * The tree moved between review and apply. Nothing was touched, and the
   * person is asked to look again rather than shown a guess.
   */
  z.object({ status: z.literal('stale') }),
  z.object({ status: z.literal('blocked'), state: checkoutStateSchema }),
  z.object({ status: z.literal('unavailable'), reason: undoUnavailableReasonSchema })
])
export type RunUndoApplication = z.infer<typeof runUndoApplicationSchema>

export const prepareRunUndoInputSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1)
})
export type PrepareRunUndoInput = z.infer<typeof prepareRunUndoInputSchema>

export const applyRunUndoInputSchema = z.object({
  sessionId: z.string().min(1),
  operationId: z.string().uuid()
})
export type ApplyRunUndoInput = z.infer<typeof applyRunUndoInputSchema>
