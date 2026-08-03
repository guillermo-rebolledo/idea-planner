import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import {
  gateProblem,
  harnessesReadyForASession,
  type HarnessReadiness,
  type ReadinessSnapshot
} from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { CopyableCommand, LoginShellConsent } from '@renderer/components/Readiness'
import { cn } from '@renderer/lib/utils'

interface LaunchGateProps {
  /** The snapshot the app already has, so the gate opens saying something. */
  snapshot: ReadinessSnapshot
  /** The person's move, once a check has found a Harness to work with. */
  onContinue: (snapshot: ReadinessSnapshot) => void
}

/** How often the gate re-probes on its own while it is on screen. */
const AUTO_RECHECK_MS = 4000

/** One vocabulary for how bad it is: the dot and the words always agree. */
const SEVERITY_STYLES = {
  ready: { dot: 'bg-positive', text: 'text-positive' },
  missing: { dot: 'bg-status-failed', text: 'text-destructive' },
  blocked: { dot: 'bg-status-blocked', text: 'text-notice-foreground' }
} as const

/**
 * What the app shows when it cannot do the one thing it is for (mockup 1e).
 * Every Run is work done by a Harness this app drives; without one there is
 * nothing here but a window. Each Harness gets one row: a dot for how bad it
 * is, the problem in a sentence, and the one command that repairs it — in the
 * person's own terminal, never run by the app.
 *
 * The way back in is a check, not a restart: the gate re-probes on its own
 * every few seconds, "Check again" exists for the person who just pressed
 * enter in their terminal, and continuing stays their move rather than the
 * screen changing under them.
 */
export function LaunchGate({ snapshot, onContinue }: LaunchGateProps): React.JSX.Element {
  const [checked, setChecked] = useState(snapshot)
  const [checking, setChecking] = useState(false)
  // One probe at a time: the interval skips while any check is in flight, so
  // a slow probe is never stacked under three more of itself.
  const inFlightRef = useRef(false)
  const ready = harnessesReadyForASession(checked)

  const check = useCallback((showBusy: boolean): void => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    if (showBusy) setChecking(true)
    window.shell
      .refreshReadiness()
      // A failed probe leaves the last honest answer on screen; the next
      // tick asks again.
      .then(setChecked, () => undefined)
      .finally(() => {
        inFlightRef.current = false
        setChecking(false)
      })
  }, [])

  useEffect(() => {
    const id = setInterval(() => check(false), AUTO_RECHECK_MS)
    return () => clearInterval(id)
  }, [check])

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag-region h-11 shrink-0" aria-hidden="true" />
      <main className="flex min-h-0 flex-1 justify-center overflow-y-auto p-8 pt-4">
        <section
          className="flex w-full max-w-xl flex-col gap-5"
          aria-labelledby="launch-gate-title"
        >
          {/* The headline keeps up with the dots: once a row turns green,
              "no Harness can" would be the screen contradicting itself. */}
          <div>
            <h1 id="launch-gate-title" className="text-lg font-semibold tracking-tight">
              {ready.length > 0
                ? `${ready.map((harness) => harness.displayName).join(' and ')} can run a Session now`
                : 'No Harness can run a Session yet'}
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              {ready.length > 0
                ? 'Continue whenever you like — anything still amber or red can be fixed later, from the app menu.'
                : 'This app drives coding agents already installed on your Mac. Fix either one below and you’re in.'}
            </p>
          </div>

          <ul
            className="flex flex-col divide-y divide-border rounded-lg border border-border"
            aria-label="Harnesses"
          >
            {checked.harnesses.map((harness) => (
              <HarnessRow
                key={harness.harness}
                harness={harness}
                disabled={checking}
                onSnapshot={setChecked}
              />
            ))}
          </ul>

          <div className="flex items-center gap-3">
            {ready.length > 0 && <Button onClick={() => onContinue(checked)}>Continue</Button>}
            <Button variant="secondary" disabled={checking} onClick={() => check(true)}>
              <RefreshCw
                aria-hidden="true"
                className={cn('size-3.5', checking && 'animate-spin')}
              />
              Check again
            </Button>
            <p className="text-xs text-muted-foreground">
              Also re-checks on its own every few seconds — no restart needed.
            </p>
          </div>

          <LoginShellConsent
            consent={checked.loginShellConsent}
            disabled={checking}
            onSet={(consent) => {
              void window.shell.setLoginShellDiscovery(consent).then(setChecked, () => undefined)
            }}
          />
        </section>
      </main>
    </div>
  )
}

/**
 * One Harness, one verdict, one repair. The dot is red only when the tool
 * itself is absent; everything short of that — wrong version, signed out — is
 * amber, because the machine has the tool and the person is one command away.
 * The repair itself stays theirs: a command to copy, a page to read, or — for
 * an install PATH cannot see — an executable they point the app at.
 */
function HarnessRow({
  harness,
  disabled,
  onSnapshot
}: {
  harness: HarnessReadiness
  disabled: boolean
  onSnapshot: (snapshot: ReadinessSnapshot) => void
}): React.JSX.Element {
  const problem = gateProblem(harness)
  const styles = SEVERITY_STYLES[problem?.severity ?? 'ready']

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-baseline gap-2.5">
        <span
          aria-hidden="true"
          className={cn('size-1.75 shrink-0 self-center rounded-full', styles.dot)}
        />
        <h2 className="text-sm font-semibold">{harness.displayName}</h2>
        <span className={cn('text-xs', styles.text)}>{problem?.label ?? 'Ready'}</span>
        {harness.version && (
          <span className="ml-auto font-mono text-2xs text-muted-foreground">
            v{harness.version}
          </span>
        )}
      </div>
      {problem && (
        <>
          <p className="text-xs leading-relaxed text-muted-foreground">{problem.summary}</p>
          {problem.command && <CopyableCommand command={problem.command} />}
          <div className="flex items-center gap-2">
            {problem.links.map((link) => (
              <button
                key={link.url}
                type="button"
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={() => void window.shell.openExternalLink(link.url)}
              >
                {link.label}
              </button>
            ))}
            {/* Installed somewhere PATH cannot see is still installed. */}
            {problem.severity === 'missing' && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                disabled={disabled}
                onClick={() =>
                  void window.shell.chooseHarnessExecutable(harness.harness).then(
                    (result) => {
                      if (!result.canceled) onSnapshot(result.snapshot)
                    },
                    () => undefined
                  )
                }
              >
                Choose executable…
              </Button>
            )}
          </div>
        </>
      )}
    </li>
  )
}
