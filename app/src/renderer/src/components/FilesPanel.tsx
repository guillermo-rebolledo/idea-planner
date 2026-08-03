import { FileDiff, FilePlus2, FileX2, X, type LucideIcon } from 'lucide-react'
import type { ChangeKind, ChangedFile } from '@shared/contract'
import { DiffView } from '@renderer/components/Diff'
import type { FileChangeEntry, SessionChanges } from '@renderer/lib/useSessionChanges'
import { cn } from '@renderer/lib/utils'

/**
 * "Files this Session changed" (mockup 1a): the app's only diff surface.
 * Session-cumulative and live — one row per file across every Run, and the
 * selected file's diffs underneath.
 *
 * Every row comes from what was recorded at the time, never from the
 * repository now: the Checkout is edited in place (ADR 0004), so a Project
 * that was already dirty when the Session started would otherwise show the
 * person their own edits as the agent's. Nothing here can be accepted or
 * rejected — the change is already on disk, and git is what decides what to
 * keep.
 */

const CHANGE_LOOK: Record<ChangeKind, { icon: LucideIcon; tone: string }> = {
  added: { icon: FilePlus2, tone: 'text-diff-added-foreground' },
  changed: { icon: FileDiff, tone: 'text-muted-foreground' },
  deleted: { icon: FileX2, tone: 'text-diff-removed-foreground' }
}

/** What happened to a file, in the row's own words. */
const CHANGE_WORD: Record<ChangeKind, string> = {
  added: 'created',
  changed: 'changed',
  deleted: 'deleted'
}

interface FilesPanelProps {
  changes: SessionChanges
  /** The file whose diff is open underneath, when one is. */
  focusedPath: string | null
  onFocus: (path: string | null) => void
  onClose: () => void
}

export function FilesPanel({
  changes,
  focusedPath,
  onFocus,
  onClose
}: FilesPanelProps): React.JSX.Element {
  const { files, entries, totals } = changes
  const focused = files.find((file) => file.path === focusedPath) ?? null

  return (
    <aside
      aria-label="Files this Session changed"
      className="flex w-80 shrink-0 flex-col border-l border-border bg-muted/40"
    >
      <header className="flex items-baseline gap-2 px-4 pt-3.5 pb-1">
        <h2 className="text-xs font-medium">Files this Session changed</h2>
        <span className="ml-auto font-mono text-xs">
          <span className="text-diff-added-foreground">+{totals.added}</span>{' '}
          <span className="text-diff-removed-foreground">−{totals.removed}</span>
        </span>
        <button
          type="button"
          aria-label="Close the Files panel"
          onClick={onClose}
          className="rounded p-0.5 text-muted-foreground hover:bg-border hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </header>
      <p className="px-4 pb-2.5 text-2xs text-muted-foreground">
        Already on disk. git is the undo.
      </p>

      {files.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          Nothing changed yet. Rows appear here as the agent works, whether it reports an edit or a
          command does it quietly.
        </p>
      ) : (
        <>
          <ul className="flex max-h-72 shrink-0 flex-col overflow-y-auto">
            {files.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                focused={file.path === focusedPath}
                onClick={() => onFocus(file.path === focusedPath ? null : file.path)}
              />
            ))}
          </ul>
          {focused !== null && (
            <FocusedDiff
              file={focused}
              changes={entries.filter((entry) => entry.path === focused.path)}
            />
          )}
        </>
      )}
    </aside>
  )
}

function FileRow({
  file,
  focused,
  onClick
}: {
  file: ChangedFile
  focused: boolean
  onClick: () => void
}): React.JSX.Element {
  const { icon: Icon, tone } = CHANGE_LOOK[file.changeKind]
  // A change with no lines at all is a binary file or a mode change — never a
  // change that did nothing — unless its diff was simply too big to keep.
  const textless = file.added === 0 && file.removed === 0
  return (
    <li>
      <button
        type="button"
        aria-expanded={focused}
        onClick={onClick}
        title={`${file.path} — ${CHANGE_WORD[file.changeKind]}${file.reported ? '' : ', not reported by the agent'}`}
        className={cn(
          'flex w-full items-center gap-2 px-4 py-1.5 text-left font-mono text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
          focused && 'bg-accent'
        )}
      >
        <Icon aria-hidden="true" className={cn('size-3 shrink-0', tone)} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            focused ? 'text-foreground' : 'text-muted-foreground',
            file.changeKind === 'deleted' && 'line-through'
          )}
        >
          {file.path}
        </span>
        {textless ? (
          <span className="shrink-0 text-2xs text-muted-foreground">
            {file.shortened ? 'diff not kept' : 'no text change'}
          </span>
        ) : (
          <span className="shrink-0">
            {file.added > 0 && <span className="text-diff-added-foreground">+{file.added}</span>}
            {file.added > 0 && file.removed > 0 && ' '}
            {file.removed > 0 && (
              <span className="text-diff-removed-foreground">−{file.removed}</span>
            )}
          </span>
        )}
      </button>
    </li>
  )
}

/** The selected file's diffs, newest last, exactly as they were recorded. */
function FocusedDiff({
  file,
  changes
}: {
  file: ChangedFile
  changes: FileChangeEntry[]
}): React.JSX.Element {
  const textless = file.added === 0 && file.removed === 0 && !file.shortened
  const unreadable = file.added === 0 && file.removed === 0 && file.shortened
  return (
    <div className="mx-3 mt-2 mb-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-surface">
      <p className="flex items-baseline gap-2 border-b border-border px-2.5 py-1.5 font-mono text-2xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{file.path}</span>
        <span className="shrink-0">
          <span className="text-diff-added-foreground">+{file.added}</span>{' '}
          <span className="text-diff-removed-foreground">−{file.removed}</span>
        </span>
      </p>
      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {textless && (
          <p className="px-1 py-0.5 text-xs text-muted-foreground">
            Nothing to show: this file has no text to diff.
          </p>
        )}
        {unreadable && (
          <p className="px-1 py-0.5 text-xs text-muted-foreground">
            This file changed, and its diff was too large to keep.
          </p>
        )}
        {changes.map((entry) => (
          <DiffView key={entry.id} hunks={entry.hunks} />
        ))}
        {file.shortened && !unreadable && (
          <p className="px-1 py-1 text-xs text-muted-foreground">
            This diff is longer than what is kept; the counts above are the whole change.
          </p>
        )}
        {!file.reported && (
          <p className="px-1 py-1 text-xs text-muted-foreground">
            Found on disk with nothing in the Conversation accounting for it: a command the agent
            ran changed this, and said nothing.
          </p>
        )}
      </div>
    </div>
  )
}
