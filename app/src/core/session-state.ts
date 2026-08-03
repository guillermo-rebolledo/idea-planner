import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import { z } from 'zod'
import { conversationRecoverySchema, type ConversationEntry } from '@shared/conversation'
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
export const sessionStateSchema = z.object({
  activeRunId: z.string().nullable(),
  /** Unanswered Approval Requests, oldest first: the oldest is the one asked. */
  openApprovals: z.array(z.string()),
  /** The last thing anybody said, which is what an unanswered question is. */
  lastMessage: z
    .object({
      id: z.string(),
      role: z.enum(['user', 'assistant']),
      suggested: z.boolean()
    })
    .nullable(),
  /**
   * Message ids lately seen, so a message re-appended while it streams is
   * known for what it is rather than mistaken for a new one. The journal is
   * read back with one entry per id, keeping each at the position it first
   * appeared — and a fold that did not know that would say the person's reply
   * came before the answer they were replying to.
   */
  recentMessageIds: z.array(z.string()),
  /** How the last Run ended badly, when it did. */
  recovery: conversationRecoverySchema.nullable(),
  /**
   * The active Run's commands still running, entry id → when each started, so
   * a finish can be timed against its start without reading the journal back.
   * Reset when a Run starts; an id written again finished has left.
   */
  runningCommands: z.record(z.string(), z.string()),
  /**
   * How many durable steps the active Run has taken so far, for the ordinal
   * ids the next step gets. Counted here so a long Run does not pay a full
   * journal read per step.
   */
  runReads: z.number().int().nonnegative(),
  runFileChanges: z.number().int().nonnegative(),
  /** Bytes of the journal this was derived from. */
  journalBytes: z.number().int().nonnegative()
})
export type SessionState = z.infer<typeof sessionStateSchema>

/** A projection as it was written, or nothing anybody should act on. */
export function readSessionState(text: string): SessionState | null {
  try {
    const parsed = sessionStateSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const STATE = 'state.json'

/**
 * How far back a message can be written again and still be recognised. Only a
 * message still streaming is ever rewritten, and streaming only ever touches
 * the newest, so this is far more room than the case needs.
 */
const RECENT_MESSAGES = 50

export const EMPTY_STATE: SessionState = {
  activeRunId: null,
  openApprovals: [],
  lastMessage: null,
  recentMessageIds: [],
  recovery: null,
  runningCommands: {},
  runReads: 0,
  runFileChanges: 0,
  journalBytes: 0
}

/** One more entry, folded into what the Session was already doing. */
export function advance(state: SessionState, entry: ConversationEntry): SessionState {
  if (entry.kind === 'boundary') {
    if (entry.boundary === 'run-started') {
      // A new Run starts its own count of steps and running commands.
      return {
        ...state,
        activeRunId: entry.runId,
        recovery: null,
        runningCommands: {},
        runReads: 0,
        runFileChanges: 0
      }
    }
    if (entry.runId !== state.activeRunId) return state
    return { ...state, activeRunId: null, recovery: entry.recovery }
  }
  // Steps are counted only for the Run the Session is on: a late entry from
  // an earlier Run must not inflate the active one's ordinals.
  if (entry.kind === 'command') {
    if (entry.runId !== state.activeRunId) return state
    if (entry.running) {
      return { ...state, runningCommands: { ...state.runningCommands, [entry.id]: entry.at } }
    }
    if (!(entry.id in state.runningCommands)) return state
    return {
      ...state,
      runningCommands: Object.fromEntries(
        Object.entries(state.runningCommands).filter(([id]) => id !== entry.id)
      )
    }
  }
  if (entry.kind === 'read') {
    return entry.runId === state.activeRunId ? { ...state, runReads: state.runReads + 1 } : state
  }
  if (entry.kind === 'file-change') {
    return entry.runId === state.activeRunId
      ? { ...state, runFileChanges: state.runFileChanges + 1 }
      : state
  }
  if (entry.kind === 'approval') {
    // The order is the order they were asked in, because that is the order
    // they are answered in — so a request written again while it still stands
    // keeps its place rather than going to the back of the queue.
    if (entry.decision !== null) {
      return { ...state, openApprovals: state.openApprovals.filter((id) => id !== entry.id) }
    }
    if (state.openApprovals.includes(entry.id)) return state
    return { ...state, openApprovals: [...state.openApprovals, entry.id] }
  }
  if (entry.kind === 'message') {
    const said = { id: entry.id, role: entry.role, suggested: entry.suggestedResponses.length > 0 }
    // The same message again, still the last thing said: a streaming message
    // is written repeatedly as it grows.
    if (state.lastMessage?.id === entry.id) return { ...state, lastMessage: said }
    // One written again after somebody else has since spoken. It is not the
    // last thing said, and treating it as one would hide the reply.
    if (state.recentMessageIds.includes(entry.id)) return state
    return {
      ...state,
      lastMessage: said,
      recentMessageIds: [...state.recentMessageIds, entry.id].slice(-RECENT_MESSAGES)
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
  if (state.recovery !== null && state.recovery.category !== 'stopped') {
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
