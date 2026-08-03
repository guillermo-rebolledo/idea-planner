import { useEffect, useRef } from 'react'
import { cn } from '@renderer/lib/utils'

/**
 * The one modal shell. Small surfaces that must be answered before anything
 * else — the delete confirm, an Add Project refusal — render inside it; the
 * larger Harnesses dialog keeps its own richer chrome.
 *
 * Focus lands inside on open so Escape and Tab are already speaking to the
 * dialog, and the previously focused element gets focus back on close.
 */
export function Modal({
  labelledBy,
  destructive = false,
  onDismiss,
  className,
  children
}: {
  /** Id of the element naming the dialog. */
  labelledBy: string
  /** True for the confirm that guards a destructive act. */
  destructive?: boolean
  onDismiss: () => void
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    // The safe action carries `data-autofocus`; without one, the panel itself.
    const safe = panel?.querySelector<HTMLElement>('[data-autofocus]')
    ;(safe ?? panel)?.focus()
    return () => opener?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onDismiss()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onDismiss])

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/60 p-6"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onDismiss()
      }}
    >
      <div
        ref={panelRef}
        role={destructive ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cn(
          'w-full max-w-sm rounded-xl border border-border bg-surface-raised p-4 shadow-lg outline-none',
          className
        )}
      >
        {children}
      </div>
    </div>
  )
}
