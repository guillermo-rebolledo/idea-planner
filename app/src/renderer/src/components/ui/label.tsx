import * as React from 'react'
import { cn } from '@renderer/lib/utils'

function Label({ className, ...props }: React.ComponentProps<'label'>): React.JSX.Element {
  return <label className={cn('text-xs font-medium text-muted-foreground', className)} {...props} />
}

export { Label }
