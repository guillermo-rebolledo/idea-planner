import type { DiffHunk } from '@shared/contract'

/**
 * A diff, exactly as the Harness computed it. It is read-only everywhere it
 * appears: the change is already on disk (ADR 0004) and git is the only undo,
 * so there is nothing here to accept or reject.
 */
export function DiffView({ hunks }: { hunks: DiffHunk[] }): React.JSX.Element {
  return (
    <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-surface p-2 font-mono text-xs select-text">
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
