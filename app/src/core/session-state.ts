import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import type { ConversationEntry, ConversationRecovery } from '@shared/conversation'
import type { CoreError, MailboxSession } from '@shared/contract'
import { writeJsonAtomic } from './atomic'

/**
 * What a Session is doing, kept beside its Conversation so the inbox can be
 * answered without reading every Conversation back (ticket 12f).
 *
 * This is a projection, never a second opinion. Ticket 12 refused a stored
 * status precisely because one can disagree with the Conversation it
 * describes, so this carries the size of the journal it was derived from: any
 * divergence — a write that never landed, a crash between the two — is seen
 * and the projection is rebuilt from the journal, which stays the truth.
 */
export interface SessionState {
  activeRunId: string | null
  /** Unanswered Approval Requests, oldest first: the oldest is the one asked. */
  openApprovals: string[]
  /** The last thing anybody said, which is what an unanswered question is. */
  lastMessage: { role: 'user' | 'assistant'; suggested: boolean } | null
  /** How the last Run ended badly, when it did. */
  recovery: ConversationRecovery['category'] | null
  /** Bytes of the journal this was derived from. */
  journalBytes: number
}

const STATE = 'state.json'

export const EMPTY_STATE: SessionState = {
  activeRunId: null,
  openApprovals: [],
  lastMessage: null,
  recovery: null,
  journalBytes: 0
}

/** One more entry, folded into what the Session was already doing. */
export function advance(state: SessionState, entry: ConversationEntry): SessionState {
  if (entry.kind === 'boundary') {
    if (entry.boundary === 'run-started') {
      return { ...state, activeRunId: entry.runId, recovery: null }
    }
    if (entry.runId !== state.activeRunId) return state
    return { ...state, activeRunId: null, recovery: entry.recovery?.category ?? null }
  }
  if (entry.kind === 'approval') {
    const others = state.openApprovals.filter((id) => id !== entry.id)
    // Answered, or standing and waiting on somebody. The order is the order
    // they were asked in, because that is the order they are answered in.
    return {
      ...state,
      openApprovals: entry.decision === null ? [...others, entry.id] : others
    }
  }
  if (entry.kind === 'message') {
    return {
      ...state,
      lastMessage: { role: entry.role, suggested: entry.suggestedResponses.length > 0 }
    }
  }
  return state
}

/** The state a whole journal describes, used to rebuild a projection. */
export function deriveState(entries: ConversationEntry[], journalBytes: number): SessionState {
  return { ...entries.reduce(advance, EMPTY_STATE), journalBytes }
}

/**
 * What the inbox shows for a Session. The same rule ticket 12 wrote, reading
 * the projection rather than the whole Conversation.
 */
export function describeState(state: SessionState): Pick<MailboxSession, 'status' | 'waitingFor'> {
  if (state.openApprovals.length > 0) return { status: 'blocked', waitingFor: 'approval' }
  if (state.lastMessage?.role === 'assistant' && state.lastMessage.suggested) {
    return { status: 'blocked', waitingFor: 'question' }
  }
  if (state.activeRunId !== null) return { status: 'running', waitingFor: null }
  // A Run the person stopped is not a failure: they got what they asked for.
  if (state.recovery !== null && state.recovery !== 'stopped') {
    return { status: 'failed', waitingFor: null }
  }
  return { status: 'idle', waitingFor: null }
}

export function stateFile(sessionDirectory: string): string {
  return join(sessionDirectory, STATE)
}

/** How big the journal is now, which is what a projection is checked against. */
export function journalSize(journal: string): Effect.Effect<number> {
  return Effect.promise(() =>
    stat(journal).then(
      (info) => info.size,
      () => 0
    )
  )
}

export function writeState(
  sessionDirectory: string,
  state: SessionState
): Effect.Effect<void, CoreError> {
  return writeJsonAtomic(stateFile(sessionDirectory), state)
}
