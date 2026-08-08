import { useRef, useState } from 'react'
import { FileDiff, FilePlus2, FileX2, MessageSquarePlus, X, type LucideIcon } from 'lucide-react'
import {
  captureReviewAttachment,
  type ChangeKind,
  type ChangedFile,
  type ReviewAttachment,
  type ReviewSelection
} from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { DiffCounts, DiffView } from '@renderer/components/Diff'
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

// The icon says what happened; colour stays rationed to the diff numbers.
const CHANGE_ICON: Record<ChangeKind, LucideIcon> = {
  added: FilePlus2,
  changed: FileDiff,
  deleted: FileX2
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
  /**
   * Takes the reviewed code onto the next message. The snapshot is made here,
   * from what was recorded, so a later write never re-anchors it.
   */
  onAttach: (attachment: ReviewAttachment) => void
}

/** How wide the panel opens, and how far it may be dragged either way. */
const DEFAULT_WIDTH = 420
const MIN_WIDTH = 320
const MAX_WIDTH = 800
/** One keyboard step of the resize handle. */
const RESIZE_STEP = 24

export function FilesPanel({
  changes,
  focusedPath,
  onFocus,
  onClose,
  onAttach
}: FilesPanelProps): React.JSX.Element {
  const { files, entries, totals } = changes
  const focused = files.find((file) => file.path === focusedPath) ?? null
  // Diffs are 80–120 columns wide; a review surface must not be a keyhole.
  // The width is the reader's to set, per visit, between honest bounds.
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const clamp = (next: number): number => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next))

  return (
    <aside
      aria-label="Files this Session changed"
      style={{ width: `min(${String(width)}px, 42vw)`, minWidth: MIN_WIDTH }}
      className="relative flex shrink-0 flex-col border-l border-border bg-muted/40"
    >
      {/* The panel's edge is its own control: drag it, or arrow it wider and
          narrower from the keyboard. A focusable separator carrying
          aria-valuenow is ARIA's own pattern for a resize handle; the lint
          rules below do not model that widget. */}
      {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the Files panel"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        onPointerDown={(event) => {
          dragRef.current = { startX: event.clientX, startWidth: width }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (drag) setWidth(clamp(drag.startWidth + (drag.startX - event.clientX)))
        }}
        onPointerUp={() => {
          dragRef.current = null
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            setWidth((current) => clamp(current + RESIZE_STEP))
          }
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            setWidth((current) => clamp(current - RESIZE_STEP))
          }
        }}
        className="absolute inset-y-0 -left-0.5 z-10 w-1.5 cursor-col-resize hover:bg-border focus-visible:bg-ring focus-visible:outline-none"
      />
      {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      <header className="flex items-baseline gap-2 px-4 pt-3.5 pb-1">
        <h2 className="text-xs font-medium">Files this Session changed</h2>
        <span className="ml-auto font-mono text-xs">
          <DiffCounts added={totals.added} removed={totals.removed} />
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
              onAttach={onAttach}
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
  const Icon = CHANGE_ICON[file.changeKind]
  // A change with no lines at all is a binary file or a mode change — never a
  // change that did nothing — unless its diff was simply too big to keep.
  const textless = file.added === 0 && file.removed === 0
  return (
    <li>
      <button
        type="button"
        aria-expanded={focused}
        onClick={onClick}
        title={`${file.path} — ${CHANGE_WORD[file.changeKind]}${file.reported ? '' : ', not reported by the agent'}${file.restored ? ', since put back' : ''}`}
        className={cn(
          'flex w-full items-center gap-2 px-4 py-1.5 text-left font-mono text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
          focused && 'bg-accent'
        )}
      >
        <Icon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            focused ? 'text-foreground' : 'text-muted-foreground',
            file.changeKind === 'deleted' && 'line-through'
          )}
        >
          {file.path}
        </span>
        {/* A row that has been put back keeps its counts — the change did
            happen — and says so in words rather than by disappearing. */}
        {file.restored && <span className="shrink-0 text-2xs text-muted-foreground">put back</span>}
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

/** When one write of a stacked diff happened, in the reader's clock. */
function writeClock(at: string): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** The selected file's diffs, newest last, exactly as they were recorded. */
function FocusedDiff({
  file,
  changes,
  onAttach
}: {
  file: ChangedFile
  changes: FileChangeEntry[]
  onAttach: (attachment: ReviewAttachment) => void
}): React.JSX.Element {
  /**
   * The snapshot is taken from the recorded entry at the moment of asking,
   * never from the file on disk: what the person read is what the agent is
   * asked about, whatever happens to that file afterwards.
   */
  const attachFrom = (entry: FileChangeEntry, selection: ReviewSelection): void =>
    onAttach(
      captureReviewAttachment(
        { path: entry.path, runId: entry.runId, entryId: entry.id, hunks: entry.hunks },
        selection,
        new Date().toISOString()
      )
    )
  const textless = file.added === 0 && file.removed === 0 && !file.shortened
  const unreadable = file.added === 0 && file.removed === 0 && file.shortened
  return (
    <div className="mx-3 mt-2 mb-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-surface">
      <p className="flex items-baseline gap-2 border-b border-border px-2.5 py-1.5 font-mono text-2xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{file.path}</span>
        <span className="shrink-0">
          <DiffCounts added={file.added} removed={file.removed} />
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
        {changes.map((entry, index) => (
          <div key={entry.id}>
            {/* A stacked log, not a net diff: each write is shown as it was
                recorded, so an early state must not read as the final one. */}
            <div className="flex flex-wrap items-baseline gap-2 px-1 pt-1.5">
              {changes.length > 1 && (
                <p className="font-mono text-2xs text-muted-foreground">
                  Write {index + 1} of {changes.length} · {writeClock(entry.at)}
                </p>
              )}
              {/* Whole-file attachment lives on the write it came from: an
                  attachment always quotes one recorded change, so nothing it
                  carries can be a mixture of two moments. */}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto"
                aria-label={`Attach all of ${file.path}${changes.length > 1 ? ` from write ${String(index + 1)}` : ''}`}
                onClick={() => attachFrom(entry, { scope: 'file' })}
              >
                <MessageSquarePlus aria-hidden="true" className="size-3" />
                Attach file
              </Button>
            </div>
            <DiffView
              hunks={entry.hunks}
              attach={{
                path: file.path,
                onAttachHunk: (hunkIndex) => attachFrom(entry, { scope: 'hunk', hunkIndex }),
                onAttachLines: (hunkIndex, lineIndexes) =>
                  attachFrom(entry, { scope: 'lines', hunkIndex, lineIndexes })
              }}
            />
          </div>
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
        {file.restored && (
          <p className="px-1 py-1 text-xs text-muted-foreground">
            You have since put this file back. The change above is kept as the record of what the
            Run did; it is no longer what is on disk.
          </p>
        )}
      </div>
    </div>
  )
}
