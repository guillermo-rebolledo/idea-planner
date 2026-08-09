import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationSnapshot, RunSnapshot } from '@shared/contract'
import {
  SelectedConversationReadModel,
  conversationSelectedFor,
  type LiveRun,
  type SelectedConversationSnapshot
} from '@renderer/lib/selected-conversation-read-model'

export type ConversationPhase =
  { state: 'loading' } | { state: 'failed' } | { state: 'ready'; snapshot: ConversationSnapshot }

export interface SelectedConversation {
  phase: ConversationPhase
  snapshot: ConversationSnapshot | null
  runs: RunSnapshot[]
  live: LiveRun | null
  failureSummary: string | null
  refresh: () => Promise<ConversationSnapshot | null>
  adopt: (snapshot: ConversationSnapshot) => void
}

/** The sole renderer owner of the selected Session's durable Conversation. */
export function useSelectedConversation(sessionId: string | null): SelectedConversation {
  const ownerRef = useRef<SelectedConversationReadModel | null>(null)
  const [selected, setSelected] = useState<SelectedConversationSnapshot | null>(null)
  const [failedSessionId, setFailedSessionId] = useState<string | null>(null)

  useEffect(() => {
    setSelected(null)
    setFailedSessionId(null)
    if (sessionId === null) {
      ownerRef.current = null
      return
    }

    let isCurrentOwner = true
    const owner = new SelectedConversationReadModel(sessionId, {
      readConversation: () => window.shell.getConversation(sessionId),
      readRuns: () => window.shell.listRuns(sessionId),
      publish: (snapshot) => {
        if (!isCurrentOwner) return
        setSelected(snapshot)
        setFailedSessionId(null)
      },
      fail: () => {
        if (isCurrentOwner) setFailedSessionId(sessionId)
      },
      requestPaint: (callback) => window.requestAnimationFrame(callback),
      cancelPaint: (handle) => window.cancelAnimationFrame(handle),
      scheduleRefresh: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancelRefresh: (handle) => window.clearTimeout(handle as number)
    })
    ownerRef.current = owner
    const stop = window.shell.onConversationEvent((streamed) => {
      owner.push(streamed)
    })
    void owner.requestRefresh()
    return () => {
      isCurrentOwner = false
      stop()
      owner.dispose()
      if (ownerRef.current === owner) ownerRef.current = null
    }
  }, [sessionId])

  // Effects clear the previous owner's state after render. Key it here too so
  // a newly selected Session can never render its predecessor's Conversation.
  const currentSelected = conversationSelectedFor(sessionId, selected)
  const refresh = useCallback(async (): Promise<ConversationSnapshot | null> => {
    const selected = await ownerRef.current?.requestRefresh()
    return selected?.conversation ?? null
  }, [])

  const adopt = useCallback((snapshot: ConversationSnapshot): void => {
    const owner = ownerRef.current
    if (owner === null) return
    owner.adopt(snapshot)
    // The write result makes the Conversation live immediately. Its sequenced
    // follow-up also refreshes Run history when the active Run identity moved.
    void owner.requestRefresh()
  }, [])

  return {
    phase:
      currentSelected !== null
        ? { state: 'ready', snapshot: currentSelected.conversation }
        : failedSessionId === sessionId
          ? { state: 'failed' }
          : { state: 'loading' },
    snapshot: currentSelected?.conversation ?? null,
    runs: currentSelected?.runs ?? [],
    live: currentSelected?.live ?? null,
    failureSummary: currentSelected?.failureSummary ?? null,
    refresh,
    adopt
  }
}
