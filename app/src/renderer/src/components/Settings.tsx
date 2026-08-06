import { useEffect, useState } from 'react'
import type { ThemePreference, ThemeState } from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { Modal } from '@renderer/components/ui/dialog'
import { cn } from '@renderer/lib/utils'

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

export function SettingsDialog({
  theme,
  onThemeChange,
  onDismiss
}: {
  theme: ThemeState | null
  onThemeChange: (preference: ThemePreference) => void
  onDismiss: () => void
}): React.JSX.Element {
  const [warnBeforeQuit, setWarnBeforeQuit] = useState<boolean | null>(null)

  useEffect(() => {
    void window.shell.getQuitWarningPreference().then(setWarnBeforeQuit)
  }, [])

  function changeQuitWarning(enabled: boolean): void {
    setWarnBeforeQuit(enabled)
    void window.shell.setQuitWarningPreference(enabled).catch(() => setWarnBeforeQuit(!enabled))
  }

  return (
    <Modal labelledBy="settings-title" onDismiss={onDismiss} className="max-w-md">
      <h2 id="settings-title" className="text-sm font-medium">
        Settings
      </h2>
      <section className="mt-4" aria-labelledby="appearance-settings-title">
        <h3 id="appearance-settings-title" className="text-xs font-medium">
          Appearance
        </h3>
        <div
          role="group"
          aria-label="Theme"
          className="mt-2 inline-flex gap-0.5 rounded-md border border-border p-0.5"
        >
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={(theme?.preference ?? 'system') === option.value}
              onClick={() => onThemeChange(option.value)}
              className={cn(
                'rounded px-2 py-0.5 text-2xs transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                (theme?.preference ?? 'system') === option.value
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>
      <section className="mt-4 border-t border-border pt-4" aria-labelledby="quit-settings-title">
        <h3 id="quit-settings-title" className="text-xs font-medium">
          Quitting
        </h3>
        <label className="mt-2 flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            className="mt-0.5 accent-primary"
            checked={warnBeforeQuit ?? true}
            disabled={warnBeforeQuit === null}
            onChange={(event) => changeQuitWarning(event.currentTarget.checked)}
          />
          <span>
            Warn before quitting with active agents
            <span className="mt-1 block leading-relaxed text-muted-foreground">
              Argos safely stops active processes on exit whether this warning is on or off.
            </span>
          </span>
        </label>
      </section>
      <div className="mt-4 flex justify-end">
        <Button data-autofocus="" size="sm" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </Modal>
  )
}
