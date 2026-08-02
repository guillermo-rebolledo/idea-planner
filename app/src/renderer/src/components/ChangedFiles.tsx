import { useState } from 'react'
import { FileDiff } from 'lucide-react'
import type { ChangedFile, ConversationEntry } from '@shared/contract'

/** The Conversation entries this panel is about, and the only ones it takes. */
type FileChange = Extract<ConversationEntry, { kind: 'file-change' }>
import { DiffView } from '@renderer/components/Diff'

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
          What the agent reported changing, in your Project. The changes are already on disk — git
          decides what you keep.
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
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-baseline gap-2 p-3 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <FileDiff
          aria-hidden="true"
          className="size-3.5 shrink-0 self-center text-muted-foreground"
        />
        <span className="min-w-0 flex-1 font-mono text-xs break-all">{file.path}</span>
        <span className="shrink-0 text-[11px]">
          <span className="text-positive">+{file.added}</span>{' '}
          <span className="text-destructive">−{file.removed}</span>
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {file.changes === 1 ? 'changed once' : `changed ${String(file.changes)} times`}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          {/* Every change to this file, newest last, exactly as it was made. */}
          {changes.map((entry) => (
            <DiffView key={entry.id} hunks={entry.hunks} />
          ))}
        </div>
      )}
    </li>
  )
}
