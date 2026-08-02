import { useState } from 'react'
import { FileDiff, FilePlus2, FileX2, type LucideIcon } from 'lucide-react'
import type { ChangeKind, ChangedFile, ConversationEntry } from '@shared/contract'
import { DiffView } from '@renderer/components/Diff'
import { cn } from '@renderer/lib/utils'

/** The Conversation entries this panel is about, and the only ones it takes. */
type FileChange = Extract<ConversationEntry, { kind: 'file-change' }>

/** What happened to a file, in the row's own words. */
const CHANGE_WORD: Record<ChangeKind, string> = {
  added: 'created',
  changed: 'changed',
  deleted: 'deleted'
}

const CHANGE_LOOK: Record<ChangeKind, { icon: LucideIcon; tone: string }> = {
  added: { icon: FilePlus2, tone: 'text-positive' },
  changed: { icon: FileDiff, tone: 'text-muted-foreground' },
  deleted: { icon: FileX2, tone: 'text-destructive' }
}

/**
 * What this Session has done to the Project. The Conversation answers "what is
 * happening"; this answers "what is the state of this work" when the person
 * comes back to it tomorrow, without reading the log back.
 *
 * Every row comes from what the Harness reported at the time, never from the
 * repository now: the Checkout is edited in place (ADR 0004), so a Project
 * that was already dirty when the Session started would otherwise show the
 * person their own edits as the agent's.
 *
 * Nothing here can be accepted or rejected. The change already happened, and
 * git is what decides what to keep.
 */
export function ChangedFiles({
  files,
  entries
}: {
  files: ChangedFile[]
  entries: FileChange[]
}): React.JSX.Element | null {
  const [opened, setOpened] = useState<string | null>(null)
  if (files.length === 0) return null

  return (
    <section
      className="mt-4 flex flex-col rounded-md border border-border bg-surface"
      aria-labelledby="changed-files-heading"
    >
      <header className="border-b border-border p-3">
        <h3 id="changed-files-heading" className="text-sm font-medium">
          Files this Session changed
        </h3>
        <p className="text-xs text-muted-foreground">
          What changed in your Project while this Session worked, whether the agent reported it or a
          command it ran did it quietly. The changes are already on disk — git decides what you
          keep.
        </p>
      </header>
      <ul className="flex flex-col">
        {files.map((file) => (
          <ChangedFileRow
            key={file.path}
            file={file}
            open={opened === file.path}
            onToggle={() => setOpened((current) => (current === file.path ? null : file.path))}
            changes={entries.filter((entry) => entry.path === file.path)}
          />
        ))}
      </ul>
    </section>
  )
}

function ChangedFileRow({
  file,
  open,
  onToggle,
  changes
}: {
  file: ChangedFile
  open: boolean
  onToggle: () => void
  changes: FileChange[]
}): React.JSX.Element {
  const { icon: Icon, tone } = CHANGE_LOOK[file.change]
  // A change with no lines at all is a binary file, or a mode, or a rename of
  // one — never a change that did nothing.
  const textless = file.added === 0 && file.removed === 0
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-baseline gap-2 p-3 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon aria-hidden="true" className={cn('size-3.5 shrink-0 self-center', tone)} />
        <span
          className={cn(
            'min-w-0 flex-1 font-mono text-xs break-all',
            // A path that is no longer there should not read as one you could
            // go and open.
            file.change === 'deleted' && 'text-muted-foreground line-through'
          )}
        >
          {file.path}
        </span>
        <span className="shrink-0 text-[11px]">
          {textless ? (
            // No lines to show, and a reason: `+0 −0` on its own reads as a
            // bug rather than as a binary file or a mode.
            <span className="text-muted-foreground">no text change</span>
          ) : (
            <>
              <span className="text-positive">+{file.added}</span>{' '}
              <span className="text-destructive">−{file.removed}</span>
            </>
          )}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {CHANGE_WORD[file.change]}
          {file.reported
            ? file.changes > 1 && `, ${String(file.changes)} times`
            : // Found on disk with nothing in the Conversation accounting for
              // it: a command the agent ran changed this, and said nothing.
              ', not reported'}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          {textless && (
            <p className="text-[11px] text-muted-foreground">
              Nothing to show: this file has no text to diff.
            </p>
          )}
          {/* Every change to this file, newest last, exactly as it was made. */}
          {changes.map((entry) => (
            <DiffView key={entry.id} hunks={entry.hunks} />
          ))}
          {file.shortened && (
            <p className="text-[11px] text-muted-foreground">
              This diff is longer than what is kept; the counts above are the whole change.
            </p>
          )}
        </div>
      )}
    </li>
  )
}
