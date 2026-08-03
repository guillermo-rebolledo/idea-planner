/**
 * Vendored from shadcn's registry
 * (`https://ui.shadcn.com/r/styles/base-nova/message-scroller.json`), then
 * repointed at this app's own primitives.
 *
 * The behavior — opening position, anchoring a new turn near the top, keeping
 * a peek of the previous turn, following a streamed reply only while the
 * reader is at the live edge, and holding position when history is prepended
 * — all lives in `@shadcn/react/message-scroller`. This file is only the
 * styled frame, and is kept close to the original so it can be diffed against
 * a newer registry copy.
 *
 * Changed from the registry copy, and only this:
 * - `cn` and `Button` come from this app's `ui/`.
 * - The docs-site `IconPlaceholder` becomes the lucide icon it stands for.
 * - The scrollbar utilities are dropped: the app styles its own scrollbar in
 *   `styles.css`, and a second opinion about it would be a third scrollbar.
 */
import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility
} from '@shadcn/react/message-scroller'
import { ArrowDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

function MessageScrollerProvider(
  props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>
): React.JSX.Element {
  return <MessageScrollerPrimitive.Provider {...props} />
}

function MessageScroller({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Root>): React.JSX.Element {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn(
        'group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden',
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>): React.JSX.Element {
  return (
    <MessageScrollerPrimitive.Viewport
      data-slot="message-scroller-viewport"
      className={cn(
        'size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain contain-content',
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>): React.JSX.Element {
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      className={cn('flex h-max min-h-full flex-col gap-6', className)}
      {...props}
    />
  )
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>): React.JSX.Element {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      className={cn(
        'min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]',
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerButton({
  direction = 'end',
  className,
  children,
  render,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button>): React.JSX.Element {
  return (
    <MessageScrollerPrimitive.Button
      data-slot="message-scroller-button"
      data-direction={direction}
      direction={direction}
      className={cn(
        'absolute inset-s-1/2 -translate-x-1/2 border border-border bg-surface-raised text-foreground shadow-md transition-[translate,scale,opacity] duration-200 hover:bg-accent data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[direction=end]:bottom-4 data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full data-[direction=start]:[&_svg]:rotate-180',
        className
      )}
      render={render ?? <Button variant="secondary" size="icon" className="rounded-full" />}
      {...props}
    >
      {children ?? (
        <>
          <ArrowDown aria-hidden="true" className="size-3.5" />
          <span className="sr-only">
            {direction === 'end' ? 'Jump to the latest message' : 'Jump to the first message'}
          </span>
        </>
      )}
    </MessageScrollerPrimitive.Button>
  )
}

export {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility
}
