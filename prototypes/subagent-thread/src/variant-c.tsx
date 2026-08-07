/**
 * PROTOTYPE — Variant C: "The fleet has its own dock". The chosen direction.
 *
 * Subagents are not transcript events. The Conversation carries one pill —
 * "3 subagents created" — and the fleet itself lives in a dock on the right,
 * holding one live card each. A card opens into that agent's thread in place,
 * so the dock is either the fleet or one of its members.
 *
 * The dock takes both of its manners from surfaces this app already has:
 *
 * - It opens and resizes like the Files panel — an `aside` beside the
 *   transcript rather than over it, with its own left edge as the handle, drag
 *   or arrow keys, between honest bounds.
 * - It collapses like the inbox: to a rail, not to nothing. A fleet that
 *   vanished when it was in the way would leave someone with no way to notice
 *   an agent had failed, so the rail keeps every agent's mark and state on
 *   screen at 44 pixels, and clicking one opens the dock straight onto it.
 *
 * The dock follows the Run until somebody takes it over — open while agents
 * are working, collapsed to the rail once they have all landed — because the
 * space is worth spending while it is answering a question, and not after. A
 * person who has opened or collapsed it themselves is not overruled.
 */
import { useEffect, useRef, useState } from 'react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import {
  SUBAGENTS,
  dispatchedAt,
  elapsedAt,
  formatSeconds,
  stateAt,
  stepsAt,
  type Subagent,
  type SubagentState
} from './fleet'
import {
  AgentMark,
  AgentTurn,
  CLOSING_PROSE,
  DISPATCH_PROSE,
  OutcomeLine,
  RunDivider,
  StateMark,
  SubagentThread,
  UserTurn
} from './parts'

/** How wide the dock opens, and how far it may be dragged either way. */
const DEFAULT_WIDTH = 340
const MIN_WIDTH = 280
const MAX_WIDTH = 560
/** One keyboard step of the resize handle, as the Files panel uses. */
const RESIZE_STEP = 24
/** The rail is a column of marks, and is exactly as wide as one needs. */
const RAIL_WIDTH = 44

/**
 * The Conversation's whole mention of the fleet: how many were dispatched, how
 * many are still going, and a way in. It is a toggle rather than a link —
 * clicking it again puts the dock back on its rail — so the transcript keeps
 * one control for one thing.
 */
function FleetPill({
  agents,
  now,
  expanded,
  onToggle
}: {
  agents: Subagent[]
  now: number
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const working = agents.filter((agent) => stateAt(agent, now) === 'working').length
  const failed = agents.filter((agent) => stateAt(agent, now) === 'failed').length

  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className={cn(
        /* Open is said with the quiet fill alone. A ring is this app's focus
           colour, and a pill wearing it while nothing is focused is a pill
           telling you about your keyboard when it meant to tell you the dock
           is open. */
        'inline-flex w-fit items-center gap-2 rounded-full border border-border py-1 pr-3 pl-1.5 text-xs',
        'hover:border-muted-foreground/40 hover:bg-muted',
        expanded && 'bg-muted'
      )}
    >
      {/* The marks overlap: a fleet is one thing with members, and a row of
          separate chips would read as several dispatches. */}
      <span className="flex shrink-0 -space-x-1.5">
        {agents.map((agent) => (
          <span key={agent.id} className="rounded-full ring-2 ring-background">
            <AgentMark agent={agent} />
          </span>
        ))}
      </span>
      <span className={cn(working > 0 && 'shimmer')}>
        {agents.length} {agents.length === 1 ? 'subagent' : 'subagents'} created
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

function FleetCard({
  agent,
  now,
  onOpen
}: {
  agent: Subagent
  now: number
  onOpen: () => void
}): React.JSX.Element {
  const state = stateAt(agent, now)
  const steps = stepsAt(agent, now)
  const last = steps.at(-1)

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-lg border border-border bg-surface-raised p-2.5 text-left hover:border-muted-foreground/40"
    >
      <div className="flex items-center gap-2">
        <AgentMark agent={agent} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{agent.name}</span>
        <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
          {formatSeconds(elapsedAt(agent, now))}
        </span>
      </div>

      <p
        className={cn(
          'mt-1.5 line-clamp-2 text-2xs text-muted-foreground',
          state === 'working' && 'shimmer'
        )}
      >
        {state === 'working' ? (last?.text ?? 'Starting') : agent.result}
      </p>

      {/* No progress bar. A subagent cannot say how much of its work is left —
          it does not know — and a bar that advanced on elapsed time would be
          inventing a denominator. What the card can say honestly is how far it
          has got: its state, and the steps it has actually taken. */}
      <div className="mt-2 flex items-center gap-2">
        <StateMark state={state} />
        <span className="ml-auto shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
          {steps.length} {steps.length === 1 ? 'step' : 'steps'}
        </span>
      </div>
    </button>
  )
}

/** One control, wherever the dock is showing it: the fleet, or one agent. */
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

/** The state dot the rail hangs off a mark, since the rail has no room for a word. */
const RAIL_DOT: Record<SubagentState, string> = {
  pending: 'bg-muted-foreground',
  working: 'bg-status-running',
  done: 'bg-muted-foreground',
  failed: 'bg-destructive'
}

/**
 * The collapsed dock. It is not an icon that reopens a panel — it is the fleet
 * at its smallest honest size: every agent still present, still stating what
 * it is, and one click from being read.
 */
function FleetRail({
  agents,
  now,
  onExpand
}: {
  agents: Subagent[]
  now: number
  onExpand: (agentId: string | null) => void
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
      <span className="h-px w-5 bg-border" />
      {agents.map((agent) => {
        const state = stateAt(agent, now)
        return (
          <button
            key={agent.id}
            type="button"
            aria-label={`${agent.name} — open in the Subagents dock`}
            onClick={() => {
              onExpand(agent.id)
            }}
            className="relative grid size-7 place-items-center rounded-md hover:bg-muted"
          >
            <AgentMark agent={agent} size="md" />
            <span
              aria-hidden="true"
              className={cn(
                'absolute right-0.5 bottom-0.5 size-1.5 rounded-full ring-2 ring-surface',
                RAIL_DOT[state],
                state === 'working' && 'animate-pulse motion-reduce:animate-none'
              )}
            />
          </button>
        )
      })}
    </aside>
  )
}

export function VariantC({ now }: { now: number }): React.JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  /* Whether the person has taken the dock over, exactly as the activity chain
     tracks it: until they do, the dock follows the Run. */
  const claimedRef = useRef(false)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const dispatched = dispatchedAt(now)
  const working = dispatched.filter((agent) => stateAt(agent, now) === 'working').length
  const failed = dispatched.filter((agent) => stateAt(agent, now) === 'failed').length
  const finished = dispatched.length === SUBAGENTS.length && working === 0
  const open = SUBAGENTS.find((agent) => agent.id === openId) ?? null

  useEffect(() => {
    if (!claimedRef.current) setExpanded(working > 0)
  }, [working])

  function claim(next: boolean, agentId: string | null = null): void {
    claimedRef.current = true
    setExpanded(next)
    setOpenId(agentId)
  }

  const clamp = (next: number): number => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next))

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-6">
          <UserTurn>Review the committed diff before you push it.</UserTurn>
          <RunDivider label="Run · code-review Skill" />
          <AgentTurn>{DISPATCH_PROSE}</AgentTurn>

          {dispatched.length > 0 && (
            <FleetPill
              agents={dispatched}
              now={now}
              expanded={expanded}
              onToggle={() => {
                claim(!expanded)
              }}
            />
          )}

          {finished && (
            <AgentTurn>
              {CLOSING_PROSE}
              <OutcomeLine failed={failed} />
            </AgentTurn>
          )}
        </div>
      </div>

      {dispatched.length > 0 &&
        (expanded ? (
          <aside
            aria-label="Subagents"
            style={{ width: `min(${String(width)}px, 42vw)`, minWidth: MIN_WIDTH }}
            className="relative flex shrink-0 flex-col border-l border-border bg-surface"
          >
            {/* The dock's edge is its own control, on the Files panel's terms:
                drag it, or arrow it wider and narrower from the keyboard. */}
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
              /* Reading one agent, the collapse control keeps its place in the
                 header rather than floating over it: back goes to the fleet,
                 and collapsing puts the whole dock away from wherever you
                 happen to be inside it. */
              <SubagentThread
                agent={open}
                now={now}
                backLabel="Back to the fleet"
                onBack={() => {
                  setOpenId(null)
                }}
                action={
                  <CollapseButton
                    onClick={() => {
                      claim(false)
                    }}
                  />
                }
              />
            ) : (
              <>
                <header className="flex shrink-0 items-center gap-2 border-b border-border py-2.5 pr-2 pl-3">
                  <span className="flex-1 text-sm font-medium">Subagents</span>
                  <span className="font-mono text-2xs text-muted-foreground">
                    {working > 0 ? `${working} working` : 'all landed'}
                  </span>
                  <CollapseButton
                    onClick={() => {
                      claim(false)
                    }}
                  />
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
                  {dispatched.map((agent) => (
                    <FleetCard
                      key={agent.id}
                      agent={agent}
                      now={now}
                      onOpen={() => {
                        setOpenId(agent.id)
                      }}
                    />
                  ))}
                </div>
              </>
            )}
          </aside>
        ) : (
          <FleetRail
            agents={dispatched}
            now={now}
            onExpand={(agentId) => {
              claim(true, agentId)
            }}
          />
        ))}
    </div>
  )
}
