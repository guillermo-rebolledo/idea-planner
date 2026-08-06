/**
 * One tool call, as a line that can be opened: what was run, how it went, and
 * — once asked for — what it printed.
 *
 * After beui's Tool Result (`https://beui.dev/components/agents/tool-result`),
 * rebuilt on this app's terms. Three things changed in the translation:
 *
 * - The original animates the disclosure and the chevron with `motion/react`,
 *   and this app carries no animation runtime. The panel is a `0fr`→`1fr` grid
 *   row instead, which animates a height nobody has to measure, and the
 *   reduced-motion rule in `styles.css` switches it off with everything else.
 * - Status colour comes from this app's roles rather than Tailwind's palette.
 *   Green and red are spoken for here — additions and deletions — so a tool
 *   that simply worked is stated in the muted ink, and only a failure spends
 *   the destructive role.
 * - It opens closed. A Run can make dozens of these, and a transcript that
 *   unfurls every one of them is a transcript nobody can read past.
 */
import { Check, ChevronDown, Copy, LoaderCircle, SquareTerminal } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '@renderer/lib/utils'

export type ToolResultStatus = 'running' | 'success' | 'error' | 'cancelled'

interface ToolResultProps {
  /**
   * What ran, named the way the Harness names it — drawn in mono, quietly.
   * Left off when the icon and the title already say it, as they do for a
   * shell command sitting behind a terminal mark.
   */
  tool?: string
  /** The one line that says what this call was. */
  title: React.ReactNode
  /** What it cost or what it answered — a duration, an exit code. */
  meta?: React.ReactNode
  status?: ToolResultStatus
  icon?: React.ReactNode
  /** Closed unless the caller has a reason; see the note above. */
  defaultOpen?: boolean
  /** Offers a copy button, and is what it copies. */
  copyText?: string
  /** How tall the output may grow before it scrolls instead. */
  maxHeight?: number
  children: React.ReactNode
  className?: string
}

const STATUS_TEXT: Record<ToolResultStatus, string> = {
  running: 'Running',
  success: 'Done',
  error: 'Failed',
  cancelled: 'Interrupted'
}

const STATUS_INK: Record<ToolResultStatus, string> = {
  running: 'text-status-running',
  success: 'text-muted-foreground',
  error: 'text-destructive',
  cancelled: 'text-muted-foreground'
}

/** How long "Copied" stands before the button says what it does again. */
const COPIED_FOR_MS = 1_600

function StatusMark({ status }: { status: ToolResultStatus }): React.JSX.Element {
  if (status === 'running') {
    return (
      <LoaderCircle aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />
    )
  }
  return <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
}

export function ToolResult({
  tool,
  title,
  meta,
  status = 'success',
  icon,
  defaultOpen = false,
  copyText,
  maxHeight = 220,
  children,
  className
}: ToolResultProps): React.JSX.Element {
  const baseId = useId()
  const triggerId = `${baseId}-trigger`
  const panelId = `${baseId}-panel`
  const [open, setOpen] = useState(defaultOpen)
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number | undefined>(undefined)

  useEffect(
    () => () => {
      window.clearTimeout(copiedTimerRef.current)
    },
    []
  )

  /* Same bargain the app's other copy button makes: say so when it worked,
     and when the clipboard refuses, say nothing — the output above is
     selectable, which is the answer either way. */
  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => {
        setCopied(false)
      }, COPIED_FOR_MS)
    } catch {
      // Unavailable, or the window is not focused. The text stays selectable.
    }
  }

  return (
    <div data-status={status} className={cn('w-full', className)}>
      <button
        id={triggerId}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen(!open)
        }}
        className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted/40"
      >
        <span aria-hidden="true" className="shrink-0 text-muted-foreground">
          {icon ?? <SquareTerminal className="size-3.5" />}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{title}</span>
        {meta !== undefined && (
          <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
            {meta}
          </span>
        )}
        <span className={cn('flex shrink-0 items-center gap-1.5 text-2xs', STATUS_INK[status])}>
          <StatusMark status={status} />
          {STATUS_TEXT[status]}
        </span>
        {tool !== undefined && (
          <span aria-hidden="true" className="shrink-0 font-mono text-2xs text-muted-foreground/60">
            {tool}
          </span>
        )}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
            open && 'rotate-180'
          )}
        />
      </button>

      {/* A grid row is a height the browser can animate without anyone
          measuring the content first, which is the whole reason the original's
          layout animation is not missed here. */}
      <div
        id={panelId}
        role="region"
        aria-labelledby={triggerId}
        inert={!open}
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
        className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
      >
        <div className="overflow-hidden">
          <div className="mt-1 mb-1 ml-6 overflow-hidden rounded-md border border-border bg-muted/50">
            <div className="overflow-auto" style={{ maxHeight }}>
              <div className="p-2.5">{children}</div>
            </div>
            {copyText !== undefined && copyText !== '' && (
              <div className="flex border-t border-border px-1 py-1">
                <button
                  type="button"
                  onClick={() => {
                    void copy(copyText)
                  }}
                  className="flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {copied ? (
                    <Check aria-hidden="true" className="size-3" />
                  ) : (
                    <Copy aria-hidden="true" className="size-3" />
                  )}
                  {copied ? 'Copied' : 'Copy output'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Captured text, in the bordered mono block every other captured text gets. */
export function ToolResultOutput({ children }: { children: string }): React.JSX.Element {
  return (
    <pre className="font-mono text-2xs break-words whitespace-pre-wrap select-text">{children}</pre>
  )
}
