/**
 * PROTOTYPE — Variant B: "One folded block, drilled into".
 *
 * The fleet is not a stream of events in the transcript; it is one line —
 * "Dispatched 3 subagents · 2 clean, 1 needs attention" — that opens onto a
 * row per agent, exactly the way this app already folds a Run's steps. Opening
 * an agent replaces the transcript with that agent's thread, so a subagent is
 * a place you go rather than a panel you peek at.
 *
 * What it is betting: the Conversation's prose is the thing worth protecting,
 * and a fleet of ten agents should cost the same vertical space as a fleet of
 * two.
 */
import { useState } from 'react'
import { Bot } from 'lucide-react'
import { ChainOfThought, ChainStep } from '@renderer/components/ui/chain-of-thought'
import { cn } from '@renderer/lib/utils'
import {
  SUBAGENTS,
  dispatchedAt,
  elapsedAt,
  formatSeconds,
  stateAt,
  stepsAt,
  type Subagent
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

/** The one line the folded block says about a fleet in whatever state it is. */
function fleetSentence(now: number): string {
  const dispatched = dispatchedAt(now)
  if (dispatched.length === 0) return 'Dispatching subagents'
  const working = dispatched.filter((agent) => stateAt(agent, now) === 'working').length
  const failed = dispatched.filter((agent) => stateAt(agent, now) === 'failed').length
  const clauses: string[] = []
  if (working > 0) clauses.push(`${working} still working`)
  const done = dispatched.length - working - failed
  if (done > 0) clauses.push(`${done} clean`)
  if (failed > 0) clauses.push(`${failed} needs attention`)
  return `Dispatched ${dispatched.length} subagents — ${clauses.join(', ')}`
}

/** What one agent's row says while it is the only thing you can see of it. */
function rowMeta(agent: Subagent, now: number): string {
  const steps = stepsAt(agent, now)
  const last = steps.at(-1)
  if (stateAt(agent, now) === 'working') return last?.text ?? 'Starting'
  return `${steps.length} steps`
}

export function VariantB({ now }: { now: number }): React.JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null)
  const open = SUBAGENTS.find((agent) => agent.id === openId) ?? null
  const dispatched = dispatchedAt(now)
  const working = dispatched.some((agent) => stateAt(agent, now) === 'working')
  const finished = dispatched.length === SUBAGENTS.length && !working

  if (open !== null) {
    return (
      <div className="mx-auto h-full max-w-3xl">
        <SubagentThread
          agent={open}
          now={now}
          backLabel="Back to the Conversation"
          onBack={() => {
            setOpenId(null)
          }}
        />
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
        <UserTurn>Review the committed diff before you push it.</UserTurn>
        <RunDivider label="Run · code-review Skill" />
        <AgentTurn>{DISPATCH_PROSE}</AgentTurn>

        {dispatched.length > 0 && (
          <ChainOfThought
            label={
              <span className="flex items-center gap-1.5">
                <Bot aria-hidden="true" className="size-3 text-muted-foreground" />
                {fleetSentence(now)}
              </span>
            }
            meta={formatSeconds(now)}
            running={working}
            ariaLabel="The subagents this Run dispatched"
          >
            {dispatched.map((agent) => (
              <ChainStep
                key={agent.id}
                icon={<AgentMark agent={agent} />}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0">{agent.name}</span>
                    <span
                      className={cn(
                        'min-w-0 truncate text-muted-foreground',
                        stateAt(agent, now) === 'working' && 'shimmer'
                      )}
                    >
                      {rowMeta(agent, now)}
                    </span>
                  </span>
                }
                meta={formatSeconds(elapsedAt(agent, now))}
                onOpen={() => {
                  setOpenId(agent.id)
                }}
              />
            ))}
          </ChainOfThought>
        )}

        {/* The state each row omits, restated where a keyboard user lands: the
            rows are links, so their state travels with them, not beside them. */}
        {dispatched.length > 0 && (
          <ul className="sr-only">
            {dispatched.map((agent) => (
              <li key={agent.id}>
                {agent.name}: <StateMark state={stateAt(agent, now)} />
              </li>
            ))}
          </ul>
        )}

        {finished && (
          <AgentTurn>
            {CLOSING_PROSE}
            <OutcomeLine
              failed={dispatched.filter((agent) => stateAt(agent, now) === 'failed').length}
            />
          </AgentTurn>
        )}
      </div>
    </div>
  )
}
