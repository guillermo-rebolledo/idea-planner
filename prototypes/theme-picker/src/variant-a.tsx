import { useState } from 'react'
import {
  Bot,
  Check,
  CheckCircle2,
  CircleAlert,
  Info,
  Palette,
  RefreshCw,
  Settings2,
  X
} from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import {
  Button,
  ColorField,
  CustomCard,
  DialogFrame,
  MiniPreview,
  PresetButton,
  SchemeControl
} from './parts'
import { PRESETS, isDirty, type VariantProps } from './theme'

type SettingsSection = 'general' | 'harnesses' | 'appearance'

const SECTIONS: {
  id: SettingsSection
  label: string
  icon: typeof Settings2
}[] = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'harnesses', label: 'Harnesses', icon: Bot },
  { id: 'appearance', label: 'Appearance', icon: Palette }
]

export function VariantA(props: VariantProps): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>('appearance')
  const [warnBeforeQuit, setWarnBeforeQuit] = useState(true)
  const [loginShellDiscovery, setLoginShellDiscovery] = useState(false)
  const [checking, setChecking] = useState(false)

  function checkAgain(): void {
    setChecking(true)
    window.setTimeout(() => setChecking(false), 700)
  }

  return (
    <DialogFrame
      width="max-w-[1180px]"
      className="h-[calc(100vh-96px)] max-h-[700px] min-h-[620px]"
    >
      <div className="grid h-full grid-cols-[210px_minmax(0,1fr)]">
        <aside className="flex flex-col bg-background/55 p-3">
          <div className="flex h-11 items-center gap-2 px-2">
            <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Settings2 className="size-3.5" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-sm font-semibold">Settings</h1>
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
                  aria-current={section === item.id ? 'page' : undefined}
                  onClick={() => setSection(item.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition',
                    section === item.id
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  {item.label}
                  {item.id === 'harnesses' ? (
                    <span className="ml-auto flex gap-1" aria-label="One Harness needs attention">
                      <span className="size-1.5 rounded-full bg-positive" />
                      <span className="size-1.5 rounded-full bg-status-blocked" />
                    </span>
                  ) : null}
                </button>
              )
            })}
          </nav>

          <div className="mt-auto px-2 pt-3">
            <p className="text-2xs text-muted-foreground">Argos 0.1.0</p>
            <p className="mt-0.5 text-2xs text-muted-foreground">Settings stay on this Mac.</p>
          </div>
        </aside>

        <div className="flex min-w-0 flex-col overflow-hidden">
          <header className="flex h-16 shrink-0 items-center justify-between border-b border-border px-6">
            <div>
              <h2 className="text-sm font-semibold">{titleFor(section)}</h2>
              <p className="mt-0.5 text-2xs text-muted-foreground">{descriptionFor(section)}</p>
            </div>
            <button
              type="button"
              className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Close settings"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </header>

          {section === 'general' ? (
            <GeneralSettings warnBeforeQuit={warnBeforeQuit} onWarnBeforeQuit={setWarnBeforeQuit} />
          ) : section === 'harnesses' ? (
            <HarnessSettings
              checking={checking}
              onCheckAgain={checkAgain}
              loginShellDiscovery={loginShellDiscovery}
              onLoginShellDiscovery={setLoginShellDiscovery}
            />
          ) : (
            <AppearanceSettings {...props} />
          )}
        </div>
      </div>
    </DialogFrame>
  )
}

function titleFor(section: SettingsSection): string {
  if (section === 'general') return 'General'
  if (section === 'harnesses') return 'Harnesses'
  return 'Appearance'
}

function descriptionFor(section: SettingsSection): string {
  if (section === 'general') return 'Everyday application behavior.'
  if (section === 'harnesses') return 'See what can run a Session and what needs attention.'
  return 'Choose a preset or make Argos yours.'
}

function GeneralSettings({
  warnBeforeQuit,
  onWarnBeforeQuit
}: {
  warnBeforeQuit: boolean
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
            <label htmlFor="warn-before-quit" className="flex cursor-pointer items-start gap-3 p-4">
              <input
                id="warn-before-quit"
                type="checkbox"
                checked={warnBeforeQuit}
                onChange={(event) => onWarnBeforeQuit(event.currentTarget.checked)}
                className="mt-0.5 accent-primary"
              />
              <span className="min-w-0 flex-1 text-xs font-medium">
                Warn before quitting with active agents
                <span className="mt-1 block max-w-xl text-xs leading-relaxed text-muted-foreground">
                  Argos safely stops active processes on exit whether this warning is on or off.
                </span>
              </span>
            </label>
          </div>
        </section>

        <section className="mt-7 border-t border-border pt-6" aria-labelledby="about-title">
          <h3 id="about-title" className="text-xs font-medium">
            About
          </h3>
          <div className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface">
            <SettingFact label="Application" value="Argos 0.1.0" />
            <SettingFact label="Application data" value="Stored locally on this Mac" />
          </div>
        </section>
      </div>
    </div>
  )
}

function SettingFact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3 text-xs">
      <span>{label}</span>
      <span className="text-muted-foreground">{value}</span>
    </div>
  )
}

function HarnessSettings({
  checking,
  onCheckAgain,
  loginShellDiscovery,
  onLoginShellDiscovery
}: {
  checking: boolean
  onCheckAgain: () => void
  loginShellDiscovery: boolean
  onLoginShellDiscovery: (enabled: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-start justify-between gap-5">
          <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
            Codex and Claude are checked independently. Argos never installs, updates, signs in, or
            stores credentials for a Harness—repairs happen in your terminal.
          </p>
          <Button quiet onClick={onCheckAgain}>
            <span className="flex items-center gap-1.5">
              <RefreshCw className={cn('size-3', checking && 'animate-spin')} aria-hidden="true" />
              {checking ? 'Checking…' : 'Check again'}
            </span>
          </Button>
        </div>

        <div className="mt-5 space-y-3">
          <HarnessCard
            name="Codex"
            status="usable"
            command="codex"
            version="0.45.0"
            path="/opt/homebrew/bin/codex"
            summary="Ready to run Sessions."
            checks={[
              ['Executable', 'Ready'],
              ['Version compatibility', 'Ready'],
              ['Signed in', 'Ready'],
              ['Skills', '12 installed']
            ]}
          />
          <HarnessCard
            name="Claude Code"
            status="attention"
            command="claude"
            version="2.1.37"
            path="~/.local/bin/claude"
            summary="Sign in before Claude can run a Session."
            checks={[
              ['Executable', 'Ready'],
              ['Version compatibility', 'Ready'],
              ['Signed in', 'Needs you'],
              ['Skills', '8 installed']
            ]}
          />
        </div>

        <label
          htmlFor="login-shell-discovery"
          className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-muted/40 p-4"
        >
          <input
            id="login-shell-discovery"
            type="checkbox"
            checked={loginShellDiscovery}
            onChange={(event) => onLoginShellDiscovery(event.currentTarget.checked)}
            className="mt-0.5 accent-primary"
          />
          <span className="text-xs font-medium">
            Deeper discovery through your login shell
            <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
              Helps find Harnesses installed through a version manager. This runs your shell startup
              files once per check, for up to five seconds.
            </span>
          </span>
        </label>
      </div>
    </div>
  )
}

function HarnessCard({
  name,
  status,
  command,
  version,
  path,
  summary,
  checks
}: {
  name: string
  status: 'usable' | 'attention'
  command: string
  version: string
  path: string
  summary: string
  checks: [string, string][]
}): React.JSX.Element {
  const usable = status === 'usable'
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span
          className={cn(
            'grid size-7 place-items-center rounded-md',
            usable ? 'bg-positive/10 text-positive' : 'bg-notice text-notice-foreground'
          )}
        >
          {usable ? (
            <CheckCircle2 className="size-4" aria-hidden="true" />
          ) : (
            <CircleAlert className="size-4" aria-hidden="true" />
          )}
        </span>
        <div>
          <h3 className="text-xs font-medium">{name}</h3>
          <p className="text-2xs text-muted-foreground">{summary}</p>
        </div>
        <span
          className={cn(
            'ml-auto rounded-full border px-2 py-0.5 text-2xs',
            usable
              ? 'border-positive/30 text-positive'
              : 'border-notice-border text-notice-foreground'
          )}
        >
          {usable ? 'Usable' : 'Needs attention'}
        </span>
      </header>
      <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(280px,1fr)]">
        <div className="border-r border-border p-4">
          <p className="text-xs text-muted-foreground">
            Command <code className="text-foreground">{command}</code> · version {version}
          </p>
          <p className="mt-1.5 font-mono text-2xs break-all text-muted-foreground">{path}</p>
          <button type="button" className="mt-3 text-2xs font-medium text-primary hover:underline">
            Choose executable…
          </button>
        </div>
        <ul className="grid grid-cols-2 content-start">
          {checks.map(([label, result]) => {
            const attention = result === 'Needs you'
            return (
              <li
                key={label}
                className="flex items-start gap-2 border-r border-b border-border p-3 even:border-r-0"
              >
                {attention ? (
                  <CircleAlert
                    className="mt-0.5 size-3 shrink-0 text-notice-foreground"
                    aria-hidden="true"
                  />
                ) : label === 'Skills' ? (
                  <Info
                    className="mt-0.5 size-3 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                ) : (
                  <Check className="mt-0.5 size-3 shrink-0 text-positive" aria-hidden="true" />
                )}
                <span>
                  <span className="block text-2xs font-medium">{label}</span>
                  <span
                    className={cn(
                      'block text-2xs',
                      attention ? 'text-notice-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {result}
                  </span>
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

function AppearanceSettings(props: VariantProps): React.JSX.Element {
  const dirty = isDirty(props)
  const customSelected = props.selected === 'custom'
  return (
    <div
      className={cn(
        'grid min-h-0 flex-1 transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none',
        customSelected ? 'grid-cols-[minmax(0,1fr)_330px]' : 'grid-cols-[minmax(0,1fr)_0px]'
      )}
    >
      <section className="overflow-y-auto p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium">Theme library</h3>
          <span className="text-2xs text-muted-foreground">Applied instantly</span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-x-4 gap-y-5">
          {PRESETS.map((preset) => (
            <PresetButton
              key={preset.id}
              preset={preset}
              selected={props.selected === preset.id}
              onSelect={props.select}
            />
          ))}
          <CustomCard
            selected={props.selected === 'custom'}
            draft={props.draft}
            onSelect={() => props.select('custom')}
          />
        </div>
        <div className="mt-7 rounded-lg border border-border bg-background p-4">
          <h3 className="text-xs font-medium">How custom themes work</h3>
          <p className="mt-1.5 max-w-lg text-2xs leading-relaxed text-muted-foreground">
            You choose the character. Argos derives readable text, surfaces, hover states, and focus
            colors from it.
          </p>
        </div>
      </section>
      <div
        className={cn(
          'min-w-0 overflow-hidden transition-opacity duration-150 motion-reduce:transition-none',
          customSelected ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
        aria-hidden={!customSelected}
        inert={!customSelected}
      >
        <aside
          className={cn(
            'flex h-full w-[330px] flex-col overflow-y-auto bg-background/40 p-5 transition-transform duration-200 ease-out motion-reduce:transform-none motion-reduce:transition-none',
            customSelected ? 'translate-x-0' : 'translate-x-5'
          )}
        >
          <div>
            <span className="text-2xs font-medium text-muted-foreground">CUSTOM THEME</span>
            <input
              value={props.draft.name}
              onChange={(event) => props.updateDraft({ name: event.currentTarget.value })}
              aria-label="Theme name"
              className="mt-1 w-full bg-transparent text-lg font-medium outline-none"
            />
          </div>
          <div className="mt-4">
            <MiniPreview draft={props.draft} />
          </div>
          <div className="mt-5 space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-md bg-muted/55 px-3 py-2.5">
              <span>
                <span className="block text-xs font-medium">Use for both</span>
                <span className="mt-0.5 block text-2xs text-muted-foreground">
                  Apply the same colors in Light and Dark.
                </span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={props.draft.useForBoth}
                aria-label="Use the same colors for light and dark"
                onClick={() => toggleUseForBoth(props)}
                className={cn(
                  'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                  props.draft.useForBoth ? 'bg-primary' : 'bg-border'
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform',
                    props.draft.useForBoth ? 'translate-x-4' : 'translate-x-0.5'
                  )}
                />
              </button>
            </div>
            {!props.draft.useForBoth ? (
              <SchemeControl
                value={props.draft.scheme}
                onChange={(scheme) => selectCustomScheme(props, scheme)}
              />
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <ColorField
                label="Background"
                value={props.draft.background}
                onChange={(background) => updateCustomColor(props, { background })}
              />
              <ColorField
                label="Accent"
                value={props.draft.accent}
                onChange={(accent) => updateCustomColor(props, { accent })}
              />
            </div>
          </div>
          <p className="mt-4 text-2xs leading-relaxed text-muted-foreground">
            Green, red, and amber remain reserved for additions, failures, and blocked work.
          </p>
          <div className="mt-auto flex items-center justify-between pt-4">
            <button
              type="button"
              onClick={props.reset}
              className="text-2xs text-muted-foreground hover:text-foreground"
            >
              Reset
            </button>
            <div className="flex gap-2">
              <Button quiet onClick={props.cancel} disabled={!dirty}>
                Cancel
              </Button>
              <Button onClick={props.save} disabled={!dirty}>
                Save &amp; apply
              </Button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

function selectCustomScheme(props: VariantProps, scheme: 'light' | 'dark'): void {
  props.updateDraft({ scheme, ...props.draft.colors[scheme] })
}

function updateCustomColor(
  props: VariantProps,
  patch: Partial<{ background: string; accent: string }>
): void {
  if (props.draft.useForBoth) {
    props.updateDraft(patch)
    return
  }

  const scheme = props.draft.scheme
  props.updateDraft({
    ...patch,
    colors: {
      ...props.draft.colors,
      [scheme]: { ...props.draft.colors[scheme], ...patch }
    }
  })
}

function toggleUseForBoth(props: VariantProps): void {
  if (props.draft.useForBoth) {
    props.updateDraft({
      useForBoth: false,
      ...props.draft.colors[props.draft.scheme]
    })
    return
  }

  props.updateDraft({ useForBoth: true })
}
