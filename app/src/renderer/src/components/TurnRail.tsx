/**
 * The conversation stood in the gutter: one tick per turn, oldest at the top,
 * and a card on hover saying what that turn asked for and what the Run did
 * about it. Clicking a tick sends the transcript to that turn.
 *
 * It is a map, not a second transcript. The card is deliberately short — the
 * prompt, a line of the reply, the first few things the Run touched — because
 * its job is to let someone recognise a turn they already lived through, and
 * the transcript itself is one click away.
 */
import { memo, useMemo } from 'react'
import { FileDiff, FileText, Terminal } from 'lucide-react'
import { PreviewRail } from '@renderer/components/ui/preview-rail'
import {
  useMessageScroller,
  useMessageScrollerVisibility
} from '@renderer/components/ui/message-scroller'
import { cn } from '@renderer/lib/utils'

/** One thing a Run did, reduced to the one line the card has room for. */
export interface TurnStep {
  id: string
  kind: 'read' | 'command' | 'file-change'
  text: string
}

/** A turn as the rail draws it: what was asked, what came back, what it cost. */
export interface TurnSummary {
  /** The transcript row this turn scrolls to. */
  id: string
  /** Where the turn sits, for the tick's accessible name. */
  ordinal: number
  prompt: string
  reply: string
  steps: TurnStep[]
  stepCount: number
  approvals: number
  status: 'running' | 'failed' | 'stopped' | 'done' | null
}

/** How many steps the card lists before it starts counting instead. */
const LISTED_STEPS = 3

const STEP_ICON = { read: FileText, command: Terminal, 'file-change': FileDiff }

const STATUS_TEXT: Record<NonNullable<TurnSummary['status']>, string> = {
  running: 'Running',
  failed: 'Needs attention',
  stopped: 'Stopped',
  done: 'Done'
}

const STATUS_INK: Record<NonNullable<TurnSummary['status']>, string> = {
  running: 'text-status-running',
  failed: 'text-destructive',
  stopped: 'text-status-blocked',
  done: 'text-muted-foreground'
}

function TurnCard({ turn }: { turn: TurnSummary }): React.JSX.Element {
  const hidden = turn.stepCount - Math.min(turn.steps.length, LISTED_STEPS)

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-raised shadow-lg">
      <div className="p-2.5">
        <p className="line-clamp-3 text-sm leading-relaxed">{turn.prompt}</p>
        {turn.reply !== '' && (
          <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{turn.reply}</p>
        )}
      </div>
      {turn.steps.length > 0 && (
        <ul className="border-t border-border px-2.5 py-1.5">
          {turn.steps.slice(0, LISTED_STEPS).map((step) => {
            const Icon = STEP_ICON[step.kind]
            return (
              <li
                key={step.id}
                className="flex items-center gap-2 py-0.5 font-mono text-2xs text-muted-foreground"
              >
                <Icon aria-hidden="true" className="size-3 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{step.text}</span>
              </li>
            )
          })}
          {hidden > 0 && (
            <li className="py-0.5 text-2xs text-muted-foreground">
              and {String(hidden)} more step{hidden === 1 ? '' : 's'}
            </li>
          )}
        </ul>
      )}
      {turn.status !== null && (
        <div className="flex items-center gap-2 border-t border-border px-2.5 py-1.5 text-2xs">
          <span className={cn('flex items-center gap-1.5', STATUS_INK[turn.status])}>
            <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
            {STATUS_TEXT[turn.status]}
          </span>
          {turn.approvals > 0 && (
            <span className="text-muted-foreground">
              {String(turn.approvals)} approval{turn.approvals === 1 ? '' : 's'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The rail reads the scroller's visibility to know where the reader is, and
 * that changes as the transcript moves. Everything downstream of it is behind
 * a memo, so scrolling past a turn costs one shallow compare unless the
 * reader's place actually moved — a map of the Conversation must not be a tax
 * on reading it.
 */
export function TurnRail({ turns }: { turns: TurnSummary[] }): React.JSX.Element | null {
  const { scrollToMessage } = useMessageScroller()
  const { currentAnchorId, visibleMessageIds } = useMessageScrollerVisibility()

  /* Which turn the reader is in, in the scroller's own words: the turn it
     anchored on, or — while a long turn is being scrolled through — the last
     turn still on screen. */
  const currentId = useMemo(() => {
    const anchored = turns.find((turn) => turn.id === currentAnchorId)
    if (anchored !== undefined) return anchored.id
    const visible = new Set(visibleMessageIds)
    return turns.filter((turn) => visible.has(turn.id)).at(-1)?.id ?? null
  }, [turns, currentAnchorId, visibleMessageIds])

  // A rail of one tick maps nothing; below two turns the transcript is the map.
  if (turns.length < 2) return null
  return <TurnRailBody turns={turns} currentId={currentId} onScrollTo={scrollToMessage} />
}

const TurnRailBody = memo(function TurnRailBody({
  turns,
  currentId,
  onScrollTo
}: {
  turns: TurnSummary[]
  currentId: string | null
  onScrollTo: (id: string, options: { align: 'start'; behavior: 'smooth' }) => void
}): React.JSX.Element {
  const items = useMemo(
    () =>
      turns.map((turn) => ({
        id: turn.id,
        label: `Turn ${String(turn.ordinal)}: ${turn.prompt.slice(0, 80)}`,
        turn
      })),
    [turns]
  )

  return (
    <PreviewRail
      className="absolute inset-y-0 start-3 z-10 hidden @[54rem]/transcript:flex"
      label="Conversation turns"
      items={items}
      activeId={currentId}
      onSelect={(item) => {
        onScrollTo(item.id, { align: 'start', behavior: 'smooth' })
      }}
      renderPreview={(item) => <TurnCard turn={item.turn} />}
    />
  )
})
