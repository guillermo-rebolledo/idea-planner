import {
  MAX_SUBAGENT_TEXT,
  redactCredentials,
  type HarnessEvent,
  type SubagentStatus
} from '@shared/conversation'

/**
 * What both Adapters have to agree about when they report a subagent.
 *
 * The two Harnesses describe a subagent completely differently — Claude
 * addresses the Run with `task_*` frames, Codex gives the subagent a Harness
 * Thread of its own — but they report it the same way: by describing the whole
 * of it again every time, rather than by describing what changed. So each
 * Adapter accumulates a description, and every event is a snapshot of one.
 */
export interface Dispatch {
  /** The Harness's own id for the dispatch, which every later report names. */
  id: string
  name: string
  /** The kind of worker, when the Harness names one. */
  role?: string
  /** What it was sent to do. Absent where the Harness carries no prompt. */
  brief?: string
  status: SubagentStatus
  /** The one line saying what it is on now, while it is working. */
  activity?: string
  /** What it reported back. Set only once it has ended. */
  result?: string
  steps: number | null
  durationMs: number | null
}

/**
 * How much of that one line is kept. A step's description is written by a
 * model, and a card has one line to draw it on.
 */
export const MAX_SUBAGENT_ACTIVITY = 500

/**
 * The subagent as it stands, as the event the rest of the app reads. Bounded
 * and redacted here rather than at each call site: a brief and a report are
 * both model-written prose that has been nowhere near a length limit, and a
 * subagent is handed whatever the Run was handed, credentials included.
 */
export function subagentEvent(dispatch: Dispatch): HarnessEvent {
  return {
    type: 'subagent',
    id: dispatch.id,
    name: dispatch.name,
    ...(dispatch.role !== undefined ? { role: dispatch.role } : {}),
    ...(dispatch.brief !== undefined
      ? { brief: redactCredentials(dispatch.brief).slice(0, MAX_SUBAGENT_TEXT) }
      : {}),
    status: dispatch.status,
    ...(dispatch.activity !== undefined
      ? { activity: redactCredentials(dispatch.activity).slice(0, MAX_SUBAGENT_ACTIVITY) }
      : {}),
    ...(dispatch.result !== undefined
      ? { result: redactCredentials(dispatch.result).slice(0, MAX_SUBAGENT_TEXT) }
      : {}),
    steps: dispatch.steps,
    durationMs: dispatch.durationMs
  }
}

/**
 * What a Run ending leaves behind: a subagent still working reported nothing
 * back. Left working it would spin forever in a Run that has ended, and called
 * done it would claim an outcome nobody gave — so it is neither.
 */
export function interruptWorking(dispatches: Iterable<Dispatch>): HarnessEvent[] {
  const events: HarnessEvent[] = []
  for (const dispatch of dispatches) {
    if (dispatch.status !== 'working') continue
    dispatch.status = 'interrupted'
    events.push(subagentEvent(dispatch))
  }
  return events
}
