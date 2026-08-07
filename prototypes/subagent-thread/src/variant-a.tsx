/**
 * PROTOTYPE — Variant A: "Pills in the prose".
 *
 * The closest reading of Codex's surface, in this app's clothes. Every time
 * the fleet does something the transcript grows a line of pills and a verb —
 * "Standards review, Spec review started working" — so the Conversation
 * records the fleet the same way it records everything else: in order, in
 * prose. A pill opens a sidebar beside the transcript, which stays a
 * transcript underneath.
 *
 * What it is betting: subagents are events worth reading in sequence, and the
 * cost of a row per update is worth the certainty of never missing one.
 */
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { RUN_LENGTH, SUBAGENTS, dispatchedAt, stateAt, stepsAt, type Subagent } from './fleet'
import {
  AgentMark,
  AgentTurn,
  CLOSING_PROSE,
  DISPATCH_PROSE,
  OutcomeLine,
  RunDivider,
  SubagentThread,
  UserTurn
} from './parts'

type Verb = 'started working' | 'updated' | 'finished' | 'could not finish'

interface FleetEvent {
  at: number
  verb: Verb
  agents: Subagent[]
}

/** The fleet's history up to `now`, as the rows the transcript would grow. */
function eventsAt(now: number): FleetEvent[] {
  const raw: { at: number; verb: Verb; agent: Subagent }[] = []
  for (const agent of SUBAGENTS) {
    raw.push({ at: agent.startsAt, verb: 'started working', agent })
    for (const step of stepsAt(agent, RUN_LENGTH)) {
      raw.push({ at: step.at, verb: 'updated', agent })
    }
    raw.push({
      at: agent.endsAt,
      verb: agent.outcome === 'done' ? 'finished' : 'could not finish',
      agent
    })
  }

  const rows: FleetEvent[] = []
  for (const item of raw.filter((entry) => entry.at <= now).sort((a, b) => a.at - b.at)) {
    // Two agents that do the same thing within a couple of seconds share a
    // row, which is what keeps a parallel dispatch from reading as a list.
    const last = rows.at(-1)
    if (last !== undefined && last.verb === item.verb && item.at - last.at <= 2) {
      if (!last.agents.includes(item.agent)) last.agents.push(item.agent)
      continue
    }
    rows.push({ at: item.at, verb: item.verb, agents: [item.agent] })
  }
  return rows
}

function Pill({
  agent,
  now,
  onOpen,
  selected
}: {
  agent: Subagent
  now: number
  onOpen: () => void
  selected: boolean
}): React.JSX.Element {
  const state = stateAt(agent, now)
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border py-0.5 pr-2.5 pl-1 text-xs',
        'hover:border-muted-foreground/40 hover:bg-muted',
        selected && 'border-ring bg-muted'
      )}
    >
      <AgentMark agent={agent} />
      <span className={cn('truncate', state === 'working' && 'shimmer')}>{agent.name}</span>
      {state === 'failed' && <span className="size-1.5 rounded-full bg-destructive" />}
    </button>
  )
}

export function VariantA({ now }: { now: number }): React.JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null)
  const open = SUBAGENTS.find((agent) => agent.id === openId) ?? null
  const rows = eventsAt(now)
  const landed = dispatchedAt(now).filter((agent) => stateAt(agent, now) !== 'working')
  const finished = landed.length === SUBAGENTS.length

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
          <UserTurn>Review the committed diff before you push it.</UserTurn>
          <RunDivider label="Run · code-review Skill" />
          <AgentTurn>{DISPATCH_PROSE}</AgentTurn>

          <div className="flex flex-col gap-1.5">
            {rows.map((row) => (
              <div key={`${row.at}-${row.verb}`} className="flex flex-wrap items-center gap-1.5">
                {row.agents.map((agent) => (
                  <Pill
                    key={agent.id}
                    agent={agent}
                    now={now}
                    selected={agent.id === openId}
                    onOpen={() => {
                      setOpenId(agent.id)
                    }}
                  />
                ))}
                <span
                  className={cn(
                    'text-xs',
                    row.verb === 'could not finish' ? 'text-destructive' : 'text-muted-foreground'
                  )}
                >
                  {row.verb}
                </span>
              </div>
            ))}
          </div>

          {finished && (
            <AgentTurn>
              {CLOSING_PROSE}
              <OutcomeLine
                failed={landed.filter((agent) => stateAt(agent, now) === 'failed').length}
              />
            </AgentTurn>
          )}
        </div>
      </div>

      {/* The sidebar is a sibling rather than an overlay: the transcript keeps
          being readable while a subagent is being read, which is the whole
          reason it is a sidebar and not a dialog. */}
      {open !== null && (
        <aside className="w-[380px] shrink-0 border-l border-border bg-surface">
          <SubagentThread
            agent={open}
            now={now}
            backLabel="Close the subagent sidebar"
            onBack={() => {
              setOpenId(null)
            }}
          />
        </aside>
      )}

      {open === null && (
        <aside className="hidden w-[380px] shrink-0 border-l border-border bg-surface lg:block">
          <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center">
            <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              Open a subagent from the transcript to read what it is doing.
            </p>
          </div>
        </aside>
      )}
    </div>
  )
}
