import { useState } from 'react'
import { firstProblem, harnessesReadyForASession, type ReadinessSnapshot } from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { ReadinessPanel } from '@renderer/components/Readiness'

interface LaunchGateProps {
  /** The snapshot the app already has, so the gate opens saying something. */
  snapshot: ReadinessSnapshot
  /** The person's move, once a check has found a Harness to work with. */
  onContinue: (snapshot: ReadinessSnapshot) => void
}

/**
 * What the app shows when it cannot do the one thing it is for. Every Run is
 * work done by a Harness this app drives; without one there is nothing here
 * but a window. That is the accepted deal, so it is said plainly and with the
 * repair in reach, rather than behind a surface that takes a message and then
 * does nothing with it.
 *
 * Repairs happen in the person's own terminal. The way back in is a check, not
 * a restart: the panel re-probes on demand, and continuing stays their move
 * rather than the screen changing under them.
 */
export function LaunchGate({ snapshot, onContinue }: LaunchGateProps): React.JSX.Element {
  const [checked, setChecked] = useState(snapshot)
  const ready = harnessesReadyForASession(checked)

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag-region h-11 shrink-0" aria-hidden="true" />
      <main className="flex min-h-0 flex-1 justify-center overflow-y-auto p-8">
        <section className="w-full max-w-xl" aria-labelledby="launch-gate-title">
          <h1 id="launch-gate-title" className="text-lg font-semibold">
            This app needs a coding agent to work
          </h1>
          <p className="mt-2 leading-relaxed text-muted-foreground">
            Every Run is work done by a coding agent on your Mac — this app never does the thinking
            itself. Nothing here can run a Session yet, and until something can there is nothing for
            this app to do. Which Harnesses it can drive is below: not every one it checks for is
            one it can work with today.
          </p>
          {/* Named rather than counted: "nothing is usable" is true of a
              machine with nothing installed and of one signed out of both,
              and those are different afternoons. */}
          <ul className="mt-4 flex flex-col gap-1" aria-label="What is missing">
            {checked.harnesses.map((harness) => (
              <li key={harness.harness} className="text-sm">
                <span className="font-medium">{harness.displayName}</span>{' '}
                <span className="text-muted-foreground">— {firstProblem(harness)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            Repair it in your own terminal with the guidance below, then check again. Nothing is
            installed, updated, or signed in for you, and you never have to restart the app.
          </p>
          <div className="mt-6">
            <ReadinessPanel onSnapshot={setChecked} />
          </div>
          {ready.length > 0 && (
            <div className="mt-6 flex items-center gap-3" role="status">
              <Button onClick={() => onContinue(checked)}>Continue</Button>
              <p className="text-sm">
                {ready.map((harness) => harness.displayName).join(' and ')} can run a Session now.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
