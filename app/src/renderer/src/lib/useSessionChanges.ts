import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChangedFile, ConversationEntry } from '@shared/contract'

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
 * What this Session has done to its Checkout, kept live. The durable
 * Conversation is the source — the same record the Files panel quotes — and
 * it is re-read whenever the stream says something happened in this Session,
 * so the title-bar numbers and the panel never disagree with each other.
 */
export function useSessionChanges(sessionId: string | null): SessionChanges {
  const [files, setFiles] = useState<ChangedFile[]>([])
  const [entries, setEntries] = useState<FileChangeEntry[]>([])
  const [activeRunId, setActiveRunId] = useState<string | null>(null)

  const read = useCallback(async (): Promise<void> => {
    if (sessionId === null) return
    try {
      const snapshot = await window.shell.getConversation(sessionId)
      setFiles(snapshot.changedFiles)
      setEntries(snapshot.entries.filter((entry) => entry.kind === 'file-change'))
      setActiveRunId(snapshot.activeRunId)
    } catch {
      // The Conversation being unreadable is reported by the Conversation
      // surface itself; the cluster just has nothing to add up yet.
    }
  }, [sessionId])

  useEffect(() => {
    if (sessionId === null) {
      setFiles([])
      setEntries([])
      setActiveRunId(null)
      return
    }
    void read()
    let timer = 0
    const stop = window.shell.onConversationEvent((streamed) => {
      if (streamed.sessionId !== sessionId) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void read(), 200)
    })
    return () => {
      window.clearTimeout(timer)
      stop()
    }
  }, [sessionId, read])

  // While a Run is open, re-read on a clock as well: the quiet changes a
  // command made are found by comparing the Checkout after the last stream
  // event, so the read that sees the Run closed is the one that has them.
  useEffect(() => {
    if (sessionId === null || activeRunId === null) return
    const timer = window.setInterval(() => void read(), 750)
    return () => window.clearInterval(timer)
  }, [sessionId, activeRunId, read])

  const totals = useMemo(
    () =>
      files.reduce(
        (sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }),
        { added: 0, removed: 0 }
      ),
    [files]
  )

  return sessionId === null ? NO_CHANGES : { files, entries, totals }
}
