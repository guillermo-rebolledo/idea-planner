import type { DiffHunk } from '@shared/contract'
import { cn } from '@renderer/lib/utils'

/**
 * `+N −M`, the product's one use of green and red. Colour is rationed to
 * exactly these numbers, so every surface renders them through this pair of
 * spans rather than colouring anything of its own.
 */
export function DiffCounts({
  added,
  removed
}: {
  added: number
  removed: number
}): React.JSX.Element {
  return (
    <>
      <span className="text-diff-added-foreground">+{added}</span>{' '}
      <span className="text-diff-removed-foreground">−{removed}</span>
    </>
  )
}

/**
 * A command's exit code, the only other place the Conversation is allowed
 * green or red: `exit 0` reads as worked and `exit 1` as didn't at a glance,
 * and a step list is exactly a glance.
 */
export function ExitCode({ code }: { code: number }): React.JSX.Element {
  return <span className={code === 0 ? 'text-positive' : 'text-destructive'}>exit {code}</span>
}

/**
 * A diff, exactly as the Harness computed it. It is read-only everywhere it
 * appears: the change is already on disk (ADR 0004) and git is the only undo,
 * so there is nothing here to accept or reject.
 */
export function DiffView({
  hunks,
  className
}: {
  hunks: DiffHunk[]
  className?: string
}): React.JSX.Element {
  return (
    <pre
      className={cn(
        'mt-1 overflow-x-auto rounded-md border border-border bg-surface p-2 font-mono text-xs select-text',
        className
      )}
    >
      {hunks.map((hunk, index) => (
        // A hunk is identified by where it starts and how far it runs.
        <div key={`${hunk.oldStart}:${hunk.newStart}:${hunk.lines.length}`}>
          {index > 0 && <div className="text-muted-foreground">⋯</div>}
          {hunk.lines.map((line, lineIndex) => (
            <div
              // A diff line has no identity beyond its position.
              // eslint-disable-next-line @eslint-react/no-array-index-key
              key={lineIndex}
              className={
                line.startsWith('+')
                  ? 'bg-diff-added-surface text-diff-added-foreground'
                  : line.startsWith('-')
                    ? 'bg-diff-removed-surface text-diff-removed-foreground'
                    : 'text-muted-foreground'
              }
            >
              {line}
            </div>
          ))}
        </div>
      ))}
    </pre>
  )
}
