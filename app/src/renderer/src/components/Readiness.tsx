import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Info,
  Minus,
  RefreshCw,
  XCircle,
  X
} from 'lucide-react'
import {
  isGating,
  type HarnessId,
  type HarnessReadiness,
  type ReadinessCheck,
  type ReadinessDimension,
  type ReadinessSnapshot
} from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

/**
 * The reusable readiness surface shown at the launch gate and in Settings.
 * Codex and Claude stay visible independently; each dimension reports its own
 * state with safe, copyable remediation. The app never installs, signs in, or
 * runs any remediation command itself.
 */

const DIMENSION_LABELS: Record<ReadinessDimension, string> = {
  executable: 'Executable',
  compatibility: 'Version compatibility',
  authentication: 'Signed in',
  skills: 'Skills'
}

type PanelState =
  | { phase: 'loading' }
  | { phase: 'failed' }
  | { phase: 'ready'; snapshot: ReadinessSnapshot; busy: BusyAction | null }

type BusyAction =
  | { kind: 'refresh-all' }
  | { kind: 'refresh-harness'; harness: HarnessId }
  | { kind: 'choose-executable'; harness: HarnessId }
  | { kind: 'clear-executable'; harness: HarnessId }
  | { kind: 'login-shell' }

export function useReadiness(): {
  state: PanelState
  reload: () => void
  run: (action: BusyAction, work: () => Promise<ReadinessSnapshot | null>) => void
} {
  const [state, setState] = useState<PanelState>({ phase: 'loading' })

  const load = useCallback(() => {
    window.shell.getReadiness().then(
      (snapshot) => setState({ phase: 'ready', snapshot, busy: null }),
      () => setState({ phase: 'failed' })
    )
  }, [])

  useEffect(load, [load])

  const reload = useCallback(() => {
    setState({ phase: 'loading' })
    load()
  }, [load])

  const run = useCallback((action: BusyAction, work: () => Promise<ReadinessSnapshot | null>) => {
    setState((current) => (current.phase === 'ready' ? { ...current, busy: action } : current))
    work().then(
      (snapshot) =>
        setState((current) => {
          if (current.phase !== 'ready') return current
          return { phase: 'ready', snapshot: snapshot ?? current.snapshot, busy: null }
        }),
      () => setState({ phase: 'failed' })
    )
  }, [])

  return { state, reload, run }
}

interface ReadinessPanelProps {
  /** Compact spacing for embedding inside a dialog. */
  className?: string
  /** Called with every snapshot the panel receives, including re-checks. */
  onSnapshot?: (snapshot: ReadinessSnapshot) => void
}

export function ReadinessPanel({ className, onSnapshot }: ReadinessPanelProps): React.JSX.Element {
  const { state, reload, run } = useReadiness()
  const snapshotListenerRef = useRef(onSnapshot)
  snapshotListenerRef.current = onSnapshot
  const latestSnapshot = state.phase === 'ready' ? state.snapshot : null

  useEffect(() => {
    if (latestSnapshot) snapshotListenerRef.current?.(latestSnapshot)
  }, [latestSnapshot])

  if (state.phase === 'loading') {
    return (
      <div role="status" aria-live="polite" className={cn('p-4 text-muted-foreground', className)}>
        Checking Harness readiness…
      </div>
    )
  }

  if (state.phase === 'failed') {
    return (
      <div role="alert" className={cn('flex flex-col items-start gap-2 p-4', className)}>
        <p>Harness readiness could not be checked.</p>
        <Button variant="secondary" size="sm" onClick={reload}>
          Try again
        </Button>
      </div>
    )
  }

  const { snapshot, busy } = state

  return (
    <div className={cn('flex flex-col gap-3', className)} aria-busy={busy !== null}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Codex and Claude are checked independently. This app never installs, updates, signs in, or
          stores credentials for a Harness — repairs happen in your own terminal.
        </p>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy !== null}
          onClick={() => run({ kind: 'refresh-all' }, () => window.shell.refreshReadiness())}
        >
          <RefreshCw
            aria-hidden="true"
            className={cn('size-3.5', busy?.kind === 'refresh-all' && 'animate-spin')}
          />
          Check again
        </Button>
      </div>

      {snapshot.harnesses.map((harness) => (
        <HarnessCard key={harness.harness} harness={harness} busy={busy} run={run} />
      ))}

      <LoginShellConsent snapshot={snapshot} busy={busy} run={run} />
    </div>
  )
}

function HarnessCard({
  harness,
  busy,
  run
}: {
  harness: HarnessReadiness
  busy: BusyAction | null
  run: (action: BusyAction, work: () => Promise<ReadinessSnapshot | null>) => void
}): React.JSX.Element {
  const id = harness.harness
  const refreshing = busy?.kind === 'refresh-harness' && busy.harness === id

  return (
    <section
      aria-label={`${harness.displayName} readiness`}
      className="rounded-md border border-border bg-surface"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h3 className="text-[13px] font-semibold">{harness.displayName}</h3>
        <span
          className={cn(
            'rounded-full border px-1.5 py-0.5 text-[11px]',
            harness.available
              ? 'border-positive/40 text-positive'
              : 'border-border text-muted-foreground'
          )}
        >
          {harness.available ? 'Usable' : 'Not usable yet'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            aria-label={`Check ${harness.displayName} again`}
            onClick={() =>
              run({ kind: 'refresh-harness', harness: id }, () => window.shell.refreshReadiness(id))
            }
          >
            <RefreshCw
              aria-hidden="true"
              className={cn('size-3.5', refreshing && 'animate-spin')}
            />
            Check again
          </Button>
        </div>
      </header>

      {/* Being usable and being something this app can drive are two
          different questions, and a card that answers only the first leaves
          "Usable" sitting above a Harness no Session can use. */}
      <p
        className={cn(
          'border-b border-border px-3 py-2 text-xs',
          harness.capabilities.developSession.available
            ? 'text-muted-foreground'
            : 'text-foreground'
        )}
      >
        {harness.capabilities.developSession.summary}
      </p>

      <div className="flex flex-col gap-1 px-3 py-2">
        <p className="text-xs text-muted-foreground">
          Command <code className="select-text">{harness.command}</code>
          {harness.version && <> · version {harness.version}</>}
          {harness.executableSource === 'explicit' && <> · chosen by you</>}
        </p>
        {harness.executablePath ? (
          <p className="font-mono text-xs break-all text-muted-foreground select-text">
            {harness.executablePath}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">No executable resolved yet.</p>
        )}
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              run({ kind: 'choose-executable', harness: id }, async () => {
                const result = await window.shell.chooseHarnessExecutable(id)
                return result.canceled ? null : result.snapshot
              })
            }
          >
            Choose executable…
          </Button>
          {harness.executableSource === 'explicit' && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                run({ kind: 'clear-executable', harness: id }, () =>
                  window.shell.clearHarnessExecutable(id)
                )
              }
            >
              Use PATH instead
            </Button>
          )}
        </div>
      </div>

      <ul
        className="flex flex-col border-t border-border"
        aria-label={`${harness.displayName} checks`}
      >
        {harness.checks.map((check) => (
          <CheckRow key={check.dimension} check={check} />
        ))}
      </ul>
    </section>
  )
}

function CheckRow({ check }: { check: ReadinessCheck }): React.JSX.Element {
  // A dimension that cannot block anything is not reported as though it had.
  // Skills are the only one today: missing them is worth saying and is not a
  // fault, so the row states what is installed rather than raising an alarm
  // beside a Harness that works.
  const informational = !isGating(check.dimension)
  const icon =
    check.status === 'ready' ? (
      <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-positive" />
    ) : informational ? (
      <Info aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
    ) : check.status === 'warning' ? (
      <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 text-notice-foreground" />
    ) : check.status === 'failed' ? (
      <XCircle aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />
    ) : (
      <Minus aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
    )
  const statusLabel = informational
    ? check.status === 'ready'
      ? 'Installed'
      : 'Not installed'
    : check.status === 'ready'
      ? 'Ready'
      : check.status === 'warning'
        ? 'Usable with a warning'
        : check.status === 'failed'
          ? 'Not ready'
          : 'Not checked'

  return (
    <li className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-xs font-medium">{DIMENSION_LABELS[check.dimension]}</span>
        <span className="sr-only">{statusLabel}.</span>
        <span className="ml-auto text-[11px] text-muted-foreground">{statusLabel}</span>
      </div>
      <p className="pl-5.5 text-xs leading-relaxed text-muted-foreground">{check.summary}</p>
      {check.command && check.status !== 'ready' && <CopyableCommand command={check.command} />}
      {check.links.length > 0 && check.status !== 'ready' && (
        <p className="pl-5.5 text-xs text-muted-foreground">
          {check.links.map((link, index) => (
            <span key={link.url}>
              {index > 0 && ' · '}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => void window.shell.openExternalLink(link.url)}
              >
                {link.label}
              </button>
            </span>
          ))}
        </p>
      )}
    </li>
  )
}

function CopyableCommand({ command }: { command: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard may be unavailable; the command stays selectable below.
    }
  }

  return (
    <div className="ml-5.5 flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-1">
      <code className="flex-1 font-mono text-xs break-all select-text">{command}</code>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Copy command: ${command}`}
        onClick={() => void copy()}
      >
        {copied ? (
          <Check aria-hidden="true" className="size-3.5 text-positive" />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" />
        )}
      </Button>
    </div>
  )
}

function LoginShellConsent({
  snapshot,
  busy,
  run
}: {
  snapshot: ReadinessSnapshot
  busy: BusyAction | null
  run: (action: BusyAction, work: () => Promise<ReadinessSnapshot | null>) => void
}): React.JSX.Element {
  return (
    <section
      aria-label="Login-shell discovery"
      className="rounded-md border border-border bg-muted/40 px-3 py-2"
    >
      <h3 className="text-xs font-medium">Deeper discovery through your login shell</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        If a Harness is installed through a version manager, the app can ask your login shell for
        its PATH. That runs your shell startup files (such as ~/.zshrc) once per check, for up to
        five seconds. Nothing else is read or changed, and you can turn it off at any time.
      </p>
      <div className="mt-2">
        {snapshot.loginShellConsent ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              run({ kind: 'login-shell' }, () => window.shell.setLoginShellDiscovery(false))
            }
          >
            Revoke login-shell discovery
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              run({ kind: 'login-shell' }, () => window.shell.setLoginShellDiscovery(true))
            }
          >
            Allow login-shell discovery
          </Button>
        )}
      </div>
    </section>
  )
}

interface ReadinessDialogProps {
  onClose: () => void
}

/** The Harnesses surface reached from Settings and before a Run. */
export function ReadinessDialog({ onClose }: ReadinessDialogProps): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/60 p-6"
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="readiness-dialog-title"
        className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg"
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <h2 id="readiness-dialog-title" className="text-[13px] font-semibold">
            Harnesses
          </h2>
          <Button
            ref={closeRef}
            variant="ghost"
            size="icon"
            aria-label="Close Harnesses"
            className="ml-auto"
            onClick={onClose}
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </header>
        <div className="overflow-y-auto p-4">
          <ReadinessPanel />
        </div>
      </div>
    </div>
  )
}
