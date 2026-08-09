/**
 * PROTOTYPE — throwaway.
 *
 * A — Command palette. One compact surface, progressive disclosure, and the
 * source list doubles as search/navigation. This is closest to T3 Code and is
 * optimized for repeat use from the app menu.
 */
import { ArrowLeft, ChevronRight, Search, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { AppBackdrop, CloneStatus, DestinationFields, SourceRows } from './parts'
import { SOURCE_COPY, type VariantProps } from './model'

export function VariantA(props: VariantProps): React.JSX.Element {
  const { state, setScenario, setSource } = props
  const choosing = state.scenario === 'source'

  return (
    <div className="relative h-full">
      <AppBackdrop />
      <div className="prototype-backdrop absolute inset-0 z-10 flex items-start justify-center px-5 pt-[10vh]">
        <section
          role="dialog"
          aria-label="Add Project"
          className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-surface-raised shadow-lg"
        >
          <header className="flex h-11 items-center gap-2 border-b border-border px-3">
            {!choosing ? (
              <button
                type="button"
                aria-label="Back to sources"
                onClick={() => setScenario('source')}
                className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ArrowLeft aria-hidden="true" className="size-4" />
              </button>
            ) : (
              <Search aria-hidden="true" className="ml-1 size-4 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 text-sm text-muted-foreground">
              {choosing ? 'Search sources…' : SOURCE_COPY[state.source].title}
            </span>
            <button
              type="button"
              aria-label="Close"
              className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </header>

          {choosing ? (
            <div className="p-2">
              <p className="px-3 py-2 text-2xs tracking-wide text-muted-foreground uppercase">
                Sources
              </p>
              <SourceRows
                selected={state.source}
                onSelect={(source) => {
                  setSource(source)
                  if (source !== 'local') setScenario('configure')
                }}
                compact
              />
              <div className="mt-2 border-t border-border px-3 py-2 text-2xs text-muted-foreground">
                ↑↓ Navigate <span className="ml-3 font-mono">Enter</span> Select{' '}
                <span className="ml-3 font-mono">Esc</span> Close
              </div>
            </div>
          ) : (
            <div>
              <div className="p-4">
                {state.scenario === 'cloning' || state.scenario === 'failed' ? (
                  <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">{state.repository}</span>
                      <ChevronRight aria-hidden="true" className="size-3" />
                      <span className="truncate font-mono">{state.destination}</span>
                    </div>
                    <CloneStatus failed={state.scenario === 'failed'} />
                  </div>
                ) : (
                  <DestinationFields {...props} />
                )}
              </div>
              <footer className="flex items-center justify-between border-t border-border bg-muted/40 px-4 py-3">
                <span className="text-2xs text-muted-foreground">
                  {state.scenario === 'failed'
                    ? 'The incomplete folder was not removed.'
                    : 'Git credentials stay on this device.'}
                </span>
                <div className="flex gap-2">
                  {state.scenario === 'cloning' ? (
                    <Button variant="secondary" onClick={() => setScenario('failed')}>
                      Cancel
                    </Button>
                  ) : (
                    <>
                      <Button variant="secondary" onClick={() => setScenario('source')}>
                        {state.scenario === 'failed' ? 'Back' : 'Cancel'}
                      </Button>
                      <Button onClick={() => setScenario('cloning')}>
                        {state.scenario === 'failed' ? 'Try again' : 'Clone Project'}
                      </Button>
                    </>
                  )}
                </div>
              </footer>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
