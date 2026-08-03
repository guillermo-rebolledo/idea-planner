import { Menu as BaseMenu } from '@base-ui/react/menu'
import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu'
import { cn } from '@renderer/lib/utils'

/**
 * Menus, over Base UI's. Source-owned like the rest of `ui/`: the primitives
 * handle focus, typeahead and dismissal, and the markup stays readable here.
 *
 * The dropdown (`Menu*`) and the right-click (`ContextMenu*`) variants share
 * the popup styling so one set of items can serve both.
 */

const POPUP_CLASS =
  'z-50 min-w-52 rounded-lg border border-border bg-popover p-1 text-xs text-foreground shadow-md outline-none'

export const Menu = BaseMenu.Root
export const MenuTrigger = BaseMenu.Trigger

export function MenuContent({
  className,
  align = 'start',
  side = 'bottom',
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof BaseMenu.Popup> & {
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
}): React.JSX.Element {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner align={align} side={side} sideOffset={4}>
        <BaseMenu.Popup className={cn(POPUP_CLASS, className)} {...props}>
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  )
}

export const ContextMenu = BaseContextMenu.Root
export const ContextMenuTrigger = BaseContextMenu.Trigger

export function ContextMenuContent({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof BaseContextMenu.Popup>): React.JSX.Element {
  return (
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner>
        <BaseContextMenu.Popup className={cn(POPUP_CLASS, className)} {...props}>
          {children}
        </BaseContextMenu.Popup>
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  )
}

/** One item, shared by both variants: a ContextMenu popup accepts Menu items. */
export function MenuItem({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof BaseMenu.Item>): React.JSX.Element {
  return (
    <BaseMenu.Item
      className={cn(
        'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none data-highlighted:bg-accent',
        className
      )}
      {...props}
    >
      {children}
    </BaseMenu.Item>
  )
}

export function MenuSeparator(): React.JSX.Element {
  return <BaseMenu.Separator className="my-1 h-px bg-border" />
}

/** The keyboard way in, named beside the pointer way. */
export function MenuShortcut({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span aria-hidden="true" className="ml-auto font-mono text-2xs text-muted-foreground">
      {children}
    </span>
  )
}
