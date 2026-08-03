import * as React from 'react'
import { cn } from '@renderer/lib/utils'

function Input({ className, ...props }: React.ComponentProps<'input'>): React.JSX.Element {
  return (
    <input
      className={cn(
        'h-8 w-full rounded-md border border-border bg-surface px-2.5 text-base text-foreground transition-colors outline-none select-text placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
}

export { Input }
