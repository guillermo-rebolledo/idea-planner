import { useMemo } from 'react'
import type { ChangedFile, ConversationEntry, ConversationSnapshot } from '@shared/contract'
import type { LiveRun } from './selected-conversation-read-model'

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
export function sessionChanges(
  snapshot: ConversationSnapshot | null,
  live: LiveRun | null
): SessionChanges {
  if (snapshot === null) return NO_CHANGES
  const durableEntries = snapshot.entries.filter(
    (entry): entry is FileChangeEntry => entry.kind === 'file-change'
  )
  const durableIds = new Set(durableEntries.map((entry) => entry.id))
  const liveEntries: FileChangeEntry[] =
    live === null ? [] : live.changes.filter((change) => !durableIds.has(change.id))
  const filesByPath = new Map(
    snapshot.changedFiles.map((file) => [file.path, { ...file }] satisfies [string, ChangedFile])
  )
  for (const entry of liveEntries) {
    const known = filesByPath.get(entry.path)
    filesByPath.set(entry.path, {
      path: entry.path,
      changes: (known?.changes ?? 0) + 1,
      added: (known?.added ?? 0) + entry.added,
      removed: (known?.removed ?? 0) + entry.removed,
      changeKind: entry.changeKind,
      shortened: known?.shortened ?? false,
      reported: true
    })
  }
  const files = [...filesByPath.values()]
  return {
    files,
    entries: [...durableEntries, ...liveEntries],
    totals: files.reduce(
      (sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }),
      { added: 0, removed: 0 }
    )
  }
}

export function useSessionChanges(
  snapshot: ConversationSnapshot | null,
  live: LiveRun | null
): SessionChanges {
  return useMemo(() => sessionChanges(snapshot, live), [snapshot, live])
}
