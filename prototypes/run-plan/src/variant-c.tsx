/**
 * PROTOTYPE — throwaway.
 *
 * **C — The plan is the header, and it shows what is left.** The plan is
 * pinned above the transcript and stays there for the whole Run. The
 * transcript scrolls under it.
 *
 * The other two variants both answer *what is it doing now?* This one answers
 * a different question — *how much is left, and what is coming?* — and so it
 * inverts the hierarchy: the current step and the pending ones are the band's
 * body, and the completed ones fold away behind their count, because a step
 * that is done is no longer something anybody is waiting for.
 *
 * What this variant is betting: on a long Run, "will this touch the thing I
 * care about?" is the question a person actually has, and answering it should
 * not cost a click.
 *
 * What it costs: a permanent band above the reading column, for a signal that
 * arrives roughly seven times in a Run — and a plan of fifteen steps has to be
 * bounded somehow, which is what the scroll cap in here is doing.
 */
import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { StepList, Transcript } from './parts'
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

export function VariantC({ now }: { now: number }): React.JSX.Element {
  const plan = planAt(now)
  const live = isRunning(now)

  return (
    <div className="flex h-full flex-col">
      {plan !== null && <PlanBand plan={plan} live={live} now={now} />}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Transcript entries={entriesAt(now)} />
      </div>
    </div>
  )
}

function PlanBand({
  plan,
  live,
  now
}: {
  plan: PlanSnapshot
  live: boolean
  now: number
}): React.JSX.Element {
  const [showDone, setShowDone] = useState(false)
  const counts = progress(plan)
  const step = currentStep(plan)

  const done = plan.steps.filter((entry) => entry.status === 'completed')
  const ahead = plan.steps.filter((entry) => entry.status !== 'completed')
  const aheadKey = (index: number): string => rowKey(ahead, index)

  return (
    <div className="shrink-0 border-b border-border bg-surface">
      <div className="mx-auto max-w-3xl px-4 py-2.5">
        <div className="flex items-baseline gap-2 pb-2">
          <span className="text-2xs tracking-wide text-muted-foreground uppercase">Plan</span>
          <span className="font-mono text-2xs text-muted-foreground tabular-nums">
            {counts.done}/{counts.total}
          </span>
          <span className="flex-1" />
          {live && step !== null && (
            <span className="min-w-0 truncate font-mono text-2xs text-status-running">
              {activeText(step)}
            </span>
          )}
          {live && (
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">
              {formatElapsed(now)}
            </span>
          )}
        </div>

        {/* Done folds away: nobody is waiting on a finished step. */}
        {done.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={showDone}
              onClick={() => {
                setShowDone(!showDone)
              }}
              className="flex items-center gap-1.5 pb-1.5 text-2xs text-muted-foreground hover:text-foreground"
            >
              <Check aria-hidden="true" className="size-3" />
              {done.length} done
              <ChevronDown
                aria-hidden="true"
                className={cn('size-3 transition-transform', showDone && 'rotate-180')}
              />
            </button>
            {showDone && (
              <StepList
                steps={done}
                live={false}
                keyed={(index) => rowKey(done, index)}
                className="pb-1.5"
              />
            )}
          </>
        )}

        {/* Bounded, so a fifteen-step plan cannot take the reading column. */}
        <StepList steps={ahead} live={live} keyed={aheadKey} className="max-h-40 overflow-y-auto" />

        {plan.explanation !== null && (
          <p className="pt-2 text-2xs text-muted-foreground italic">{plan.explanation}</p>
        )}
      </div>
    </div>
  )
}
