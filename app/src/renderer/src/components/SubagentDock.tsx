/**
 * The subagents a Run dispatched, as a dock beside the transcript.
 *
 * A Run that delegates produces a second kind of work: not steps it took, but
 * agents it sent. Those agents report themselves many times a minute, and
 * threading each report into the transcript would bury the prose the
 * transcript is for. So the Conversation says one thing about them — a pill —
 * and the fleet itself lives here.
 *
 * The dock borrows both of its manners from surfaces this app already has, so
 * there is nothing new to learn:
 *
 * - It opens beside the transcript rather than over it and resizes from its
 *   own left edge, by pointer or by arrow key, exactly as the Files panel
 *   does.
 * - It collapses to a rail rather than to nothing, as the inbox does. A fleet
 *   that vanished when it was in the way would leave nobody able to notice
 *   that an agent had failed, so the rail keeps every agent's mark and state
 *   on screen, and clicking one opens the dock straight onto it.
 *
 * There is deliberately no progress bar. Neither Harness reports how much of a
 * subagent's work is left — it does not know — and a bar advancing on elapsed
 * time would be inventing a denominator. What can be said honestly is the
 * state, the step it is on, how long it has been, and how many steps it took.
 */
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Bot, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import type { SubagentStatus } from '@shared/contract'
import { elapsedMs, fleetSummary, type FleetMember } from '@renderer/lib/subagent-fleet'
import { cn } from '@renderer/lib/utils'

/** How wide the dock opens, and how far it may be dragged either way. */
const DEFAULT_WIDTH = 340
const MIN_WIDTH = 280
const MAX_WIDTH = 560
/** One keyboard step of the resize handle, as the Files panel uses. */
const RESIZE_STEP = 24
/** The rail is a column of marks, and is as wide as one mark needs. */
const RAIL_WIDTH = 44

const STATUS_TEXT: Record<SubagentStatus, string> = {
  working: 'Working',
  done: 'Done',
  failed: 'Needs attention',
  interrupted: 'Stopped'
}

const STATUS_INK: Record<SubagentStatus, string> = {
  working: 'text-status-running',
  done: 'text-muted-foreground',
  failed: 'text-destructive',
  interrupted: 'text-muted-foreground'
}

/**
 * Every subagent wears the same mark. Colouring them apart would spend this
 * app's roles — green is an addition, red is a deletion or a failure — on
 * telling two agents apart, which their names already do.
 */
function AgentMark({ size = 'sm' }: { size?: 'sm' | 'md' }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-muted text-muted-foreground',
        size === 'sm' ? 'size-4' : 'size-6'
      )}
    >
      <Bot className={size === 'sm' ? 'size-2.5' : 'size-3.5'} />
    </span>
  )
}

function StatusMark({ status }: { status: SubagentStatus }): React.JSX.Element {
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5 text-2xs', STATUS_INK[status])}>
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 rounded-full bg-current',
          status === 'working' && 'animate-pulse motion-reduce:animate-none'
        )}
      />
      {STATUS_TEXT[status]}
    </span>
  )
}

function formatElapsed(ms: number): string {
  if (ms < 1_000) return '<1s'
  const seconds = Math.round(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/**
 * A clock that only runs while something is working, so a Session at rest
 * costs nothing and a fleet in flight still counts up.
 */
function useTicking(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, 1_000)
    return () => {
      window.clearInterval(timer)
    }
  }, [active])
  return now
}

/**
 * The Conversation's whole mention of the fleet: how many were dispatched, how
 * many are still going, and the way in. It toggles, so the same control that
 * opens the dock puts it back on its rail.
 */
export function SubagentPill({
  fleet,
  expanded,
  onToggle
}: {
  fleet: FleetMember[]
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { working, failed } = fleetSummary(fleet)
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className={cn(
        // Open is said with the quiet fill alone: the ring is this app's focus
        // colour, and a pill wearing it while nothing is focused would be
        // talking about the keyboard.
        'inline-flex w-fit items-center gap-2 rounded-full border border-border py-1 pr-3 pl-1.5 text-xs',
        'hover:border-muted-foreground/40 hover:bg-muted',
        expanded && 'bg-muted'
      )}
    >
      {/* The marks overlap: a fleet is one thing with members, and a row of
          separate chips would read as several dispatches. */}
      <span className="flex shrink-0 -space-x-1.5">
        {fleet.slice(0, 4).map((member) => (
          <span key={member.dispatchId} className="rounded-full ring-2 ring-background">
            <AgentMark />
          </span>
        ))}
      </span>
      <span className={cn(working > 0 && 'shimmer')}>
        {fleet.length} {fleet.length === 1 ? 'subagent' : 'subagents'} created
      </span>
      <span
        className={cn(
          'font-mono text-2xs',
          failed > 0 ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        {working > 0
          ? `${working} working`
          : failed > 0
            ? `${failed} needs attention`
            : 'all landed'}
      </span>
    </button>
  )
}

function CollapseButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label="Collapse the Subagents dock"
      aria-expanded
      onClick={onClick}
      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <PanelRightClose aria-hidden="true" className="size-4" />
    </button>
  )
}

/**
 * What one subagent amounts to at a glance: who it is, what it is on now, and
 * how far it has got. Written in spans throughout so the same summary reads
 * correctly inside the dock's card, which is a button, and inside the rail's
 * hover preview, which is not.
 */
function SubagentSummary({ member, now }: { member: FleetMember; now: number }): React.JSX.Element {
  const elapsed = elapsedMs(member, now)
  // While it works, what it is on now; once it has ended, what it came back
  // with. Never both: the card has one line, and the newer fact wins it.
  const line = member.status === 'working' ? member.activity : member.result
  return (
    <>
      <span className="flex items-center gap-2">
        <AgentMark />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{member.name}</span>
        {elapsed !== null && (
          <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
            {formatElapsed(elapsed)}
          </span>
        )}
      </span>

      {line !== null && (
        <span
          className={cn(
            'mt-1.5 line-clamp-2 text-2xs text-muted-foreground',
            member.status === 'working' && 'shimmer'
          )}
        >
          {line}
        </span>
      )}

      <span className="mt-2 flex items-center gap-2">
        <StatusMark status={member.status} />
        {member.steps !== null && (
          <span className="ml-auto shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
            {member.steps} {member.steps === 1 ? 'step' : 'steps'}
          </span>
        )}
      </span>
    </>
  )
}

function FleetCard({
  member,
  now,
  onOpen
}: {
  member: FleetMember
  now: number
  onOpen: () => void
}): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full rounded-lg border border-border bg-surface-raised p-2.5 text-left hover:border-muted-foreground/40"
      >
        <SubagentSummary member={member} now={now} />
      </button>
    </li>
  )
}

/** One subagent, focused: what it was sent to do, and what came back. */
function SubagentThread({
  member,
  now,
  onBack,
  onCollapse
}: {
  member: FleetMember
  now: number
  onBack: () => void
  onCollapse: () => void
}): React.JSX.Element {
  const elapsed = elapsedMs(member, now)
  const working = member.status === 'working'
  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-border py-2.5 pr-2 pl-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to the fleet"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
        </button>
        <AgentMark size="md" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{member.name}</h2>
        <StatusMark status={member.status} />
        <CollapseButton onClick={onCollapse} />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <p className="font-mono text-2xs text-muted-foreground">
          {elapsed !== null &&
            `${working ? 'Working for' : 'Worked for'} ${formatElapsed(elapsed)}`}
          {elapsed !== null && member.steps !== null && ' · '}
          {member.steps !== null && `${member.steps} steps`}
          {member.role !== null && ` · ${member.role}`}
        </p>

        {/* What it was sent to do, above what it said back: while it is still
            working the brief is the only thing that explains it, which is
            exactly when somebody opens this. Absent under a Harness that
            carries no dispatch prompt, and then simply not shown. */}
        {member.brief !== null && (
          <section className="mt-3">
            <h3 className="text-2xs tracking-wide text-muted-foreground uppercase">Task</h3>
            <p className="mt-1 text-sm leading-relaxed break-words text-muted-foreground select-text">
              {member.brief}
            </p>
          </section>
        )}

        <section className="mt-5">
          {member.result !== null ? (
            <p className="text-sm leading-relaxed break-words select-text">{member.result}</p>
          ) : working ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              <span className="shimmer">{member.activity ?? 'Working. Nothing back yet.'}</span>
            </p>
          ) : (
            <p className="text-sm leading-relaxed text-muted-foreground">
              This subagent ended without reporting anything back.
            </p>
          )}
        </section>
      </div>
    </>
  )
}

/**
 * The collapsed dock: not an icon that reopens a panel, but the fleet at its
 * smallest honest size — every agent still present, still stating what it is,
 * and one click from being read.
 */
function FleetRail({
  fleet,
  now,
  onExpand
}: {
  fleet: FleetMember[]
  now: number
  onExpand: (dispatchId: string | null) => void
}): React.JSX.Element {
  return (
    <aside
      aria-label="Subagents, collapsed"
      style={{ width: RAIL_WIDTH }}
      className="flex shrink-0 flex-col items-center gap-2 border-l border-border bg-surface py-2"
    >
      <button
        type="button"
        aria-label="Expand the Subagents dock"
        aria-expanded={false}
        onClick={() => {
          onExpand(null)
        }}
        className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <PanelRightOpen aria-hidden="true" className="size-4" />
      </button>
      <span aria-hidden="true" className="h-px w-5 bg-border" />
      {/* A mark is an identity and a state and nothing else, which is enough
          to notice something and never enough to decide about it. Hovering one
          says what that subagent is actually doing, so the rail can be read
          without being reopened — the same bargain the Turn Rail's cards and
          the changed-file previews already make. */}
      {fleet.map((member) => (
        <RailMark
          key={member.dispatchId}
          member={member}
          now={now}
          onOpen={() => {
            onExpand(member.dispatchId)
          }}
        />
      ))}
    </aside>
  )
}

/**
 * One subagent on the rail: its mark, its state as a dot, and the preview.
 *
 * The card's open state is this component's rather than the primitive's,
 * because the primitive opens on hover alone. Focus has to open it too, or the
 * rail says one thing to a pointer and a plainer thing to a keyboard — and
 * this is the surface whose whole job is answering "what is that one doing?"
 * without being reopened.
 */
function RailMark({
  member,
  now,
  onOpen
}: {
  member: FleetMember
  now: number
  onOpen: () => void
}): React.JSX.Element {
  const [previewing, setPreviewing] = useState(false)
  return (
    <HoverCard open={previewing} onOpenChange={setPreviewing}>
      <HoverCardTrigger
        delay={200}
        closeDelay={150}
        render={
          <button
            type="button"
            aria-label={`${member.name} — ${STATUS_TEXT[member.status]}`}
            onClick={onOpen}
            onFocus={() => {
              setPreviewing(true)
            }}
            onBlur={() => {
              setPreviewing(false)
            }}
            className="relative grid size-7 place-items-center rounded-md hover:bg-muted"
          />
        }
      >
        <AgentMark size="md" />
        <span
          aria-hidden="true"
          className={cn(
            'absolute right-0.5 bottom-0.5 size-1.5 rounded-full ring-2 ring-surface',
            member.status === 'failed' ? 'bg-destructive' : 'bg-current',
            STATUS_INK[member.status],
            member.status === 'working' && 'animate-pulse motion-reduce:animate-none'
          )}
        />
      </HoverCardTrigger>
      {/* Beside the rail rather than over it, so the card never covers the
          marks it is a preview of. */}
      <HoverCardContent side="left" align="start" className="flex flex-col">
        <SubagentSummary member={member} now={now} />
      </HoverCardContent>
    </HoverCard>
  )
}

/**
 * The dock in whichever of its two sizes it is in. It draws nothing at all
 * when no subagent exists: a Run that delegated nothing has no fleet, and a
 * permanent empty column would be furniture rather than information.
 */
export function SubagentDock({
  fleet,
  expanded,
  openId,
  onOpen,
  onExpandedChange
}: {
  fleet: FleetMember[]
  expanded: boolean
  /** The subagent being read, when one is. */
  openId: string | null
  onOpen: (dispatchId: string | null) => void
  onExpandedChange: (expanded: boolean) => void
}): React.JSX.Element | null {
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const { working } = fleetSummary(fleet)
  const now = useTicking(working > 0)
  const open = fleet.find((member) => member.dispatchId === openId) ?? null

  if (fleet.length === 0) return null

  if (!expanded) {
    return (
      <FleetRail
        fleet={fleet}
        now={now}
        onExpand={(dispatchId) => {
          onOpen(dispatchId)
          onExpandedChange(true)
        }}
      />
    )
  }

  const clamp = (next: number): number => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next))

  return (
    <aside
      aria-label="Subagents"
      style={{ width: `min(${String(width)}px, 42vw)`, minWidth: MIN_WIDTH }}
      className="relative flex shrink-0 flex-col border-l border-border bg-surface"
    >
      {/* The dock's edge is its own control, on the Files panel's terms: drag
          it, or arrow it wider and narrower from the keyboard. A focusable
          separator carrying aria-valuenow is ARIA's own resize-handle pattern,
          which the lint rules below do not model. */}
      {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the Subagents dock"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        onPointerDown={(event) => {
          dragRef.current = { startX: event.clientX, startWidth: width }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (drag) setWidth(clamp(drag.startWidth + (drag.startX - event.clientX)))
        }}
        onPointerUp={() => {
          dragRef.current = null
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            setWidth((current) => clamp(current + RESIZE_STEP))
          }
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            setWidth((current) => clamp(current - RESIZE_STEP))
          }
        }}
        className="absolute inset-y-0 -left-0.5 z-10 w-1.5 cursor-col-resize hover:bg-border focus-visible:bg-ring focus-visible:outline-none"
      />
      {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}

      {open !== null ? (
        <SubagentThread
          member={open}
          now={now}
          onBack={() => {
            onOpen(null)
          }}
          onCollapse={() => {
            onExpandedChange(false)
          }}
        />
      ) : (
        <>
          <header className="flex shrink-0 items-center gap-2 border-b border-border py-2.5 pr-2 pl-3">
            <h2 className="flex-1 text-sm font-medium">Subagents</h2>
            <span className="font-mono text-2xs text-muted-foreground">
              {working > 0 ? `${working} working` : 'all landed'}
            </span>
            <CollapseButton
              onClick={() => {
                onExpandedChange(false)
              }}
            />
          </header>
          <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
            {fleet.map((member) => (
              <FleetCard
                key={member.dispatchId}
                member={member}
                now={now}
                onOpen={() => {
                  onOpen(member.dispatchId)
                }}
              />
            ))}
          </ul>
        </>
      )}
    </aside>
  )
}
