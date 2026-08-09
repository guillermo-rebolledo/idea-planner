/**
 * PROTOTYPE — throwaway. The pieces every variant needs and none of them
 * disagrees about: what one step of a plan looks like, and enough of a
 * Conversation around it to judge what the plan costs the prose.
 *
 * The three variants disagree about *where* the plan lives and when it is
 * legible. They do not disagree about what a step says, so a step is written
 * once and framed three ways.
 *
 * Two house rules are already settled and are obeyed here rather than
 * re-litigated per variant:
 *
 * - **A completed step is not green.** `SubagentDock.tsx` spends this app's
 *   roles elsewhere — green is an addition, red is a deletion or a failure —
 *   so done is carried by the strike-through and the mute, as both real
 *   clients carry it.
 * - **State is text, not colour.** Each row says `Done` / `In progress` /
 *   `Not started` in visually-hidden prose beside an `aria-hidden` mark, which
 *   is the pattern `StatusMark` already uses.
 */
import { Check, Terminal, FileText } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { STATUS_TEXT, type PlanStep, type RunEntry } from './plan'

/**
 * The mark: a check when done, this app's one running colour when in flight,
 * an empty ring when it has not been reached. No numerals — the ordinal is the
 * row's position and repeating it costs a column.
 */
export function StepMark({
  status,
  live
}: {
  status: PlanStep['status']
  live: boolean
}): React.JSX.Element {
  if (status === 'completed') {
    return <Check aria-hidden="true" className="mt-px size-3.5 shrink-0 text-muted-foreground/70" />
  }
  if (status === 'in-progress') {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'mt-1 grid size-3.5 shrink-0 place-items-center rounded-full',
          'text-status-running'
        )}
      >
        <span
          className={cn(
            'size-2 rounded-full bg-current',
            live && 'animate-pulse motion-reduce:animate-none'
          )}
        />
      </span>
    )
  }
  return (
    <span aria-hidden="true" className="mt-1 size-3.5 shrink-0 rounded-full border border-border" />
  )
}

/**
 * One step. `live` is whether the Run is still going: the shimmer and the
 * pulse are claims about the present, and a finished Run has no present.
 */
export function StepRow({
  step,
  live,
  size = 'sm'
}: {
  step: PlanStep
  live: boolean
  size?: 'sm' | 'md'
}): React.JSX.Element {
  return (
    <li
      className={cn(
        'flex items-start gap-2 transition-colors duration-200',
        size === 'sm' ? 'text-xs' : 'text-sm'
      )}
    >
      <StepMark status={step.status} live={live} />
      <span
        className={cn(
          'min-w-0',
          step.status === 'completed' && 'text-muted-foreground line-through',
          step.status === 'pending' && 'text-muted-foreground',
          step.status === 'in-progress' && 'text-foreground',
          step.status === 'in-progress' && live && 'shimmer'
        )}
      >
        {step.step}
      </span>
      <span className="sr-only">{STATUS_TEXT[step.status]}</span>
    </li>
  )
}

/**
 * The whole list. An `<ol>` because the steps are ordered, and deliberately
 * not a live region: a person who has opened the list is reading it, and
 * announcing seven rows on every rewrite is unusable.
 */
export function StepList({
  steps,
  live,
  keyed,
  size = 'sm',
  className
}: {
  steps: PlanStep[]
  live: boolean
  keyed: (index: number) => string
  size?: 'sm' | 'md'
  className?: string
}): React.JSX.Element {
  return (
    <ol className={cn('flex flex-col gap-1.5', className)}>
      {steps.map((step, index) => (
        <StepRow key={keyed(index)} step={step} live={live} size={size} />
      ))}
    </ol>
  )
}

/** `3/7`. A count, never a bar: the steps are not equal-sized. */
export function StepCount({ done, total }: { done: number; total: number }): React.JSX.Element {
  return (
    <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
      {done}/{total}
    </span>
  )
}

/** Context, not design: the Run's prose and tool traffic, at honest density. */
export function Transcript({
  entries,
  children
}: {
  entries: RunEntry[]
  /** Anything a variant wants interleaved into the prose, already positioned. */
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-6">
      <UserMessage />
      {entries.map((entry) => (
        <RunEntryRow key={`${entry.at}-${entry.text}`} entry={entry} />
      ))}
      {children}
    </div>
  )
}

function UserMessage(): React.JSX.Element {
  return (
    <div className="self-end rounded-lg bg-muted px-3 py-2 text-sm">
      Wire the agent&rsquo;s checklist through both Adapters and show it in the Conversation.
    </div>
  )
}

export function RunEntryRow({ entry }: { entry: RunEntry }): React.JSX.Element {
  if (entry.kind === 'prose') {
    return <p className="text-sm leading-relaxed text-foreground">{entry.text}</p>
  }
  const Icon = entry.kind === 'command' ? Terminal : FileText
  return (
    <div className="flex items-center gap-2 font-mono text-2xs text-muted-foreground">
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">
        {entry.kind === 'write' ? `Wrote ${entry.text}` : entry.text}
      </span>
    </div>
  )
}
