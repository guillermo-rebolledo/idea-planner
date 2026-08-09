import { useCallback, useEffect, useState } from 'react'
import {
  bootStateSchema,
  harnessesReadyForASession,
  type BootState,
  type AppearanceSettings,
  type ProjectView,
  type ReadinessSnapshot,
  type ThemeState
} from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { LaunchGate } from '@renderer/components/LaunchGate'
import { Onboarding } from '@renderer/components/Onboarding'
import { Mailbox } from '@renderer/components/Mailbox'
import { QuitWarning } from '@renderer/components/QuitWarning'

type BootPhase =
  | { phase: 'loading' }
  | { phase: 'failed'; message: string }
  /** The half of the app on the other side of the wire is a different build. */
  | { phase: 'mismatched' }
  | { phase: 'ready'; boot: BootState }

export default function App(): React.JSX.Element {
  const [bootPhase, setBootPhase] = useState<BootPhase>({ phase: 'loading' })
  // Onboarding is over once the app has somewhere to work: a Project.
  const [projects, setProjects] = useState<ProjectView[]>([])
  const [readiness, setReadiness] = useState<ReadinessSnapshot | null>(null)
  const [theme, setTheme] = useState<ThemeState | null>(null)

  const adoptTheme = useCallback((next: ThemeState) => {
    // Custom palettes use fixed semantic seeds in addition to the person's
    // neutral and brand colors, so status meaning survives every canvas.
    document.documentElement.dataset['theme'] = next.resolved
    const style = document.documentElement.style
    for (const [property, value] of Object.entries({
      '--background': next.palette?.background,
      '--surface': next.palette?.surface,
      '--surface-raised': next.palette?.surfaceRaised,
      '--muted': next.palette?.muted,
      '--border': next.palette?.border,
      '--foreground': next.palette?.foreground,
      '--muted-foreground': next.palette?.mutedForeground,
      '--accent': next.palette?.accent,
      '--accent-foreground': next.palette?.accentForeground,
      '--primary': next.palette?.primary,
      '--primary-hover': next.palette?.primaryHover,
      '--primary-foreground': next.palette?.primaryForeground,
      '--ring': next.palette?.ring,
      '--positive': next.palette?.positive,
      '--destructive': next.palette?.destructive,
      '--destructive-hover': next.palette?.destructiveHover,
      '--destructive-foreground': next.palette?.destructiveForeground,
      '--notice': next.palette?.notice,
      '--notice-border': next.palette?.noticeBorder,
      '--notice-foreground': next.palette?.noticeForeground,
      '--diff-added-foreground': next.palette?.diffAddedForeground,
      '--diff-added-surface': next.palette?.diffAddedSurface,
      '--diff-removed-foreground': next.palette?.diffRemovedForeground,
      '--diff-removed-surface': next.palette?.diffRemovedSurface,
      '--status-running': next.palette?.statusRunning,
      '--status-blocked': next.palette?.statusBlocked,
      '--status-blocked-surface': next.palette?.statusBlockedSurface,
      '--status-blocked-border': next.palette?.statusBlockedBorder,
      '--status-idle': next.palette?.statusIdle,
      '--status-failed': next.palette?.statusFailed
    })) {
      if (value === undefined) style.removeProperty(property)
      else style.setProperty(property, value)
    }
    setTheme(next)
  }, [])

  const loadBootState = useCallback(async () => {
    setBootPhase({ phase: 'loading' })
    try {
      // Read against this build's own contract before anything is acted on.
      // Two halves of different builds otherwise agree right up until one of
      // them is handed a shape it was never written for, and the way that
      // ends is a screen that goes black without a word.
      const parsed = bootStateSchema.safeParse(await window.shell.getBootState())
      if (!parsed.success) {
        setBootPhase({ phase: 'mismatched' })
        return
      }
      const boot = parsed.data
      adoptTheme(boot.theme)
      setProjects(await window.shell.listProjects())
      // Whether this machine can do the thing the app is for, asked on every
      // launch rather than remembered: a Harness is installed, updated, and
      // signed out by the person, none of which this app is told about.
      setReadiness(await window.shell.getReadiness())
      setBootPhase({ phase: 'ready', boot })
    } catch {
      setBootPhase({ phase: 'failed', message: 'The app could not read its startup state.' })
    }
  }, [adoptTheme])

  useEffect(() => {
    void loadBootState()
    return window.shell.onThemeChanged(adoptTheme)
  }, [loadBootState, adoptTheme])

  const changeAppearance = useCallback(
    async (appearance: AppearanceSettings) => {
      adoptTheme(await window.shell.setAppearanceSettings(appearance))
    },
    [adoptTheme]
  )

  let content: React.JSX.Element
  if (bootPhase.phase === 'loading') {
    content = (
      <div className="flex h-full items-center justify-center" role="status" aria-live="polite">
        <p className="text-muted-foreground">Starting up…</p>
      </div>
    )
  } else if (bootPhase.phase === 'mismatched') {
    content = (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8" role="alert">
        <p className="text-foreground">This window and the app behind it are different builds.</p>
        <p className="max-w-md text-center text-xs text-muted-foreground">
          Nothing is wrong with your Projects or Sessions. It happens while developing: the window
          reloads on save and the app behind it does not. Quit and start it again.
        </p>
      </div>
    )
  } else if (bootPhase.phase === 'failed') {
    content = (
      <div className="flex h-full flex-col items-center justify-center gap-3" role="alert">
        <p className="text-foreground">{bootPhase.message}</p>
        <Button variant="secondary" onClick={() => void loadBootState()}>
          Try again
        </Button>
      </div>
    )
  } else if (readiness !== null && harnessesReadyForASession(readiness).length === 0) {
    // The gate comes before everything else, including onboarding: adding a
    // Project is the second question, and asking it first would walk somebody
    // through setup for an app that cannot do anything at the end of it.
    content = <LaunchGate snapshot={readiness} onContinue={setReadiness} />
  } else if (projects.length === 0) {
    content = <Onboarding onComplete={setProjects} />
  } else {
    content = <Mailbox theme={theme} onAppearanceChange={changeAppearance} />
  }

  return (
    <>
      {content}
      <QuitWarning />
    </>
  )
}
