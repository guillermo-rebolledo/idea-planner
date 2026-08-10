import { useEffect, useState, type ComponentType } from 'react'
import { Bot, Palette, Settings2, X } from 'lucide-react'
import type {
  AppearanceSettings,
  ReadinessSnapshot,
  ThemeState,
  UpdateAvailability
} from '@shared/contract'
import { AppearanceSettingsPanel } from '@renderer/components/AppearanceSettings'
import { ReadinessPanel } from '@renderer/components/Readiness'
import { Button } from '@renderer/components/ui/button'
import { Modal } from '@renderer/components/ui/dialog'
import { cn } from '@renderer/lib/utils'

export type SettingsSection = 'general' | 'harnesses' | 'appearance'

interface SectionDetails {
  id: SettingsSection
  label: string
  description: string
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
}

const SECTION_BY_ID = {
  general: {
    id: 'general',
    label: 'General',
    description: 'Everyday application behavior.',
    icon: Settings2
  },
  harnesses: {
    id: 'harnesses',
    label: 'Harnesses',
    description: 'See what can run a Session and what needs attention.',
    icon: Bot
  },
  appearance: {
    id: 'appearance',
    label: 'Appearance',
    description: 'Choose a preset or make Argos yours.',
    icon: Palette
  }
} as const satisfies Record<SettingsSection, SectionDetails>

const SECTIONS: readonly SectionDetails[] = Object.values(SECTION_BY_ID)

export function SettingsDialog({
  theme,
  initialSection = 'general',
  onAppearanceChange,
  onDismiss
}: {
  theme: ThemeState | null
  initialSection?: SettingsSection
  onAppearanceChange: (appearance: AppearanceSettings) => Promise<void>
  onDismiss: () => void
}): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [warnBeforeQuit, setWarnBeforeQuit] = useState<boolean | null>(null)
  const [readiness, setReadiness] = useState<ReadinessSnapshot | null>(null)
  const [appearance, setAppearance] = useState<AppearanceSettings | null>(null)
  const [customDraft, setCustomDraft] = useState<AppearanceSettings['custom'] | null>(null)
  const [appearanceError, setAppearanceError] = useState(false)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateAvailability | null>(null)
  const activeSection = SECTION_BY_ID[section]

  useEffect(() => {
    void window.shell
      .getQuitWarningPreference()
      .then(setWarnBeforeQuit, () => setWarnBeforeQuit(true))
    void window.shell.getReadiness().then(setReadiness, () => undefined)
    void window.shell.getBootState().then(
      (boot) => setAppVersion(boot.appVersion),
      () => undefined
    )
    // Whether the version above is still the newest one. Nothing here waits on
    // it, and a check that never landed leaves About saying exactly what it
    // said before there was one.
    void window.shell.getUpdate().then(setUpdate, () => undefined)
    void window.shell.getAppearanceSettings().then(
      (savedAppearance) => {
        setAppearance(savedAppearance)
        setCustomDraft(savedAppearance.custom)
      },
      () => setAppearanceError(true)
    )
  }, [])

  function changeQuitWarning(enabled: boolean): void {
    setWarnBeforeQuit(enabled)
    void window.shell.setQuitWarningPreference(enabled).catch(() => setWarnBeforeQuit(!enabled))
  }

  async function applyAppearance(next: AppearanceSettings): Promise<void> {
    const previous = appearance
    setAppearance(next)
    setAppearanceError(false)
    try {
      await onAppearanceChange(next)
    } catch {
      setAppearance(previous)
      setAppearanceError(true)
      throw new Error('Appearance could not be saved')
    }
  }

  return (
    <Modal
      labelledBy="settings-title"
      onDismiss={onDismiss}
      className="settings-dialog overflow-hidden p-0"
    >
      <div className="settings-dialog-layout grid h-full">
        <aside className="flex min-h-0 flex-col bg-background/55 p-3">
          <div className="flex h-11 items-center gap-2 px-2">
            <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Settings2 aria-hidden="true" className="size-3.5" />
            </span>
            <div>
              <h1 id="settings-title" className="text-sm font-semibold">
                Settings
              </h1>
              <p className="text-2xs text-muted-foreground">Argos preferences</p>
            </div>
          </div>

          <nav className="mt-4 space-y-1" aria-label="Settings sections">
            {SECTIONS.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  data-autofocus={item.id === initialSection ? '' : undefined}
                  aria-current={section === item.id ? 'page' : undefined}
                  onClick={() => setSection(item.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                    section === item.id
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  <Icon aria-hidden="true" className="size-3.5" />
                  {item.label}
                  {item.id === 'harnesses' && readiness ? (
                    <span className="ml-auto flex gap-1">
                      {readiness.harnesses.map((harness) => (
                        <span
                          key={harness.harness}
                          role="img"
                          aria-label={`${harness.displayName}: ${
                            harness.capabilities.developSession.available ? 'ready' : 'needs you'
                          }`}
                          className={cn(
                            'size-1.5 rounded-full',
                            harness.capabilities.developSession.available
                              ? 'bg-positive'
                              : 'bg-status-blocked'
                          )}
                        />
                      ))}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </nav>

          <div className="mt-auto px-2 pt-3">
            <p className="text-2xs text-muted-foreground">
              Argos{appVersion ? ` ${appVersion}` : ''}
            </p>
            <p className="mt-0.5 text-2xs text-muted-foreground">Settings stay on this Mac.</p>
          </div>
        </aside>

        <div className="flex min-w-0 flex-col overflow-hidden">
          <header className="flex h-16 shrink-0 items-center justify-between border-b border-border px-6">
            <div>
              <h2 className="text-sm font-semibold">{activeSection.label}</h2>
              <p className="mt-0.5 text-2xs text-muted-foreground">{activeSection.description}</p>
            </div>
            <Button variant="ghost" size="icon" aria-label="Close Settings" onClick={onDismiss}>
              <X aria-hidden="true" className="size-4" />
            </Button>
          </header>

          {section === 'general' ? (
            <GeneralSettings
              warnBeforeQuit={warnBeforeQuit}
              appVersion={appVersion}
              update={update}
              onWarnBeforeQuit={changeQuitWarning}
            />
          ) : section === 'harnesses' ? (
            <div className="flex-1 overflow-y-auto p-6">
              <ReadinessPanel
                className="mx-auto max-w-3xl"
                onSnapshot={(snapshot) => setReadiness(snapshot)}
              />
            </div>
          ) : (
            <AppearanceSettingsPanel
              theme={theme}
              appearance={appearance}
              customDraft={customDraft}
              error={appearanceError}
              onCustomDraft={setCustomDraft}
              onApply={applyAppearance}
              onCancel={() => setCustomDraft(appearance?.custom ?? null)}
            />
          )}
        </div>
      </div>
    </Modal>
  )
}

function GeneralSettings({
  warnBeforeQuit,
  appVersion,
  update,
  onWarnBeforeQuit
}: {
  warnBeforeQuit: boolean | null
  appVersion: string | null
  update: UpdateAvailability | null
  onWarnBeforeQuit: (enabled: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl">
        <section aria-labelledby="quitting-title">
          <h3 id="quitting-title" className="text-xs font-medium">
            Quitting
          </h3>
          <div className="mt-3 rounded-lg border border-border bg-surface">
            <label className="flex cursor-pointer items-start gap-3 p-4 text-xs">
              <input
                type="checkbox"
                className="mt-0.5 accent-primary"
                checked={warnBeforeQuit ?? true}
                disabled={warnBeforeQuit === null}
                onChange={(event) => onWarnBeforeQuit(event.currentTarget.checked)}
              />
              <span className="font-medium">
                Warn before quitting with active agents
                <span className="mt-1 block max-w-xl leading-relaxed text-muted-foreground">
                  Argos safely stops active processes on exit whether this warning is on or off.
                </span>
              </span>
            </label>
          </div>
        </section>

        <section className="mt-7" aria-labelledby="about-title">
          <h3 id="about-title" className="text-xs font-medium">
            About
          </h3>
          <dl className="mt-3 rounded-lg border border-border bg-surface text-xs">
            <Fact label="Application" value={`Argos${appVersion ? ` ${appVersion}` : ''}`} />
            <Fact label="Application data" value="Stored locally on this Mac" />
          </dl>

          {/*
            Only ever shown when there is something to say. A check that failed,
            or found nothing, leaves About exactly the length it was: nobody
            needs a line telling them their app is not out of date, and nobody
            opened a coding app to be told about their network.
          */}
          {update?.available ? (
            <div className="mt-3 flex items-start justify-between gap-6 rounded-lg border border-border bg-surface p-4 text-xs">
              <p className="font-medium">
                Argos {update.available.version} is available
                <span className="mt-1 block max-w-xl leading-relaxed font-normal text-muted-foreground">
                  Opens the release in your browser, where you install it yourself. Argos never
                  downloads or replaces itself while you are working.
                </span>
              </p>
              <Button
                variant="secondary"
                className="shrink-0"
                onClick={() => void window.shell.openUpdate()}
              >
                Get the update
              </Button>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <dt>{label}</dt>
      <dd className="text-muted-foreground">{value}</dd>
    </div>
  )
}
