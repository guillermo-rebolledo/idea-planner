import { useCallback, useEffect, useState } from 'react'
import type { BootState, LibrarySnapshot, ThemeState } from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { Onboarding } from '@renderer/components/Onboarding'
import { Mailbox } from '@renderer/components/Mailbox'

type BootPhase =
  { phase: 'loading' } | { phase: 'failed'; message: string } | { phase: 'ready'; boot: BootState }

export default function App(): React.JSX.Element {
  const [bootPhase, setBootPhase] = useState<BootPhase>({ phase: 'loading' })
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null)
  const [theme, setTheme] = useState<ThemeState | null>(null)

  const adoptTheme = useCallback((next: ThemeState) => {
    document.documentElement.classList.toggle('dark', next.resolved === 'dark')
    setTheme(next)
  }, [])

  const loadBootState = useCallback(async () => {
    setBootPhase({ phase: 'loading' })
    try {
      const boot = await window.ideaShell.getBootState()
      adoptTheme(boot.theme)
      setLibrary(boot.library)
      setBootPhase({ phase: 'ready', boot })
    } catch {
      setBootPhase({ phase: 'failed', message: 'The app could not read its startup state.' })
    }
  }, [adoptTheme])

  useEffect(() => {
    void loadBootState()
    return window.ideaShell.onThemeChanged(adoptTheme)
  }, [loadBootState, adoptTheme])

  const changeThemePreference = useCallback(
    async (preference: ThemeState['preference']) => {
      adoptTheme(await window.ideaShell.setThemePreference(preference))
    },
    [adoptTheme]
  )

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
