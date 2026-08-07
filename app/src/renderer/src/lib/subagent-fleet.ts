/**
 * A Run's subagents as the dock draws them, and the two questions it asks of
 * one. Assembling a fleet is the read model's job — it is the owner of durable
 * and streamed Conversation state, and a fleet is exactly the two reconciled.
 */
import type { ConversationEntry, SubagentStatus } from '@shared/contract'

export type SubagentEntry = Extract<ConversationEntry, { kind: 'subagent' }>

export interface FleetMember {
  /** The Harness's own id for the dispatch, and this member's identity. */
  dispatchId: string
  name: string
  role: string | null
  /** What it was sent to do. Null under a Harness that carries no brief. */
  brief: string | null
  status: SubagentStatus
  /** What it is on now, while it works. */
  activity: string | null
  /** What it reported back, once it ended. */
  result: string | null
  steps: number | null
  /** Null for a subagent seen only in the stream, before its first write. */
  startedAt: string | null
  durationMs: number | null
}

/** How long it has worked, or worked in the end. Null when nothing dates it. */
export function elapsedMs(member: FleetMember, now: number): number | null {
  if (member.durationMs !== null) return member.durationMs
  if (member.startedAt === null) return null
  return Math.max(0, now - Date.parse(member.startedAt))
}

/** What the fleet as a whole is doing, which is all the pill has room for. */
export function fleetSummary(fleet: FleetMember[]): { working: number; failed: number } {
  return {
    working: fleet.filter((member) => member.status === 'working').length,
    failed: fleet.filter((member) => member.status === 'failed').length
  }
}
