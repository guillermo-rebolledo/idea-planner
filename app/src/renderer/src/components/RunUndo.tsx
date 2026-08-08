import { useEffect, useId, useState } from 'react'
import { Undo2 } from 'lucide-react'
import type {
  RunUndoApplication,
  RunUndoPreparation,
  UndoPath,
  UndoPathClassification
} from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { Modal } from '@renderer/components/ui/dialog'

/**
 * Putting a Run back (ADR 0006).
 *
 * Two surfaces in one, because there are two honest answers. An isolated
 * Checkout whose every path still holds exactly what the Run left there is
 * offered a **direct restore**: there is nothing to weigh up, so the dialog
 * says what will happen and asks once. Everything else — every Run in the
 * primary checkout, and any isolated one where something has moved — is a
 * **review**: the inverse patch is on screen, each path says what will happen
 * to it in words, and confirming applies only the safe ones.
 *
 * Nothing here is bound to ⌘Z. This writes over source files, and a keystroke
 * people press without looking is the wrong door for that.
 */

/** What each classification means, in the reader's terms rather than ours. */
const CLASSIFICATION_WORD: Record<UndoPathClassification, string> = {
  safe: 'will be put back',
  diverged: 'changed since — will be left alone',
  'already-restored': 'already back — nothing to do'
}

/** Colour is supplementary; this is the whole message either way. */
const CLASSIFICATION_TONE: Record<UndoPathClassification, string> = {
  safe: 'text-foreground',
  diverged: 'text-muted-foreground',
  'already-restored': 'text-muted-foreground'
}

function unavailableText(preparation: RunUndoPreparation): string | null {
  if (preparation.status === 'blocked') {
    return `This Checkout is mid-operation (${preparation.state}). Finish it, then undo.`
  }
  if (preparation.status !== 'unavailable') return null
  switch (preparation.reason) {
    case 'no-snapshot':
      return 'Undo is not available for this Run: the app kept no before-and-after record of it.'
    case 'nothing-to-undo':
      return 'This Run left no file changes to put back.'
    case 'git-unavailable':
      return 'Git could not be found, so nothing can be put back.'
    case 'not-a-repository':
      return 'This Checkout is no longer a git repository.'
  }
}

function appliedText(applied: RunUndoApplication): string {
  switch (applied.status) {
    case 'restored':
      return `Put back ${String(applied.outcomes.length)} file${applied.outcomes.length === 1 ? '' : 's'}.`
    case 'partial': {
      const restored = applied.outcomes.filter((one) => one.outcome === 'restored').length
      return `Put back ${String(restored)} of ${String(applied.outcomes.length)} files; the rest were left as they are.`
    }
    case 'stale':
      return 'Something changed while you were reading this, so nothing was touched. Ask again to see where things stand now.'
    case 'failed':
      return 'Git accepted the change and then could not finish applying it. Some files may have moved and some may not — check the Checkout in git before doing anything else.'
    case 'blocked':
      return `This Checkout is mid-operation (${applied.state}), so nothing was touched.`
    case 'unavailable':
      return 'The Checkout could not be read, so nothing was touched.'
  }
}

export function UndoRunButton({
  runId,
  onOpen
}: {
  runId: string
  onOpen: (runId: string) => void
}): React.JSX.Element {
  return (
    <Button size="sm" variant="ghost" onClick={() => onOpen(runId)}>
      <Undo2 aria-hidden="true" className="size-3" />
      Undo this Run
    </Button>
  )
}

export function RunUndoDialog({
  sessionId,
  runId,
  onClose,
  onApplied
}: {
  sessionId: string
  runId: string
  onClose: () => void
  /** The Conversation gained an entry and the Files rows moved; re-read them. */
  onApplied: () => void
}): React.JSX.Element {
  const titleId = useId()
  const [preparation, setPreparation] = useState<RunUndoPreparation | null>(null)
  const [applied, setApplied] = useState<RunUndoApplication | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Mounted per Run — the caller keys it — so this only ever runs once, and
  // there is no earlier answer left over to clear first.
  useEffect(() => {
    let live = true
    window.shell
      .prepareRunUndo({ sessionId, runId })
      .then((result) => {
        if (live) setPreparation(result)
      })
      .catch(() => {
        if (live) setError('The Checkout could not be read.')
      })
    return () => {
      live = false
    }
  }, [sessionId, runId])

  const ready = preparation?.status === 'ready' ? preparation : null
  const restorable = ready?.paths.filter((path) => path.classification === 'safe') ?? []

  const confirm = (): void => {
    if (!ready) return
    setBusy(true)
    window.shell
      .applyRunUndo({ sessionId, operationId: ready.operationId })
      .then((result) => {
        setApplied(result)
        if (result.status === 'restored' || result.status === 'partial') onApplied()
      })
      .catch(() => {
        setError('The restoration could not be carried out.')
      })
      .finally(() => setBusy(false))
  }

  return (
    <Modal labelledBy={titleId} destructive onDismiss={onClose} className="max-w-2xl">
      <h2 id={titleId} className="text-sm font-medium">
        {ready?.mode === 'direct' ? 'Undo this Run' : 'Review what undoing this Run would do'}
      </h2>

      {preparation === null && error === null && (
        <p className="mt-2 text-xs text-muted-foreground">Reading the Checkout…</p>
      )}
      {error !== null && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {preparation !== null && unavailableText(preparation) !== null && (
        <p className="mt-2 text-xs text-muted-foreground">{unavailableText(preparation)}</p>
      )}

      {ready !== null && applied === null && (
        <>
          <p className="mt-1 text-xs text-muted-foreground">
            {ready.mode === 'direct'
              ? 'This Session works in a Worktree, and every file this Run changed is still exactly as it left it. They will be put back the way they were before the Run.'
              : 'Each file is listed with what will happen to it. Files changed since the Run are never written to. Anything you have staged in git stays exactly as it is.'}
          </p>
          <UndoPathList paths={ready.paths} />
          {ready.mode === 'review' && ready.patch !== '' && (
            <details className="mt-3 rounded-md border border-border bg-surface">
              <summary className="cursor-pointer px-2.5 py-1.5 text-xs">
                Show the patch that would be applied
              </summary>
              <pre className="max-h-64 overflow-auto px-2.5 pb-2.5 font-mono text-2xs whitespace-pre">
                {ready.patch}
              </pre>
              {ready.patchShortened && (
                <p className="px-2.5 pb-2.5 text-2xs text-muted-foreground">
                  This patch is longer than what is shown; the whole of it is what gets applied.
                </p>
              )}
            </details>
          )}
        </>
      )}

      {applied !== null && (
        <p className="mt-2 text-xs text-muted-foreground">{appliedText(applied)}</p>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" data-autofocus onClick={onClose}>
          {applied === null ? 'Cancel' : 'Close'}
        </Button>
        {ready !== null && applied === null && (
          <Button size="sm" variant="destructive" disabled={busy} onClick={confirm}>
            {ready.mode === 'direct'
              ? 'Restore this Run'
              : `Put back ${String(restorable.length)} file${restorable.length === 1 ? '' : 's'}`}
          </Button>
        )}
      </div>
    </Modal>
  )
}

function UndoPathList({ paths }: { paths: UndoPath[] }): React.JSX.Element {
  return (
    <ul className="mt-3 max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
      {paths.map((path) => (
        <li key={path.path} className="flex items-baseline gap-2 px-2.5 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path.path}>
            {path.path}
          </span>
          <span className={`shrink-0 text-2xs ${CLASSIFICATION_TONE[path.classification]}`}>
            {CLASSIFICATION_WORD[path.classification]}
          </span>
        </li>
      ))}
    </ul>
  )
}
