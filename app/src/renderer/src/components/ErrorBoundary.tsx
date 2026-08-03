import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * The last thing between a render that threw and a window with nothing in it.
 *
 * React unmounts the whole tree when a render fails, and an unmounted tree is
 * a page painted in the theme's own background — which is to say a black
 * screen that says nothing, in an app whose every other failure explains
 * itself. Nothing here can fix the error; it exists so the person is told
 * there was one, and so the message reaches whoever has to fix it.
 *
 * Deliberately dependency-free markup: this renders when something else in
 * this tree is already broken, so it borrows nothing that could break with it.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failure: Error | null }> {
  override state: { failure: Error | null } = { failure: null }

  static getDerivedStateFromError(failure: Error): { failure: Error } {
    return { failure }
  }

  override componentDidCatch(failure: Error, info: ErrorInfo): void {
    // Kept where a person can copy it: the window's own console, which the
    // packaged app can open, rather than a channel nobody can reach.
    console.error('The window failed to render.', failure, info.componentStack)
  }

  override render(): ReactNode {
    const { failure } = this.state
    if (!failure) return this.props.children
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
      >
        <p className="text-foreground">This window stopped drawing.</p>
        <p className="max-w-md text-xs text-muted-foreground">
          Your Projects and Sessions are on disk and untouched. Reloading starts the window again;
          if it keeps happening, the message below is what to report.
        </p>
        <code className="max-w-md font-mono text-2xs break-all text-muted-foreground select-text">
          {failure.message}
        </code>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
        >
          Reload the window
        </button>
      </div>
    )
  }
}
