import { Check } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

/**
 * One option in a popover of choices, drawn the way the model menu draws a
 * model: an icon in its own leading column, the name and what it means beside
 * it — so the second line lines up under the first rather than under the icon
 * — and the mark of the chosen one centred against the whole row.
 *
 * Hover and chosen are deliberately different currencies. A fill follows the
 * pointer; a check states what is in force. A row that wore a fill for being
 * chosen would put the two in the same currency, and then the row under the
 * pointer and the row in force are the same picture.
 */
export function ChoiceRow({
  icon,
  name,
  description,
  chosen,
  onClick,
  className
}: {
  /**
   * Rendered by the caller, so an option can carry its own colour. Its column
   * is held open even when there is none, so the names of a set of options
   * always start at the same inset.
   */
  icon?: React.ReactNode
  name: React.ReactNode
  description: React.ReactNode
  chosen: boolean
  onClick: () => void
  className?: string
}): React.JSX.Element {
  return (
    // A radio, not a toggle: the options are one-of-a-set, and a screen
    // reader should say so. Callers wrap a set in role="radiogroup".
    <button
      type="button"
      role="radio"
      aria-checked={chosen}
      onClick={onClick}
      className={cn(
        'relative flex w-full cursor-default items-start gap-2 rounded-sm px-2 py-1.5 pe-8 text-left text-xs outline-none hover:bg-accent focus-visible:bg-accent',
        className
      )}
    >
      {/* Always the same column, whether this option carries a glyph or not:
          two options whose names start at different insets read as two lists. */}
      <span aria-hidden="true" className="mt-0.5 flex size-3.5 shrink-0 items-center">
        {icon}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{name}</span>
        {/* Quieter than the name it explains: the option is chosen by its
            name, and the sentence is there for the moment somebody wonders. */}
        <span className="text-2xs leading-relaxed text-muted-foreground">{description}</span>
      </span>
      {chosen && (
        <span
          data-slot="chosen-mark"
          className="absolute end-2 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center"
        >
          <Check aria-hidden="true" className="size-4" />
        </span>
      )}
    </button>
  )
}
