import * as React from 'react'
import { cn } from '@renderer/lib/utils'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>): React.JSX.Element {
  return (
    <textarea
      className={cn(
        'w-full resize-none rounded-md border border-border bg-surface px-2.5 py-2 text-[13px] leading-relaxed text-foreground transition-colors outline-none select-text placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
