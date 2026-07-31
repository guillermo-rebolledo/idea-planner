import { useCallback, useEffect, useState } from 'react'
import type { BootState, LibrarySnapshot, ThemeState } from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { Onboarding } from '@renderer/components/Onboarding'
import { Mailbox } from '@renderer/components/Mailbox'

type BootPhase =
  | { phase: 'loading' }
  | { phase: 'failed'; message: string }
  | { phase: 'ready'; boot: BootState }

function applyResolvedTheme(theme: ThemeState): void {
  document.documentElement.classList.toggle('dark', theme.resolved === 'dark')
}

export default function App(): React.JSX.Element {
  const [bootPhase, setBootPhase] = useState<BootPhase>({ phase: 'loading' })
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null)
  const [theme, setTheme] = useState<ThemeState | null>(null)

  const loadBootState = useCallback(async () => {
    setBootPhase({ phase: 'loading' })
    try {
      const boot = await window.ideaShell.getBootState()
      applyResolvedTheme(boot.theme)
      setTheme(boot.theme)
      setLibrary(boot.library)
      setBootPhase({ phase: 'ready', boot })
    } catch {
      setBootPhase({ phase: 'failed', message: 'The app could not read its startup state.' })
    }
  }, [])

  useEffect(() => {
    void loadBootState()
    return window.ideaShell.onThemeChanged((next) => {
      applyResolvedTheme(next)
      setTheme(next)
    })
  }, [loadBootState])

  const changeThemePreference = useCallback(async (preference: ThemeState['preference']) => {
    const next = await window.ideaShell.setThemePreference(preference)
    applyResolvedTheme(next)
    setTheme(next)
  }, [])

  if (bootPhase.phase === 'loading') {
    return (
      <div className="flex h-full items-center justify-center" role="status" aria-live="polite">
        <p className="text-muted-foreground">Opening your Idea Library…</p>
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

  if (!library) {
    return <Onboarding onLibraryOpened={setLibrary} />
  }

  return (
    <Mailbox
      library={library}
      onLibraryChanged={setLibrary}
      theme={theme}
      onThemePreferenceChange={(preference) => void changeThemePreference(preference)}
    />
  )
}
