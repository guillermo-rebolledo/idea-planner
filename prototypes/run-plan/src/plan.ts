/**
 * PROTOTYPE — throwaway. One scripted Run that keeps a plan, replayed on a
 * clock so every variant is judged while the list is being rewritten rather
 * than in its finished state.
 *
 * The shape here is not a data model proposal, but it is deliberately faithful
 * to what the two Harnesses actually send, because the awkward parts of this
 * design come from that and nowhere else:
 *
 * - **The whole list arrives every time.** Neither Harness sends a delta, so a
 *   snapshot supersedes its predecessor and identity across the rewrite has to
 *   be recovered from the step text.
 * - **The agent rewrites the list mid-Run.** Snapshot 3 below inserts two
 *   steps and rewords a third — the case that separates a surface which
 *   animates a status change from one that flickers the whole list.
 * - **`activeForm` is Claude's and Codex has none.** So the present-continuous
 *   phrasing is optional, and a surface that depends on it has to say what it
 *   does when it is absent.
 *
 * Times are seconds into the Run. It loops so it can be left running.
 */

export type PlanStepStatus = 'pending' | 'in-progress' | 'completed'

export interface PlanStep {
  /** What the step is, imperative, as the agent wrote it. */
  step: string
  /**
   * What to call it while it is the one being worked on. Claude supplies this;
   * Codex does not, and the surface has to survive the `null`.
   */
  activeForm: string | null
  status: PlanStepStatus
}

export interface PlanSnapshot {
  /** Seconds into the Run at which this rewrite landed. */
  at: number
  /** Why the plan changed, when the Harness says. Codex's `explanation`. */
  explanation: string | null
  /** The whole plan, every time. */
  steps: PlanStep[]
}

/** The whole scripted Run, in seconds. The agent stops working at 56. */
export const RUN_LENGTH = 62
export const RUN_ENDS_AT = 56

const S = {
  map: 'Map where plan events enter the Adapters',
  normalise: 'Normalise both Harnesses into one plan event',
  /** Reworded at snapshot 3 — a reword reads as a delete plus an insert. */
  codexOld: 'Stop ignoring the Codex plan method',
  codexNew: 'Stop ignoring turn/plan/updated in the Codex Adapter',
  claude: 'Read the Claude Task tools into the same shape',
  project: 'Project the latest snapshot into the read model',
  draw: 'Draw the indicator in the Conversation',
  record: 'Record a fixture for each Harness'
} as const

const ACTIVE: Record<string, string> = {
  [S.map]: 'Mapping where plan events enter the Adapters',
  [S.normalise]: 'Normalising both Harnesses into one plan event',
  [S.codexOld]: 'Unignoring the Codex plan method',
  [S.codexNew]: 'Unignoring turn/plan/updated in the Codex Adapter',
  [S.claude]: 'Reading the Claude Task tools into the same shape',
  [S.project]: 'Projecting the latest snapshot into the read model',
  [S.draw]: 'Drawing the indicator in the Conversation',
  [S.record]: 'Recording a fixture for each Harness'
}

function steps(entries: [string, PlanStepStatus][]): PlanStep[] {
  return entries.map(([step, status]) => ({
    step,
    activeForm: ACTIVE[step] ?? null,
    status
  }))
}

export const SNAPSHOTS: PlanSnapshot[] = [
  {
    at: 7,
    explanation: null,
    steps: steps([
      [S.map, 'in-progress'],
      [S.normalise, 'pending'],
      [S.codexOld, 'pending'],
      [S.draw, 'pending'],
      [S.record, 'pending']
    ])
  },
  {
    at: 15,
    explanation: null,
    steps: steps([
      [S.map, 'completed'],
      [S.normalise, 'in-progress'],
      [S.codexOld, 'pending'],
      [S.draw, 'pending'],
      [S.record, 'pending']
    ])
  },
  {
    // The rewrite: two steps inserted, one reworded, in one snapshot.
    at: 23,
    explanation:
      'The Claude side needs its own reading, and the read model has to hold the latest snapshot, so both are steps of their own now.',
    steps: steps([
      [S.map, 'completed'],
      [S.normalise, 'completed'],
      [S.codexNew, 'in-progress'],
      [S.claude, 'pending'],
      [S.project, 'pending'],
      [S.draw, 'pending'],
      [S.record, 'pending']
    ])
  },
  {
    at: 32,
    explanation: null,
    steps: steps([
      [S.map, 'completed'],
      [S.normalise, 'completed'],
      [S.codexNew, 'completed'],
      [S.claude, 'in-progress'],
      [S.project, 'pending'],
      [S.draw, 'pending'],
      [S.record, 'pending']
    ])
  },
  {
    at: 40,
    explanation: null,
    steps: steps([
      [S.map, 'completed'],
      [S.normalise, 'completed'],
      [S.codexNew, 'completed'],
      [S.claude, 'completed'],
      [S.project, 'completed'],
      [S.draw, 'in-progress'],
      [S.record, 'pending']
    ])
  },
  {
    at: 49,
    explanation: null,
    steps: steps([
      [S.map, 'completed'],
      [S.normalise, 'completed'],
      [S.codexNew, 'completed'],
      [S.claude, 'completed'],
      [S.project, 'completed'],
      [S.draw, 'completed'],
      [S.record, 'in-progress']
    ])
  },
  {
    at: 55,
    explanation: null,
    steps: steps([
      [S.map, 'completed'],
      [S.normalise, 'completed'],
      [S.codexNew, 'completed'],
      [S.claude, 'completed'],
      [S.project, 'completed'],
      [S.draw, 'completed'],
      [S.record, 'completed']
    ])
  }
]

/**
 * The Run around the plan. Without it every variant is judged in a vacuum, and
 * the whole question is what the plan costs the prose it sits next to.
 */
export interface RunEntry {
  at: number
  kind: 'prose' | 'command' | 'write'
  text: string
}

export const RUN_ENTRIES: RunEntry[] = [
  {
    at: 1,
    kind: 'prose',
    text: 'Both Harnesses already send the checklist and this app throws both away, so the work is an Adapter mapping and one new surface. Let me lay out the steps first.'
  },
  { at: 9, kind: 'command', text: 'rg -n "IGNORED_METHODS" app/src/core/harness' },
  { at: 12, kind: 'write', text: 'app/src/shared/conversation.ts' },
  {
    at: 17,
    kind: 'prose',
    text: 'The `subagent` event already makes the same bargain — the whole state travels every time — so the plan event is modelled on it rather than on `command`.'
  },
  { at: 20, kind: 'command', text: 'pnpm --filter argos-desktop typecheck' },
  { at: 25, kind: 'write', text: 'app/src/core/harness/codex.ts' },
  {
    at: 28,
    kind: 'prose',
    text: '`turn/plan/updated` comes out of the ignore list; `item/plan/delta` stays in it, since that one is plan mode and its own bindings warn that concatenated deltas need not match the finished item.'
  },
  { at: 34, kind: 'write', text: 'app/src/core/harness/claude.ts' },
  {
    at: 36,
    kind: 'prose',
    text: 'TodoWrite is off by default on the installed CLI, so the Claude reading is the four Task tools, projected into a snapshot on this side. TodoWrite stays as the fallback for the older band.'
  },
  { at: 42, kind: 'write', text: 'app/src/renderer/src/components/Conversation.tsx' },
  { at: 46, kind: 'command', text: 'pnpm codex:record' },
  { at: 51, kind: 'command', text: 'pnpm verify' }
]

/** The plan as of second `now` — latest snapshot wins, nothing is assembled. */
export function planAt(now: number): PlanSnapshot | null {
  return SNAPSHOTS.filter((snapshot) => snapshot.at <= now).at(-1) ?? null
}

/** Every rewrite so far, which is the one thing variant B needs and A does not. */
export function snapshotsAt(now: number): PlanSnapshot[] {
  return SNAPSHOTS.filter((snapshot) => snapshot.at <= now)
}

export function entriesAt(now: number): RunEntry[] {
  return RUN_ENTRIES.filter((entry) => entry.at <= now)
}

export function isRunning(now: number): boolean {
  return now < RUN_ENDS_AT
}

/** `3/7`, computed the way both real clients compute it. */
export function progress(snapshot: PlanSnapshot): { done: number; total: number } {
  return {
    done: snapshot.steps.filter((step) => step.status === 'completed').length,
    total: snapshot.steps.length
  }
}

/**
 * What the Run is on now. `activeForm` when the Harness supplied one, the step
 * itself otherwise — inventing a tense for Codex would be writing prose the
 * agent did not write.
 */
export function currentStep(snapshot: PlanSnapshot): PlanStep | null {
  return snapshot.steps.find((step) => step.status === 'in-progress') ?? null
}

export function activeText(step: PlanStep): string {
  return step.activeForm ?? step.step
}

/**
 * The identity a row keeps across a wholesale rewrite: the step text, never
 * the index and never anything containing the status. Duplicated texts get an
 * occurrence ordinal, because falling back to the index would re-key every row
 * after an insertion.
 */
export function rowKey(steps: PlanStep[], index: number): string {
  const step = steps[index] as PlanStep
  const occurrence = steps.slice(0, index).filter((other) => other.step === step.step).length
  return occurrence === 0 ? step.step : `${step.step}#${occurrence + 1}`
}

export const STATUS_TEXT: Record<PlanStepStatus, string> = {
  pending: 'Not started',
  'in-progress': 'In progress',
  completed: 'Done'
}

export function formatElapsed(seconds: number): string {
  const whole = Math.floor(seconds)
  if (whole < 60) return `${whole}s`
  return `${Math.floor(whole / 60)}m ${whole % 60}s`
}
