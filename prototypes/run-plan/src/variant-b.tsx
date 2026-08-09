/**
 * PROTOTYPE — throwaway.
 *
 * **B — One block, anchored where the plan first appeared.** The plan is part
 * of the story of the Run, so it is told in the transcript rather than in a
 * footer — but it is told once. The block lands at the point the agent first
 * wrote a plan, and every later rewrite mutates it in place. It never moves,
 * and it is never re-emitted below the prose that followed it.
 *
 * This is Codex's shape with its one terminal-imposed compromise refused.
 * Codex appends a block per `update_plan` because scrollback cannot be
 * mutated; the result is seven near-identical blocks and a transcript that
 * reads as a diff log of a list. A GUI has no such excuse, so the anchor is
 * fixed at the first sighting and the content is always the latest snapshot.
 *
 * What this variant is betting: where the plan *appeared* is the meaningful
 * position — it is the moment the Run stopped exploring and committed to a
 * shape — and everything after that is the same plan changing, not new plans.
 *
 * It opens by default and folds to its header, which keeps the count and the
 * step being worked on — a fold that left only the word "Plan" would cost the
 * reader the one thing they most likely wanted.
 *
 * What it costs: scroll away from the anchor and the plan is off screen, so
 * the live row underneath still has to say what the Run is on now. And the
 * rewrite at second 23 now happens somewhere the reader may not be looking,
 * which is exactly the thing the appended blocks were buying.
 */
import { Fragment, useId, useState } from 'react'
import { ChevronDown, ListChecks } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { StepCount, StepList, RunEntryRow } from './parts'
import {
  activeText,
  currentStep,
  entriesAt,
  isRunning,
  progress,
  rowKey,
  snapshotsAt,
  type PlanSnapshot
} from './plan'

export function VariantB({ now }: { now: number }): React.JSX.Element {
  const live = isRunning(now)
  const snapshots = snapshotsAt(now)
  const entries = entriesAt(now)

  /**
   * The anchor: where in the transcript the plan first appeared, fixed for the
   * rest of the Run. Later rewrites do not get a position of their own, so the
   * block cannot be pushed down the page by the prose that follows it.
   */
  const anchoredAt = snapshots.at(0)?.at ?? null
  const anchorIndex =
    anchoredAt === null
      ? -1
      : (() => {
          const at = entries.findIndex((entry) => entry.at >= anchoredAt)
          return at === -1 ? entries.length : at
        })()
  const latest = snapshots.at(-1) ?? null
  const running = latest === null ? null : currentStep(latest)

  /**
   * Open by default — a plan nobody has collapsed is worth reading, and a
   * checklist that arrived folded would be a checklist nobody knew arrived.
   * The state is held here rather than in the block because the block moves
   * branch once, when the first entry after the anchor arrives, and a person
   * who collapsed it should not have it spring open underneath them.
   */
  const [open, setOpen] = useState(true)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-6">
        <div className="self-end rounded-lg bg-muted px-3 py-2 text-sm">
          Wire the agent&rsquo;s checklist through both Adapters and show it in the Conversation.
        </div>

        {entries.map((entry, index) => (
          <Fragment key={`${entry.at}-${entry.text}`}>
            {index === anchorIndex && latest !== null && (
              <PlanBlock plan={latest} live={live} open={open} onOpen={setOpen} />
            )}
            <RunEntryRow entry={entry} />
          </Fragment>
        ))}

        {/* The plan can outlast the prose: nothing said since it landed. */}
        {anchorIndex === entries.length && latest !== null && (
          <PlanBlock plan={latest} live={live} open={open} onOpen={setOpen} />
        )}

        {/* The block does not follow the reader, so the live row still has to
            say what the Run is on now. */}
        {live && (
          <div className="flex items-center gap-2 pt-1 font-mono text-xs text-muted-foreground">
            <span className="size-[18px] shrink-0 animate-pulse rounded-full bg-status-running/70 motion-reduce:animate-none" />
            <span className="shimmer">{running === null ? 'Working…' : activeText(running)}</span>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The block. Its content is always the latest snapshot — the count, the steps,
 * and the reason the agent last gave for changing them.
 *
 * The whole header is the disclosure, and collapsing does not hide the plan so
 * much as reduce it: the count stays, and the step being worked on moves up
 * into the header. A fold that left only the word "Plan" would make collapsing
 * it cost the reader the one thing they most likely wanted.
 */
function PlanBlock({
  plan,
  live,
  open,
  onOpen
}: {
  plan: PlanSnapshot
  live: boolean
  open: boolean
  onOpen: (open: boolean) => void
}): React.JSX.Element {
  const counts = progress(plan)
  const running = currentStep(plan)
  const listId = useId()

  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          onOpen(!open)
        }}
        className="flex w-full items-center gap-2 text-left text-xs"
      >
        <ListChecks aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        {open ? (
          <span className="flex-1 text-muted-foreground">Plan</span>
        ) : (
          // Collapsed: the header carries the step, so the fold costs the
          // reader the list and nothing else.
          <span className="min-w-0 flex-1 truncate">
            {running !== null ? (
              <span className={cn('text-foreground', live && 'shimmer')}>
                {activeText(running)}
              </span>
            ) : (
              <span className="text-muted-foreground">
                {counts.done === counts.total ? 'Plan complete' : 'Plan'}
              </span>
            )}
          </span>
        )}
        <StepCount done={counts.done} total={counts.total} />
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>

      <div id={listId} hidden={!open}>
        {plan.explanation !== null && (
          <p className="pt-2 text-2xs text-muted-foreground italic">{plan.explanation}</p>
        )}
        <StepList
          steps={plan.steps}
          live={live}
          keyed={(index) => rowKey(plan.steps, index)}
          className="pt-2"
        />
      </div>
    </div>
  )
}
