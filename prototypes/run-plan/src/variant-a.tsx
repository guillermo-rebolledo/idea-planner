/**
 * PROTOTYPE — throwaway.
 *
 * **A — The working row grows.** The Conversation gains no new surface at all.
 * `RunWorkingIndicator` already asks the question the plan answers — *what is
 * it doing now?* — and answers it today with the last command or write. A plan
 * is a strictly better answer to that same question, so the row keeps its
 * shape (orb, one line, elapsed) and gains two things: the count, and a
 * disclosure that opens the list in place, pushing the transcript up rather
 * than covering it.
 *
 * What this variant is betting: a checklist that updates a handful of times
 * per Run does not deserve permanent screen real estate, and the one row the
 * app already spends on "in flight" is enough to carry it.
 *
 * What it costs: the plan is invisible unless you open it, and it is gone
 * entirely once the Run ends — so this variant also writes the finished list
 * into the transcript once, at the end, as the record of what the Run set out
 * to do.
 */
import { useState } from 'react'
import { ChevronDown, ListChecks } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { StepCount, StepList, Transcript } from './parts'
import {
  activeText,
  currentStep,
  entriesAt,
  formatElapsed,
  isRunning,
  planAt,
  progress,
  rowKey,
  type PlanSnapshot
} from './plan'

export function VariantA({ now }: { now: number }): React.JSX.Element {
  const plan = planAt(now)
  const live = isRunning(now)

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Transcript entries={entriesAt(now)}>
          {/* The record, written once when the Run lands — the live row goes
              away with the Run, and what it set out to do is worth re-reading. */}
          {!live && plan !== null && <FinishedPlanEntry plan={plan} />}
        </Transcript>
      </div>

      {live && (
        <div className="shrink-0 border-t border-border px-4 py-2.5">
          <div className="mx-auto max-w-3xl">
            <WorkingRow plan={plan} now={now} />
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The row as it exists today, plus the plan. When there is no plan — which is
 * most Runs — it falls back to exactly what it says now, so nothing regresses.
 */
function WorkingRow({ plan, now }: { plan: PlanSnapshot | null; now: number }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const step = plan === null ? null : currentStep(plan)
  const counts = plan === null ? null : progress(plan)
  const line = step !== null ? activeText(step) : 'Working…'

  return (
    <div className="flex flex-col gap-2">
      {open && plan !== null && (
        <div className="pl-[30px]">
          {plan.explanation !== null && (
            <p className="pb-2 text-2xs text-muted-foreground italic">{plan.explanation}</p>
          )}
          <StepList
            steps={plan.steps}
            live
            keyed={(index) => rowKey(plan.steps, index)}
            className="pb-1"
          />
        </div>
      )}

      <div role="status" className="flex items-center gap-2.5 font-mono text-xs">
        <FakeOrb />
        {/* Only the summary is announced, and only politely: the shape the row
            already shows, not the seven rows behind it. */}
        <span aria-live="polite" className="min-w-0 flex-1 truncate">
          <span className="shimmer">{line}</span>
        </span>
        {counts !== null && <StepCount done={counts.done} total={counts.total} />}
        <span className="shrink-0 text-2xs text-muted-foreground">{formatElapsed(now)}</span>
        {plan !== null && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Hide the plan' : 'Show the plan'}
            onClick={() => {
              setOpen(!open)
            }}
            className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronDown
              aria-hidden="true"
              className={cn('size-3.5 transition-transform', open && 'rotate-180')}
            />
          </button>
        )}
      </div>
    </div>
  )
}

/** The Run's own orb, stood in for so the prototype owns no app dependency. */
function FakeOrb(): React.JSX.Element {
  return (
    <span
      aria-label="Run in progress"
      className="size-[18px] shrink-0 animate-pulse rounded-full bg-status-running/70 motion-reduce:animate-none"
    />
  )
}

function FinishedPlanEntry({ plan }: { plan: PlanSnapshot }): React.JSX.Element {
  const counts = progress(plan)
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
        <ListChecks aria-hidden="true" className="size-3.5" />
        <span className="flex-1">Plan</span>
        <StepCount done={counts.done} total={counts.total} />
      </div>
      <StepList steps={plan.steps} live={false} keyed={(index) => rowKey(plan.steps, index)} />
    </div>
  )
}
