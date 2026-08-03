import { Popover as BasePopover } from '@base-ui/react/popover'
import { cn } from '@renderer/lib/utils'

/**
 * A popover, over Base UI's. Source-owned like the rest of `ui/`: the app
 * takes the primitive that handles focus, dismissal and collision, and keeps
 * the markup where it can be read.
 *
 * The API is the one the vendored model selector expects — `side` is fed back
 * to it from what actually rendered, so `data-side` on the popup is part of
 * the contract rather than an implementation detail.
 */
export function Popover({
  open,
  onOpenChange,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <BasePopover.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </BasePopover.Root>
  )
}

export function PopoverTrigger({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof BasePopover.Trigger>): React.JSX.Element {
  return (
    <BasePopover.Trigger className={className} {...props}>
      {children}
    </BasePopover.Trigger>
  )
}

export function PopoverContent({
  className,
  align = 'center',
  side = 'bottom',
  sideOffset = 4,
  ref,
  children,
  ...props
}: Omit<React.ComponentPropsWithoutRef<typeof BasePopover.Popup>, 'ref'> & {
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
  sideOffset?: number
  ref?: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner align={align} side={side} sideOffset={sideOffset}>
        <BasePopover.Popup
          ref={ref}
          className={cn(
            'z-50 rounded-md border border-border bg-popover text-foreground shadow-md outline-none',
            className
          )}
          {...props}
        >
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  )
}
