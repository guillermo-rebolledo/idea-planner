import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@renderer/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        secondary: 'border border-border bg-surface text-foreground hover:bg-accent',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive-hover',
        ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground'
      },
      size: {
        default: 'h-7 px-3 text-base',
        sm: 'h-6 px-2 text-xs',
        icon: 'size-7'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

type ButtonProps = React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>

function Button({ className, variant, size, type, ...props }: ButtonProps): React.JSX.Element {
  return (
    <button
      type={type ?? 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Button, buttonVariants }
