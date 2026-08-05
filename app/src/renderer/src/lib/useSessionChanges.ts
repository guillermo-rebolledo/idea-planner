import { useMemo } from 'react'
import type { ChangedFile, ConversationEntry, ConversationSnapshot } from '@shared/contract'

/** The Conversation entries that carry a diff: one file, one write. */
export type FileChangeEntry = Extract<ConversationEntry, { kind: 'file-change' }>

/** What a set of changes added and removed, wherever it is stated. */
export interface DiffTotals {
  added: number
  removed: number
}

export interface SessionChanges {
  /** One row per file this Session changed, cumulative across every Run. */
  files: ChangedFile[]
  /** Every recorded change, so a file's diffs can be read back in order. */
  entries: FileChangeEntry[]
  /** What the whole Session did, the number the title bar wears. */
  totals: DiffTotals
}

const NO_CHANGES: SessionChanges = { files: [], entries: [], totals: { added: 0, removed: 0 } }

/**
 * What this Session has done to its Checkout, derived from the selected
 * Conversation owner so the title bar and Files panel cannot trigger their
 * own durable reads or disagree with the Conversation surface.
 */
export function useSessionChanges(snapshot: ConversationSnapshot | null): SessionChanges {
  const files = snapshot?.changedFiles ?? []
  const entries = useMemo(
    () =>
      snapshot?.entries.filter((entry): entry is FileChangeEntry => entry.kind === 'file-change') ??
      [],
    [snapshot]
  )

  const totals = useMemo(
    () =>
      files.reduce(
        (sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }),
        { added: 0, removed: 0 }
      ),
    [files]
  )

  return snapshot === null ? NO_CHANGES : { files, entries, totals }
}
