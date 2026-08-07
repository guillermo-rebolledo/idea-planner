import { useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { newFileLines, type DiffHunk } from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
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
 * How a diff offers its lines to a message. Every control is a real button or
 * checkbox with its own name: attaching code must never require pointing at
 * text, hovering, or seeing which rows are green.
 */
export interface DiffAttachControls {
  /** Named on every control, so each one says what it attaches. */
  path: string
  onAttachHunk: (hunkIndex: number) => void
  /** The chosen lines, by their index inside that hunk. */
  onAttachLines: (hunkIndex: number, lineIndexes: number[]) => void
}

/**
 * A diff, exactly as the Harness computed it. It is read-only everywhere it
 * appears: the change is already on disk (ADR 0004) and git is the only undo,
 * so there is nothing here to accept or reject.
 *
 * With `attach`, the same diff also becomes selectable: a hunk, or lines of
 * one, can be copied onto the next message as reviewed code.
 */
export function DiffView({
  hunks,
  className,
  attach
}: {
  hunks: DiffHunk[]
  className?: string
  attach?: DiffAttachControls
}): React.JSX.Element {
  // Which lines are ticked, per hunk. Ephemeral by design: a selection is a
  // way of naming an attachment, not a thing the Session remembers.
  const [selected, setSelected] = useState<Record<number, number[]>>({})
  return (
    <pre
      className={cn(
        'mt-1 overflow-x-auto rounded-md border border-border bg-surface p-2 font-mono text-xs select-text',
        className
      )}
    >
      {hunks.map((hunk, index) => {
        const ticked = selected[index] ?? []
        // One rule for what line a patch line is, shared with what an
        // attachment records about it.
        const numbers = newFileLines(hunk)
        return (
          // A hunk is identified by where it starts and how far it runs.
          <div key={`${hunk.oldStart}:${hunk.newStart}:${hunk.lines.length}`}>
            {index > 0 && <div className="text-muted-foreground">⋯</div>}
            {attach && (
              <div className="flex flex-wrap items-center gap-1 pb-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Attach hunk ${String(index + 1)} of ${attach.path}`}
                  onClick={() => attach.onAttachHunk(index)}
                >
                  <MessageSquarePlus aria-hidden="true" className="size-3" />
                  Attach hunk {index + 1}
                </Button>
                {ticked.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Attach ${String(ticked.length)} selected ${ticked.length === 1 ? 'line' : 'lines'} of ${attach.path}`}
                    onClick={() => {
                      attach.onAttachLines(index, ticked)
                      setSelected((current) => ({ ...current, [index]: [] }))
                    }}
                  >
                    Attach {ticked.length} selected {ticked.length === 1 ? 'line' : 'lines'}
                  </Button>
                )}
              </div>
            )}
            {hunk.lines.map((line, lineIndex) => (
              <div
                // A diff line has no identity beyond its position.
                // eslint-disable-next-line @eslint-react/no-array-index-key
                key={lineIndex}
                className={cn(
                  'flex items-start gap-1.5',
                  line.startsWith('+')
                    ? 'bg-diff-added-surface text-diff-added-foreground'
                    : line.startsWith('-')
                      ? 'bg-diff-removed-surface text-diff-removed-foreground'
                      : 'text-muted-foreground'
                )}
              >
                {attach && (
                  <label className="shrink-0 cursor-pointer pt-0.5">
                    <span className="sr-only">
                      {/* Which side it is, and where it sits: a removed line
                          and the line replacing it share a number, and two
                          controls with one name are two nobody can tell apart.
                          The line's text is not repeated — it is already read
                          out beside the control. */}
                      {`Select ${lineSide(line)} line ${String(numbers[lineIndex] ?? hunk.newStart)} of hunk ${String(index + 1)} in ${attach.path}, row ${String(lineIndex + 1)}`}
                    </span>
                    <input
                      type="checkbox"
                      checked={ticked.includes(lineIndex)}
                      onChange={(event) =>
                        setSelected((current) => {
                          const now = current[index] ?? []
                          return {
                            ...current,
                            [index]: event.target.checked
                              ? [...now, lineIndex]
                              : now.filter((value) => value !== lineIndex)
                          }
                        })
                      }
                      className="size-3 accent-foreground"
                    />
                  </label>
                )}
                <span className="min-w-0">{line}</span>
              </div>
            ))}
          </div>
        )
      })}
    </pre>
  )
}

/** What a patch line is: added, removed, or carried through unchanged. */
function lineSide(line: string): string {
  if (line.startsWith('+')) return 'added'
  if (line.startsWith('-')) return 'removed'
  return 'unchanged'
}
