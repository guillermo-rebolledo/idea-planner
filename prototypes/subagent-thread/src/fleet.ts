/**
 * PROTOTYPE — throwaway. One scripted Run in which a Skill dispatches three
 * subagents, replayed on a clock so every variant can be judged while the
 * fleet is actually moving rather than in its finished state.
 *
 * Nothing here is a data model proposal. The shape is only rich enough to draw
 * the three candidate surfaces: an agent has a name, a task, a stream of steps
 * with times on them, and — once it ends — a result.
 */

export type SubagentState = 'pending' | 'working' | 'done' | 'failed'

/** The hue a subagent is drawn in, named in the app's roles, not in colours. */
export type SubagentTint = 'primary' | 'status-running' | 'positive' | 'status-blocked'

export interface SubagentStep {
  /** Seconds into the Run at which the step landed. */
  at: number
  text: string
}

export interface Subagent {
  id: string
  /** What the Run called it when it dispatched it. */
  name: string
  /** The kind of worker, in one word, for the mark and the header. */
  role: string
  tint: SubagentTint
  /** The one line the pill can afford: what this agent was sent to do. */
  task: string
  /** The dispatch prompt in full, which is what the focused view is for. */
  brief: string
  model: string
  startsAt: number
  endsAt: number
  outcome: 'done' | 'failed'
  steps: SubagentStep[]
  /** What it reported back, in the plain prose an agent actually returns. */
  result: string
}

/** The whole scripted Run, in seconds. It loops so it can be left running. */
export const RUN_LENGTH = 34

export const SUBAGENTS: Subagent[] = [
  {
    id: 'standards',
    name: 'Standards review',
    role: 'Reviewer',
    tint: 'positive',
    task: 'the committed diff against repository standards',
    brief:
      'Review the committed diff against docs/agents/code-style.md and the Fowler smell baseline. Report hard violations separately from judgement calls, and cite the standard each finding comes from.',
    model: 'claude-opus-5',
    startsAt: 2,
    endsAt: 18,
    outcome: 'done',
    steps: [
      { at: 3, text: 'Read docs/agents/code-style.md' },
      { at: 6, text: 'Read 14 changed files' },
      { at: 11, text: 'Checked 9 standards against the diff' },
      { at: 15, text: 'Re-read app/src/core/session-diff.ts' }
    ],
    result:
      'No findings. The diff has no hard violations of the cited repository standards and no actionable judgement-call smells from the supplied baseline.'
  },
  {
    id: 'spec',
    name: 'Spec review',
    role: 'Reviewer',
    tint: 'primary',
    task: "the diff against MEM-94's acceptance criteria",
    brief:
      "Check the diff against MEM-94's implementation contract and acceptance criteria. Flag anything the spec asked for that is missing, and anything present that the spec never asked for.",
    model: 'claude-opus-5',
    startsAt: 2,
    endsAt: 27,
    outcome: 'done',
    steps: [
      { at: 4, text: 'Read .scratch/MEM-94.md' },
      { at: 9, text: 'Mapped 6 acceptance criteria to the diff' },
      { at: 14, text: 'Traced criterion 4 to app/src/core/session-diff.ts' },
      { at: 21, text: 'Re-read the bounded diff contract' }
    ],
    result:
      "No spec gaps. All six acceptance criteria are covered, and nothing outside MEM-94's stated scope was touched."
  },
  {
    id: 'fixtures',
    name: 'Fixture sweep',
    role: 'Explorer',
    tint: 'status-running',
    task: 'whether the recorded Codex fixture still matches',
    brief:
      'Search app/tests for the recorded Codex contract fixture and report whether it still matches the generated protocol bindings.',
    model: 'claude-haiku-4-5',
    startsAt: 8,
    endsAt: 24,
    outcome: 'failed',
    steps: [
      { at: 12, text: 'Searched app/tests for codex fixtures' },
      { at: 17, text: 'Opened the contract fixture' },
      { at: 22, text: 'Compared it against codex-protocol/v2' }
    ],
    result:
      'Could not verify. The recorded Codex fixture is older than the protocol bindings it is checked against, so a mismatch here would not mean anything. Regenerate it with `pnpm codex:record` and send me back in.'
  }
]

/** What the subagent is at second `now`. */
export function stateAt(agent: Subagent, now: number): SubagentState {
  if (now < agent.startsAt) return 'pending'
  if (now < agent.endsAt) return 'working'
  return agent.outcome
}

/** How long it has been working, or how long it worked in the end. */
export function elapsedAt(agent: Subagent, now: number): number {
  return Math.max(0, Math.min(now, agent.endsAt) - agent.startsAt)
}

export function stepsAt(agent: Subagent, now: number): SubagentStep[] {
  return agent.steps.filter((step) => step.at <= now)
}

/** The agents that exist at all yet — a pill cannot precede its dispatch. */
export function dispatchedAt(now: number): Subagent[] {
  return SUBAGENTS.filter((agent) => now >= agent.startsAt)
}

export function formatSeconds(seconds: number): string {
  return `${Math.round(seconds)}s`
}

/** The tint, as the class pair every variant draws a mark with. */
export const TINT_INK: Record<SubagentTint, string> = {
  primary: 'text-primary',
  'status-running': 'text-status-running',
  positive: 'text-positive',
  'status-blocked': 'text-status-blocked'
}

export const STATE_TEXT: Record<SubagentState, string> = {
  pending: 'Queued',
  working: 'Working',
  done: 'Done',
  failed: 'Needs attention'
}

export const STATE_INK: Record<SubagentState, string> = {
  pending: 'text-muted-foreground',
  working: 'text-status-running',
  done: 'text-muted-foreground',
  failed: 'text-destructive'
}
