/**
 * PROTOTYPE — throwaway. The pieces every variant needs and none of them
 * disagrees about: the mark that stands for a subagent, the focused view of
 * one, and enough of a Conversation around them to judge density.
 *
 * The three variants disagree about *where* a subagent is announced and where
 * its thread is read. They do not disagree about what a subagent thread says,
 * so that part is written once and framed three ways.
 */
import { ArrowLeft, Ban, Check, FileText, Search, ShieldCheck, Sparkles } from 'lucide-react'
import { ChainOfThought, ChainStep } from '@renderer/components/ui/chain-of-thought'
import { cn } from '@renderer/lib/utils'
import {
  STATE_INK,
  STATE_TEXT,
  TINT_INK,
  elapsedAt,
  formatSeconds,
  stateAt,
  stepsAt,
  type Subagent,
  type SubagentState
} from './fleet'

const ROLE_ICON = { Reviewer: ShieldCheck, Explorer: Search } as const

/**
 * A subagent in one glyph: the mark Codex spends a coloured cluster on, said
 * here in the app's terms — the role's icon, in the agent's tint, on the quiet
 * fill every chip in this app already uses.
 */
export function AgentMark({
  agent,
  size = 'sm'
}: {
  agent: Subagent
  size?: 'sm' | 'md'
}): React.JSX.Element {
  const Icon = ROLE_ICON[agent.role as keyof typeof ROLE_ICON] ?? Sparkles
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-muted',
        TINT_INK[agent.tint],
        size === 'sm' ? 'size-4' : 'size-6'
      )}
    >
      <Icon className={size === 'sm' ? 'size-2.5' : 'size-3.5'} />
    </span>
  )
}

/** The state, in the dot-and-word pair the activity chain already uses. */
export function StateMark({ state }: { state: SubagentState }): React.JSX.Element {
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5 text-2xs', STATE_INK[state])}>
      {state === 'working' ? (
        <span
          aria-hidden="true"
          className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none"
        />
      ) : (
        <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      )}
      {STATE_TEXT[state]}
    </span>
  )
}

/**
 * One subagent's thread, focused: what it was sent to do, what it did, and
 * what it came back with. The frame around it is the variant's business — this
 * is only ever the contents.
 */
export function SubagentThread({
  agent,
  now,
  onBack,
  backLabel,
  action
}: {
  agent: Subagent
  now: number
  onBack: () => void
  /** Named after where back goes, because in one variant it is not a sidebar. */
  backLabel: string
  /**
   * A control the surrounding surface needs kept reachable from in here — the
   * dock's collapse, in practice. It belongs in this header rather than
   * floating over it: a button laid on top of a header is a button laid on
   * top of whatever the header was already saying.
   */
  action?: React.ReactNode
}): React.JSX.Element {
  const state = stateAt(agent, now)
  const steps = stepsAt(agent, now)
  const working = state === 'working'
  const ended = state === 'done' || state === 'failed'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border py-2.5 pr-2 pl-3">
        <button
          type="button"
          onClick={onBack}
          aria-label={backLabel}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
        </button>
        <AgentMark agent={agent} size="md" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{agent.name}</span>
        <StateMark state={state} />
        {action}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <ChainOfThought
          label={
            working
              ? `Working for ${formatSeconds(elapsedAt(agent, now))}`
              : `Worked for ${formatSeconds(elapsedAt(agent, now))}`
          }
          meta={`${steps.length} steps`}
          running={working}
          ariaLabel="What this subagent did"
        >
          {steps.map((step) => (
            <ChainStep
              key={step.at}
              icon={<FileText className="size-3" />}
              title={step.text}
              meta={formatSeconds(step.at - agent.startsAt)}
            />
          ))}
        </ChainOfThought>

        {/* What it was sent to do, kept above what it said back: the brief is
            the only thing that explains a subagent while it is still working,
            which is exactly when someone opens this. */}
        <section className="mt-3 max-w-lg">
          <h3 className="text-2xs tracking-wide text-muted-foreground uppercase">Task</h3>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{agent.brief}</p>
        </section>

        <section className="mt-5 max-w-lg">
          <h2 className="text-lg font-medium">{agent.name}</h2>
          {ended ? (
            <p className="mt-1.5 text-sm leading-relaxed">{agent.result}</p>
          ) : (
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              <span className="shimmer">Still working. Nothing has been reported back yet.</span>
            </p>
          )}
          <p className="mt-3 font-mono text-2xs text-muted-foreground">
            {agent.model} · dispatched at {formatSeconds(agent.startsAt)}
            {ended && ` · ${agent.outcome === 'failed' ? 'returned a problem' : 'returned clean'}`}
          </p>
        </section>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Enough Conversation to judge the surfaces against real density.
 * ------------------------------------------------------------------ */

export function UserTurn({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="flex justify-end">
      <div className="max-w-md rounded-lg rounded-br-sm bg-muted px-3 py-2 text-sm leading-relaxed">
        {children}
      </div>
    </div>
  )
}

export function AgentTurn({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="max-w-lg text-sm leading-relaxed">{children}</div>
}

export function RunDivider({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 pt-2">
      <span className="font-mono text-2xs text-muted-foreground">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

/** The one sentence the Run says before it dispatches anybody. */
export const DISPATCH_PROSE =
  'The code-review skill now requires two independent reviewers, so I am dispatching the same committed diff in parallel: one against repository standards and the Fowler smell baseline, and one against MEM-94’s implementation contract and acceptance criteria.'

export const CLOSING_PROSE =
  'Both required review axes are clean: no repository-standard or code-smell findings, and no MEM-94 spec gaps or scope creep. The fixture sweep came back unable to verify, so I have left it out of the gate. I am pushing the reviewed commit now.'

/** The outcome mark the closing summary carries, once the fleet has landed. */
export function OutcomeLine({ failed }: { failed: number }): React.JSX.Element {
  return (
    <p
      className={cn(
        'mt-2 flex items-center gap-1.5 text-xs',
        failed > 0 ? 'text-destructive' : 'text-muted-foreground'
      )}
    >
      {failed > 0 ? (
        <Ban aria-hidden="true" className="size-3" />
      ) : (
        <Check aria-hidden="true" className="size-3" />
      )}
      {failed > 0
        ? `${failed} subagent could not finish its check`
        : 'Every dispatched subagent reported back'}
    </p>
  )
}
