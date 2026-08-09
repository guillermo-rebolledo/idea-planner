/**
 * PROTOTYPE — throwaway.
 *
 * C — Guided wizard. A stable rail explains the three-step operation and
 * makes progress/error recovery explicit. Optimized for confidence around a
 * filesystem mutation, at the cost of more chrome and clicks.
 */
import { Check, ChevronRight, Circle, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { AppBackdrop, CloneStatus, DestinationFields, SourceRows } from './parts'
import { type Scenario, type VariantProps } from './model'

const STEPS: { id: Scenario; number: string; title: string; hint: string }[] = [
  { id: 'source', number: '1', title: 'Source', hint: 'Where the code lives' },
  { id: 'configure', number: '2', title: 'Destination', hint: 'Where it will be cloned' },
  { id: 'cloning', number: '3', title: 'Clone', hint: 'Create the Project' }
]

function rank(scenario: Scenario): number {
  if (scenario === 'source') return 0
  if (scenario === 'configure') return 1
  return 2
}

export function VariantC(props: VariantProps): React.JSX.Element {
  const { state, setScenario, setSource } = props
  const currentRank = rank(state.scenario)
  return (
    <div className="relative h-full">
      <AppBackdrop />
      <div className="prototype-backdrop absolute inset-0 z-10 grid place-items-center px-5 pb-16">
        <section
          role="dialog"
          aria-label="Add a Project"
          className="flex h-[470px] w-full max-w-3xl overflow-hidden rounded-xl border border-border bg-surface-raised shadow-lg"
        >
          <aside className="w-52 shrink-0 border-r border-border bg-muted/50 p-5">
            <p className="text-sm font-semibold">Add a Project</p>
            <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
              Clone code onto this device, then add it to Argos.
            </p>
            <ol className="mt-7 flex flex-col gap-5">
              {STEPS.map((step, index) => {
                const done = index < currentRank
                const active = index === currentRank
                return (
                  <li key={step.id} className="flex gap-2.5">
                    <span
                      className={cn(
                        'grid size-5 shrink-0 place-items-center rounded-full border font-mono text-2xs',
                        done && 'border-primary bg-primary text-primary-foreground',
                        active && 'border-ring text-foreground ring-2 ring-ring/20',
                        !done && !active && 'border-border text-muted-foreground'
                      )}
                    >
                      {done ? <Check aria-hidden="true" className="size-3" /> : step.number}
                    </span>
                    <span>
                      <span
                        className={cn(
                          'block text-xs font-medium',
                          !active && !done && 'text-muted-foreground'
                        )}
                      >
                        {step.title}
                      </span>
                      <span className="block text-2xs text-muted-foreground">{step.hint}</span>
                    </span>
                  </li>
                )
              })}
            </ol>
            <p className="mt-auto hidden text-2xs text-muted-foreground">
              Project skills stay untrusted.
            </p>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-12 items-center border-b border-border px-5">
              <span className="text-sm font-medium">
                {state.scenario === 'source'
                  ? 'Choose a source'
                  : state.scenario === 'configure'
                    ? 'Review the destination'
                    : state.scenario === 'failed'
                      ? 'Clone interrupted'
                      : 'Creating your Project'}
              </span>
              <button
                type="button"
                aria-label="Close"
                className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {state.scenario === 'source' && (
                <SourceRows selected={state.source} onSelect={setSource} />
              )}
              {state.scenario === 'configure' && <DestinationFields {...props} />}
              {(state.scenario === 'cloning' || state.scenario === 'failed') && (
                <div className="flex h-full flex-col justify-center">
                  <CloneStatus failed={state.scenario === 'failed'} />
                  <div className="mt-4 flex items-center gap-2 text-2xs text-muted-foreground">
                    <Circle aria-hidden="true" className="size-2 fill-current" />
                    {state.repository}
                    <ChevronRight aria-hidden="true" className="size-3" />
                    <span className="truncate font-mono">{state.destination}</span>
                  </div>
                </div>
              )}
            </div>
            <footer className="flex h-14 items-center justify-between border-t border-border px-5">
              <span className="text-2xs text-muted-foreground">
                {state.scenario === 'failed'
                  ? 'Nothing was added to Argos.'
                  : 'Credentials never leave this device.'}
              </span>
              <div className="flex gap-2">
                {state.scenario !== 'source' && state.scenario !== 'cloning' && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      setScenario(state.scenario === 'failed' ? 'configure' : 'source')
                    }
                  >
                    Back
                  </Button>
                )}
                {state.scenario === 'source' && (
                  <Button onClick={() => setScenario('configure')}>Continue</Button>
                )}
                {state.scenario === 'configure' && (
                  <Button onClick={() => setScenario('cloning')}>Clone Project</Button>
                )}
                {state.scenario === 'cloning' && (
                  <Button variant="secondary" onClick={() => setScenario('failed')}>
                    Cancel
                  </Button>
                )}
                {state.scenario === 'failed' && (
                  <Button onClick={() => setScenario('cloning')}>Try again</Button>
                )}
              </div>
            </footer>
          </div>
        </section>
      </div>
    </div>
  )
}
