import { useCallback, useEffect, useState } from 'react'
import { ScanSearch } from 'lucide-react'
import type { Finding, ReviewState } from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

/**
 * What a Harness said about the code this Session changed, on the surface that
 * already answers "what is the state of this work".
 *
 * Every Finding names a file and a line range, so acting on one is opening the
 * place it points at rather than re-locating a paragraph by hand. Nothing here
 * can be accepted or rejected, for the same reason a changed file cannot be:
 * the code is already on disk and git decides what to keep.
 */

/** What each Harness is called, in the person's words rather than the wire's. */
const HARNESS_LABEL = { claude: 'Claude Code', codex: 'Codex' } as const

/** Where the Finding points, said the way a compiler says it. */
function location(finding: Finding): string {
  return finding.startLine === finding.endLine
    ? `${finding.path}:${String(finding.startLine)}`
    : `${finding.path}:${String(finding.startLine)}-${String(finding.endLine)}`
}

interface ReviewFindingsProps {
  sessionId: string
  /** Paths this Session is recorded as having changed, so a Finding can say
   *  when it points somewhere the Session has no diff for. */
  changedPaths: ReadonlySet<string>
  /** The Finding whose code is open, when one is. */
  openFindingId: string | null
  onOpenFinding: (finding: Finding | null) => void
}

export function ReviewFindings({
  sessionId,
  changedPaths,
  openFindingId,
  onOpenFinding
}: ReviewFindingsProps): React.JSX.Element {
  const [state, setState] = useState<ReviewState | null>(null)
  const [asking, setAsking] = useState(false)

  useEffect(() => {
    let current = true
    void window.shell.getSessionReview(sessionId).then(
      (next) => {
        if (current) setState(next)
      },
      () => undefined
    )
    return () => {
      current = false
    }
  }, [sessionId])

  const ask = useCallback(async () => {
    setAsking(true)
    try {
      setState(await window.shell.requestSessionReview(sessionId))
    } catch {
      // Main answers a review that failed with the reason on the state itself.
      // A rejected call is the app failing to ask at all, which the line below
      // says without inventing a reason of its own.
      setState((current) =>
        current === null ? current : { ...current, failure: 'The review could not be started.' }
      )
    } finally {
      setAsking(false)
      onOpenFinding(null)
    }
  }, [sessionId, onOpenFinding])

  if (state === null) return <></>

  const running = asking || state.running
  const findings = state.review?.findings ?? []

  return (
    <section
      aria-label="Review findings"
      className="flex shrink-0 flex-col border-t border-border px-4 py-2.5"
    >
      <div className="flex items-baseline gap-2">
        <h3 className="text-xs font-medium">Review</h3>
        {state.supported && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={running}
            onClick={() => void ask()}
          >
            <ScanSearch aria-hidden="true" className="size-3" />
            {running ? 'Reviewing…' : state.review ? 'Review again' : 'Review these changes'}
          </Button>
        )}
      </div>

      {/* A Harness with no review is said out loud rather than left as an
          action that quietly does nothing. */}
      {!state.supported && (
        <p className="pt-1 text-2xs text-muted-foreground">
          {state.harness === null
            ? 'Nothing has answered in this Session yet, so there is nothing to ask for a review.'
            : `${HARNESS_LABEL[state.harness]} offers no review of its own. Codex does, and a Session answered by Codex can be reviewed here.`}
        </p>
      )}

      {state.supported && (
        <p className="pt-1 text-2xs text-muted-foreground">
          A separate thread reads what changed. It says nothing in the Conversation and spends none
          of this Session&rsquo;s context.
        </p>
      )}

      {state.failure !== null && (
        <p role="status" className="pt-1.5 text-2xs text-destructive">
          {state.failure} Nothing else about this Session changed.
        </p>
      )}

      {state.review !== null && findings.length === 0 && (
        <p className="pt-1.5 text-2xs text-muted-foreground">
          Nothing found in what this Session changed.
        </p>
      )}

      {findings.length > 0 && (
        <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto pt-1.5">
          {findings.map((finding) => (
            <FindingRow
              key={finding.id}
              finding={finding}
              open={finding.id === openFindingId}
              located={changedPaths.has(finding.path)}
              onClick={() => onOpenFinding(finding.id === openFindingId ? null : finding)}
            />
          ))}
        </ul>
      )}

      {state.review !== null && state.review.assessment !== '' && (
        <p className="pt-2 text-2xs whitespace-pre-wrap text-muted-foreground">
          {state.review.assessment}
        </p>
      )}
    </section>
  )
}

function FindingRow({
  finding,
  open,
  located,
  onClick
}: {
  finding: Finding
  open: boolean
  located: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={onClick}
        className={cn(
          'flex w-full flex-col gap-0.5 rounded px-1.5 py-1 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
          open && 'bg-accent'
        )}
      >
        <span className="flex items-baseline gap-1.5">
          {finding.priority !== null && (
            <span className="shrink-0 rounded border border-border px-1 font-mono text-2xs text-muted-foreground">
              {finding.priority}
            </span>
          )}
          <span className="min-w-0 flex-1 text-xs">{finding.title}</span>
        </span>
        <span className="font-mono text-2xs text-muted-foreground">{location(finding)}</span>
        {open && (
          <>
            <span className="pt-0.5 text-2xs whitespace-pre-wrap text-muted-foreground">
              {finding.body}
            </span>
            {/* A Finding may name a file this Session never wrote to — a call
                site the change broke. There is no recorded diff to open for
                it, and saying so beats a click that appears to do nothing. */}
            {!located && (
              <span className="pt-0.5 text-2xs text-muted-foreground">
                This Session has no recorded change to that file, so there is no diff to open here.
              </span>
            )}
          </>
        )}
      </button>
    </li>
  )
}
