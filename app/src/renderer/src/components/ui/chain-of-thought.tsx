/**
 * What a Run did, as one thing that can be opened rather than as everything it
 * did, stacked.
 *
 * A Run makes dozens of steps, and a transcript that gives each one a row of
 * its own is a transcript whose prose is pushed off the screen by its
 * bookkeeping. So the steps fold into a single line saying what happened, and
 * the line opens onto the record when someone wants it.
 *
 * After Nexus UI's Chain of Thought
 * (`https://nexus-ui.dev/docs/components/chain-of-thought`) and, for the
 * openable step, beui's Tool Result
 * (`https://beui.dev/components/agents/tool-result`), rebuilt on this app's
 * terms. What changed in the translation:
 *
 * - Both originals animate their disclosures with `motion/react`, and this app
 *   carries no animation runtime. Every panel here is a `0fr`→`1fr` grid row
 *   instead, which animates a height nobody has to measure, and the
 *   reduced-motion rule in `styles.css` switches it off with everything else.
 * - Status colour comes from this app's roles rather than Tailwind's palette.
 *   Green and red are spoken for here — additions and deletions — so a step
 *   that simply worked is stated in the muted ink, and only a failure spends
 *   the destructive role.
 * - Nexus closes the chain once every step completes. Here the chain follows
 *   the Run: open while it works, closed once it is history. A person who
 *   opens or closes it themselves has said what they want, and it is not
 *   overruled afterwards.
 */
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '@renderer/lib/utils'

export type ChainStepStatus = 'running' | 'success' | 'error' | 'cancelled'

const STATUS_TEXT: Record<ChainStepStatus, string> = {
  running: 'Running',
  success: 'Done',
  error: 'Failed',
  cancelled: 'Interrupted'
}

const STATUS_INK: Record<ChainStepStatus, string> = {
  running: 'text-status-running',
  success: 'text-muted-foreground',
  error: 'text-destructive',
  cancelled: 'text-muted-foreground'
}

/** How long "Copied" stands before the button says what it does again. */
const COPIED_FOR_MS = 1_600

interface ChainOfThoughtProps {
  /** The one sentence saying what the Run did, drawn in the reading face. */
  label: React.ReactNode
  /** What it cost — a duration — kept to the right of the line. */
  meta?: React.ReactNode
  /**
   * The Run is still working. The chain stands open while that is true, and
   * closes itself when the Run ends unless someone has said otherwise.
   */
  running?: boolean
  /** Named for assistive technology, which has no chain to look at. */
  ariaLabel?: string
  children: React.ReactNode
  className?: string
}

export function ChainOfThought({
  label,
  meta,
  running = false,
  ariaLabel = 'What this Run did',
  children,
  className
}: ChainOfThoughtProps): React.JSX.Element {
  const baseId = useId()
  const triggerId = `${baseId}-trigger`
  const panelId = `${baseId}-panel`
  const [open, setOpen] = useState(running)
  /* Whether the person has taken the chain over. Until they do it follows the
     Run; afterwards it stays where they left it, because a panel that reopens
     itself after being closed is a panel that is not really closable. */
  const claimedRef = useRef(false)

  useEffect(() => {
    if (!claimedRef.current) setOpen(running)
  }, [running])

  return (
    <section aria-label={ariaLabel} className={cn('w-full', className)}>
      <button
        id={triggerId}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          claimedRef.current = true
          setOpen(!open)
        }}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted/40"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
            open && 'rotate-90'
          )}
        />
        <span className={cn('min-w-0 flex-1 truncate text-xs', running && 'shimmer')}>{label}</span>
        {meta !== undefined && (
          <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
            {meta}
          </span>
        )}
      </button>

      <div
        id={panelId}
        role="region"
        aria-labelledby={triggerId}
        inert={!open}
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
        className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
      >
        <div className="overflow-hidden">
          {/* The rule down the left is what makes a list of steps read as one
              sequence of work rather than as loose rows. */}
          <ol className="mt-0.5 mb-1 ml-3.5 flex flex-col border-l border-border pl-2.5">
            {children}
          </ol>
        </div>
      </div>
    </section>
  )
}

interface ChainStepProps {
  /** What kind of step this was, in the mark the transcript uses for it. */
  icon: React.ReactNode
  /**
   * The step in one line. Prose for a step the app can describe honestly — a
   * file it read, a change it made — and the command itself for a command,
   * because no rewording of a shell command is truer than the command.
   */
  title: React.ReactNode
  /** True when the title is a command and should be drawn as one. */
  mono?: boolean
  /** What it cost or what it answered — a duration, an exit code, a diff. */
  meta?: React.ReactNode
  /** Omitted for a step that had no outcome to report, such as a file read. */
  status?: ChainStepStatus
  /** Where the step leads, for a row that opens something elsewhere. */
  onOpen?: () => void
  /** Offers a copy button, and is what it copies. */
  copyText?: string
  /** How tall the panel may grow before it scrolls instead. */
  maxHeight?: number
  /** What the step has to show, when it has anything. */
  children?: React.ReactNode
}

/**
 * One step of the chain. It is a row, an openable row, or a row that leads
 * somewhere, depending only on what the step actually has: nothing here
 * invites a click that answers with an empty panel.
 */
export function ChainStep({
  icon,
  title,
  mono = false,
  meta,
  status,
  onOpen,
  copyText,
  maxHeight = 220,
  children
}: ChainStepProps): React.JSX.Element {
  const baseId = useId()
  const triggerId = `${baseId}-trigger`
  const panelId = `${baseId}-panel`
  const [open, setOpen] = useState(false)
  const openable = children !== undefined

  const line = (
    <>
      <span aria-hidden="true" className="shrink-0 text-muted-foreground">
        {icon}
      </span>
      <span className={cn('min-w-0 flex-1 truncate text-xs', mono && 'font-mono')}>{title}</span>
      {meta !== undefined && (
        <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
          {meta}
        </span>
      )}
      {status !== undefined && (
        <span className={cn('flex shrink-0 items-center gap-1.5 text-2xs', STATUS_INK[status])}>
          <StatusMark status={status} />
          {STATUS_TEXT[status]}
        </span>
      )}
    </>
  )

  if (openable) {
    return (
      <li>
        <button
          id={triggerId}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            setOpen(!open)
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted/40"
        >
          {line}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
              open && 'rotate-180'
            )}
          />
        </button>
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
              {copyText !== undefined && copyText !== '' && <CopyOutputButton text={copyText} />}
            </div>
          </div>
        </div>
      </li>
    )
  }

  if (onOpen !== undefined) {
    return (
      <li>
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted/40"
        >
          {line}
        </button>
      </li>
    )
  }

  return <li className="flex items-center gap-2 px-2 py-1 text-muted-foreground">{line}</li>
}

function StatusMark({ status }: { status: ChainStepStatus }): React.JSX.Element {
  if (status === 'running') {
    return (
      <span
        aria-hidden="true"
        className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none"
      />
    )
  }
  return <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
}

/**
 * Same bargain the app's other copy buttons make: say so when it worked, and
 * when the clipboard refuses, say nothing — the output above is selectable,
 * which is the answer either way.
 */
function CopyOutputButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current)
    },
    []
  )

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        setCopied(false)
      }, COPIED_FOR_MS)
    } catch {
      // Unavailable, or the window is not focused. The text stays selectable.
    }
  }

  return (
    <div className="flex border-t border-border px-1 py-1">
      <button
        type="button"
        onClick={() => {
          void copy()
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
  )
}

/** Captured text, in the bordered mono block every other captured text gets. */
export function ChainStepOutput({ children }: { children: string }): React.JSX.Element {
  return (
    <pre className="font-mono text-2xs break-words whitespace-pre-wrap select-text">{children}</pre>
  )
}
