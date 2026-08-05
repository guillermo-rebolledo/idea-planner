import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationSnapshot, RunSnapshot } from '@shared/contract'
import {
  ConversationRefresh,
  conversationSelectedFor,
  type SelectedConversationSnapshot
} from '@renderer/lib/conversation-refresh'

export type ConversationPhase =
  { state: 'loading' } | { state: 'failed' } | { state: 'ready'; snapshot: ConversationSnapshot }

export interface SelectedConversation {
  phase: ConversationPhase
  snapshot: ConversationSnapshot | null
  runs: RunSnapshot[]
  refresh: () => Promise<void>
  adopt: (snapshot: ConversationSnapshot) => void
}

/** The sole renderer owner of the selected Session's durable Conversation. */
export function useSelectedConversation(sessionId: string | null): SelectedConversation {
  const ownerRef = useRef<ConversationRefresh | null>(null)
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
    const owner = new ConversationRefresh(sessionId, {
      readConversation: () => window.shell.getConversation(sessionId),
      readRuns: () => window.shell.listRuns(sessionId),
      publish: (snapshot) => {
        if (!isCurrentOwner) return
        setSelected(snapshot)
        setFailedSessionId(null)
      },
      fail: () => {
        if (isCurrentOwner) setFailedSessionId(sessionId)
      }
    })
    ownerRef.current = owner
    void owner.request()

    let eventTimer = 0
    const stop = window.shell.onConversationEvent((streamed) => {
      if (streamed.sessionId !== sessionId) return
      window.clearTimeout(eventTimer)
      eventTimer = window.setTimeout(() => void owner.request(), 200)
    })
    return () => {
      isCurrentOwner = false
      window.clearTimeout(eventTimer)
      stop()
      if (ownerRef.current === owner) ownerRef.current = null
    }
  }, [sessionId])

  // Effects clear the previous owner's state after render. Key it here too so
  // a newly selected Session can never render its predecessor's Conversation.
  const currentSelected = conversationSelectedFor(sessionId, selected)
  const activeRunId = currentSelected?.conversation.activeRunId ?? null
  useEffect(() => {
    if (activeRunId === null) return
    const timer = window.setInterval(() => void ownerRef.current?.request(), 750)
    return () => window.clearInterval(timer)
  }, [activeRunId])

  const refresh = useCallback(async (): Promise<void> => {
    await ownerRef.current?.request()
  }, [])

  const adopt = useCallback((snapshot: ConversationSnapshot): void => {
    const owner = ownerRef.current
    if (owner === null) return
    owner.adopt(snapshot)
    // The write result makes the Conversation live immediately. Its sequenced
    // follow-up also refreshes Run history when the active Run identity moved.
    void owner.request()
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
    refresh,
    adopt
  }
}
