import { PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@renderer/lib/utils'

/**
 * The composer's chip-popover vocabulary, written once: a quiet chip in the
 * row of chips under the field, and the mono uppercase heading its popover
 * opens with. Three surfaces grew the same markup independently — Checkout,
 * Permission Mode, and the Skills `/` list — and three copies of one pattern
 * are three chances for it to drift.
 */

/**
 * A chip in the composer's row: quiet text, no outline, no glyph — the row is
 * read as a sentence about this message, not as a toolbar. `alert` is the one
 * loud variant, for a chip that is itself a standing warning.
 */
export function ChipTrigger({
  alert = false,
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof PopoverTrigger> & { alert?: boolean }): React.JSX.Element {
  return (
    <PopoverTrigger
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs',
        alert
          ? 'bg-status-blocked-surface text-status-blocked'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        className
      )}
      {...props}
    >
      {children}
    </PopoverTrigger>
  )
}

/** The mono uppercase line a chip's popover opens with, naming what it sets. */
export function PopoverHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="px-3 pt-2.5 pb-1 font-mono text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </p>
  )
}
