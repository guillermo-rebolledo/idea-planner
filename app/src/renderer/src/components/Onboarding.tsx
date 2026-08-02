import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { LibrarySnapshot, ReadinessSnapshot } from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { ReadinessPanel } from '@renderer/components/Readiness'

interface OnboardingProps {
  onComplete: (library: LibrarySnapshot) => void
}

/**
 * First launch. Step one chooses or creates the library through the native
 * picker; nothing is written until it is confirmed. Step two checks Harness
 * readiness and is entirely optional: capture-only mode is a normal state,
 * never an error, and needs no Harness.
 */
export function Onboarding({ onComplete }: OnboardingProps): React.JSX.Element {
  const [chosenPath, setChosenPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null)
  const [readiness, setReadiness] = useState<ReadinessSnapshot | null>(null)

  async function chooseLocation(): Promise<void> {
    setError(null)
    const result = await window.shell.chooseLibraryLocation()
    if (!result.canceled) setChosenPath(result.path)
  }

  async function confirmLocation(): Promise<void> {
    if (!chosenPath) return
    setBusy(true)
    setError(null)
    try {
      setLibrary(await window.shell.openLibrary(chosenPath))
    } catch {
      setError('That folder could not be opened as a library. Choose another location.')
    } finally {
      setBusy(false)
    }
  }

  if (library) {
    return (
      <div className="flex h-full flex-col">
        <header className="app-drag-region h-11 shrink-0" aria-hidden="true" />
        <main className="flex min-h-0 flex-1 justify-center overflow-y-auto p-8">
          <section className="w-full max-w-xl" aria-labelledby="readiness-title">
            <h1 id="readiness-title" className="text-lg font-semibold">
              Check Harness readiness
            </h1>
            <p className="mt-2 leading-relaxed text-muted-foreground">
              This step is optional. You can capture, organize, and edit Sessions without any
              Harness, and check readiness again later in Settings.
            </p>
            <div className="mt-6">
              <ReadinessPanel onSnapshot={setReadiness} />
            </div>
            <div className="mt-6 flex justify-end">
              <Button onClick={() => onComplete(library)}>
                {readiness?.harnesses.some((harness) => harness.available)
                  ? 'Continue'
                  : 'Continue with capture only'}
              </Button>
            </div>
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag-region h-11 shrink-0" aria-hidden="true" />
      <main className="flex flex-1 items-center justify-center p-8">
        <section className="w-full max-w-md" aria-labelledby="onboarding-title">
          <h1 id="onboarding-title" className="text-lg font-semibold">
            Choose your library
          </h1>
          <p className="mt-2 leading-relaxed text-muted-foreground">
            Sessions are saved as ordinary Markdown folders in one location you choose. You can
            open, edit, and back them up with any other tool.
          </p>

          <div className="mt-6 space-y-3">
            <Button variant="secondary" onClick={() => void chooseLocation()} disabled={busy}>
              <FolderOpen aria-hidden="true" className="size-3.5" />
              Choose or create a folder…
            </Button>

            {chosenPath && (
              <div className="rounded-md border border-border bg-surface p-3">
                <p className="text-xs text-muted-foreground">
                  Your Sessions will be saved exactly here:
                </p>
                <p className="mt-1 font-mono text-xs break-all select-text">{chosenPath}</p>
                <div className="mt-3 flex gap-2">
                  <Button onClick={() => void confirmLocation()} disabled={busy}>
                    {busy ? 'Opening…' : 'Use this library'}
                  </Button>
                  <Button variant="ghost" onClick={() => setChosenPath(null)} disabled={busy}>
                    Change
                  </Button>
                </div>
              </div>
            )}

            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
