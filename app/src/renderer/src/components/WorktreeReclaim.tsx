import { useEffect, useId, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import {
  describeDiskSize,
  type ReclaimableWorktree,
  type WorktreeInventory,
  type WorktreeRemoval,
  type WorktreeRemovalResult
} from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { Modal } from '@renderer/components/ui/dialog'

/**
 * The Worktrees Argos made for one Project, and the one confirmation that
 * removes the ones the person picked (ADR 0008).
 *
 * It is a review before it is an action, like Run Undo: everything that would
 * be lost is on screen — the Session it belongs to, whether it holds work no
 * commit or ref has, and what it is costing right now — and the person selects
 * and confirms once. Branches are never touched, and nothing here is reachable
 * except by asking for it.
 */

/** What one entry holds, said as the reason to keep it rather than as a flag. */
function heldWork(worktree: ReclaimableWorktree): string[] {
  if (worktree.contents.status === 'unreadable') {
    return ['Git could not read it, so what it holds is unknown']
  }
  const held: string[] = []
  if (worktree.contents.uncommittedChanges) held.push('uncommitted changes')
  if (worktree.contents.commitsOnlyHere) held.push('commits no other branch or remote has')
  return held
}

function sessionText(worktree: ReclaimableWorktree): string {
  const session = worktree.session
  if (!session) return 'No Session — its Session was deleted, or never started'
  if (session.busy) return `${session.title} — a Run is working here now`
  return session.state === 'archived' ? `${session.title} — archived` : session.title
}

function removalText(removal: WorktreeRemoval): string {
  switch (removal.outcome) {
    case 'removed':
      return 'Removed'
    case 'already-gone':
      return 'Already gone — it had been removed outside Argos'
    case 'changed':
      return removal.detail ?? 'Changed after you read this — nothing was touched'
    case 'failed':
      return removal.detail ?? 'Could not be removed'
  }
}

export function WorktreeReclaimDialog({
  projectRoot,
  projectName,
  onDismiss,
  onAnnounce
}: {
  projectRoot: string
  projectName: string
  onDismiss: () => void
  onAnnounce: (text: string) => void
}): React.JSX.Element {
  const titleId = useId()
  const [inventory, setInventory] = useState<WorktreeInventory | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [result, setResult] = useState<WorktreeRemovalResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Mounted per Project — the caller keys it — so this reads once, and nothing
  // is selected until the person selects it.
  useEffect(() => {
    let live = true
    window.shell
      .listProjectWorktrees(projectRoot)
      .then((read) => {
        if (live) setInventory(read)
      })
      .catch(() => {
        if (live) setError('The Worktrees for this Project could not be read.')
      })
    return () => {
      live = false
    }
  }, [projectRoot])

  function toggle(path: string): void {
    setSelected((current) =>
      current.includes(path) ? current.filter((one) => one !== path) : [...current, path]
    )
  }

  function confirm(): void {
    if (selected.length === 0 || !inventory) return
    setBusy(true)
    window.shell
      // The list being answered, not just the paths: Main re-reads each one
      // and refuses any that gained work since this was drawn.
      .removeWorktrees({ projectRoot, operationId: inventory.operationId, paths: selected })
      .then((removed) => {
        setResult(removed)
        const gone = removed.removals.filter(
          (one) => one.outcome === 'removed' || one.outcome === 'already-gone'
        ).length
        onAnnounce(
          `Removed ${String(gone)} of ${String(removed.removals.length)} Worktrees. Branches were left where they are.`
        )
      })
      .catch(() => setError('Those Worktrees could not be removed.'))
      .finally(() => setBusy(false))
  }

  const worktrees = inventory?.worktrees ?? []
  const chosen = worktrees.filter((worktree) => selected.includes(worktree.path))
  const reclaimable = chosen.reduce((bytes, worktree) => bytes + worktree.disk.bytes, 0)

  return (
    <Modal labelledBy={titleId} destructive onDismiss={onDismiss} className="max-w-2xl">
      <h2 id={titleId} className="text-sm font-medium">
        Worktrees in “{projectName}”
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        The isolated Checkouts Argos made for this Project. Removing one deletes its directory and
        leaves its branch exactly where it is. Nothing here happens on its own — deleting or
        archiving a Session never touches its Checkout. Sizes are what each one holds; a Checkout
        nothing has written in yet shares most of that with the Project, so removing it frees less.
      </p>

      {inventory === null && error === null && (
        <p className="mt-3 text-xs text-muted-foreground">Reading the Worktrees…</p>
      )}
      {error !== null && <p className="mt-3 text-xs text-destructive">{error}</p>}
      {inventory !== null && worktrees.length === 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          Argos has made no Worktrees for this Project.
        </p>
      )}

      {worktrees.length > 0 && (
        <ul className="mt-3 max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {worktrees.map((worktree) => {
            const removal = result?.removals.find((one) => one.path === worktree.path)
            const held = heldWork(worktree)
            return (
              <li key={worktree.path} className="px-2.5 py-2">
                <label className="flex cursor-pointer items-start gap-2.5 text-xs">
                  {/* Named for the Checkout rather than by the whole row: the
                      row also says what would be lost, and a control whose
                      name is a paragraph is one nobody can act on by ear. */}
                  <input
                    type="checkbox"
                    aria-label={`Remove ${worktree.branch ?? worktree.path}`}
                    className="mt-0.5 shrink-0 accent-primary"
                    checked={selected.includes(worktree.path)}
                    disabled={result !== null || worktree.session?.busy === true}
                    onChange={() => toggle(worktree.path)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono" title={worktree.path}>
                        {worktree.branch ?? worktree.path}
                      </span>
                      <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                        {worktree.disk.complete ? '' : 'at least '}
                        {describeDiskSize(worktree.disk.bytes)}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
                      {sessionText(worktree)}
                    </span>
                    {held.length > 0 && (
                      <span className="mt-0.5 flex items-center gap-1 text-2xs text-notice-foreground">
                        <AlertTriangle aria-hidden="true" className="size-2.5 shrink-0" />
                        Holds {held.join(' and ')}
                      </span>
                    )}
                    {removal && (
                      <span className="mt-0.5 block text-2xs text-muted-foreground">
                        {removalText(removal)}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      )}

      {inventory !== null && inventory.unlisted > 0 && (
        <p className="mt-2 text-2xs text-muted-foreground">
          {inventory.unlisted} more are not listed here.
        </p>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        {result === null && chosen.length > 0 && (
          <span className="mr-auto text-2xs text-muted-foreground">
            Reclaims about {describeDiskSize(reclaimable)}.
          </span>
        )}
        <Button size="sm" variant="ghost" data-autofocus onClick={onDismiss}>
          {result === null ? 'Cancel' : 'Close'}
        </Button>
        {result === null && (
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || chosen.length === 0}
            onClick={confirm}
          >
            {`Remove ${String(chosen.length)} Worktree${chosen.length === 1 ? '' : 's'}`}
          </Button>
        )}
      </div>
    </Modal>
  )
}
