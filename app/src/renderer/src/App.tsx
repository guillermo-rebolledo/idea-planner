import { useCallback, useEffect, useState } from 'react'
import {
  harnessesReadyForASession,
  type BootState,
  type ProjectView,
  type ReadinessSnapshot,
  type ThemeState
} from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { LaunchGate } from '@renderer/components/LaunchGate'
import { Onboarding } from '@renderer/components/Onboarding'
import { Mailbox } from '@renderer/components/Mailbox'

type BootPhase =
  { phase: 'loading' } | { phase: 'failed'; message: string } | { phase: 'ready'; boot: BootState }

export default function App(): React.JSX.Element {
  const [bootPhase, setBootPhase] = useState<BootPhase>({ phase: 'loading' })
  // Onboarding is over once the app has somewhere to work: a Project.
  const [projects, setProjects] = useState<ProjectView[]>([])
  const [readiness, setReadiness] = useState<ReadinessSnapshot | null>(null)
  const [theme, setTheme] = useState<ThemeState | null>(null)

  const adoptTheme = useCallback((next: ThemeState) => {
    document.documentElement.classList.toggle('dark', next.resolved === 'dark')
    setTheme(next)
  }, [])

  const loadBootState = useCallback(async () => {
    setBootPhase({ phase: 'loading' })
    try {
      const boot = await window.shell.getBootState()
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

  const changeThemePreference = useCallback(
    async (preference: ThemeState['preference']) => {
      adoptTheme(await window.shell.setThemePreference(preference))
    },
    [adoptTheme]
  )

  if (bootPhase.phase === 'loading') {
    return (
      <div className="flex h-full items-center justify-center" role="status" aria-live="polite">
        <p className="text-muted-foreground">Starting up…</p>
      </div>
    )
  }

  if (bootPhase.phase === 'failed') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3" role="alert">
        <p className="text-foreground">{bootPhase.message}</p>
        <Button variant="secondary" onClick={() => void loadBootState()}>
          Try again
        </Button>
      </div>
    )
  }

  // The gate comes before everything else, including onboarding: adding a
  // Project is the second question, and asking it first would walk somebody
  // through setup for an app that cannot do anything at the end of it.
  if (readiness !== null && harnessesReadyForASession(readiness).length === 0) {
    return <LaunchGate snapshot={readiness} onContinue={setReadiness} />
  }

  if (projects.length === 0) {
    return <Onboarding onComplete={setProjects} />
  }

  return (
    <Mailbox
      theme={theme}
      onThemePreferenceChange={(preference) => void changeThemePreference(preference)}
    />
  )
}
