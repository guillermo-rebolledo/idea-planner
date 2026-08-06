import { PreviewCard as PreviewCardPrimitive } from '@base-ui/react/preview-card'
import { cn } from '@renderer/lib/utils'

/**
 * shadcn's Base UI Hover Card, adapted to this app's aliases and visual tokens.
 * Base UI calls the underlying primitive Preview Card.
 */
export function HoverCard(props: PreviewCardPrimitive.Root.Props): React.JSX.Element {
  return <PreviewCardPrimitive.Root data-slot="hover-card" {...props} />
}

export function HoverCardTrigger(props: PreviewCardPrimitive.Trigger.Props): React.JSX.Element {
  return <PreviewCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
}

export function HoverCardContent({
  className,
  side = 'bottom',
  sideOffset = 4,
  align = 'center',
  alignOffset = 4,
  ...props
}: PreviewCardPrimitive.Popup.Props &
  Pick<
    PreviewCardPrimitive.Positioner.Props,
    'align' | 'alignOffset' | 'side' | 'sideOffset'
  >): React.JSX.Element {
  return (
    <PreviewCardPrimitive.Portal data-slot="hover-card-portal">
      <PreviewCardPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <PreviewCardPrimitive.Popup
          data-slot="hover-card-content"
          className={cn(
            'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 w-64 origin-(--transform-origin) rounded-lg bg-popover p-2.5 text-sm text-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none motion-reduce:transition-none',
            className
          )}
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  )
}
