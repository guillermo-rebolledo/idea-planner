import { Command as CommandPrimitive } from 'cmdk'
import { cn } from '@renderer/lib/utils'

/**
 * A command list, over cmdk. Source-owned like the rest of `ui/`: cmdk brings
 * the combobox keyboard contract — arrow keys move a selection the input keeps
 * announcing, Enter chooses it — and this keeps the markup readable.
 */
export function Command({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof CommandPrimitive>): React.JSX.Element {
  return (
    <CommandPrimitive
      className={cn('flex w-full flex-col overflow-hidden rounded-md', className)}
      {...props}
    />
  )
}

export function CommandInput({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>): React.JSX.Element {
  return (
    <div className="flex items-center border-b border-border px-3">
      <CommandPrimitive.Input
        className={cn(
          'h-9 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground',
          className
        )}
        {...props}
      />
    </div>
  )
}

export function CommandList({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>): React.JSX.Element {
  return (
    <CommandPrimitive.List
      className={cn('max-h-72 overflow-x-hidden overflow-y-auto', className)}
      {...props}
    />
  )
}

export function CommandEmpty(
  props: React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
): React.JSX.Element {
  return <CommandPrimitive.Empty className="py-6 text-center text-xs" {...props} />
}

export function CommandGroup({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>): React.JSX.Element {
  return (
    <CommandPrimitive.Group
      className={cn(
        'overflow-hidden p-1 text-foreground',
        // The heading is what names the Harness a group of models belongs to.
        '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5',
        '[&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium',
        '[&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:uppercase',
        '[&_[cmdk-group-heading]]:text-muted-foreground',
        className
      )}
      {...props}
    />
  )
}

export function CommandSeparator({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>): React.JSX.Element {
  return <CommandPrimitive.Separator className={cn('-mx-1 h-px bg-border', className)} {...props} />
}

export function CommandItem({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>): React.JSX.Element {
  return (
    <CommandPrimitive.Item
      className={cn(
        'relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none select-none',
        'data-[selected=true]:bg-accent data-[selected=true]:text-foreground',
        'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
        className
      )}
      {...props}
    />
  )
}
