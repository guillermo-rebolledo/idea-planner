import { useState } from 'react'
import { Check, Palette } from 'lucide-react'
import type { AppearanceSettings, ThemeState } from '@shared/contract'
import {
  APPEARANCE_PRESETS,
  DEFAULT_CUSTOM_THEME,
  PRESET_COLORS,
  derivePalette,
  setCustomThemeSharing,
  type CustomTheme,
  type ResolvedTheme,
  type ThemeColors,
  type ThemePreference
} from '@shared/theme'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

export function AppearanceSettingsPanel({
  theme,
  appearance,
  customDraft,
  error,
  onCustomDraft,
  onApply,
  onCancel
}: {
  theme: ThemeState | null
  appearance: AppearanceSettings | null
  customDraft: CustomTheme | null
  error: boolean
  onCustomDraft: (custom: CustomTheme) => void
  onApply: (appearance: AppearanceSettings) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [editorMode, setEditorMode] = useState<ResolvedTheme>('light')
  const [saving, setSaving] = useState(false)
  const [systemResolved] = useState<ResolvedTheme>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  )
  const selected = appearance?.preference ?? theme?.preference ?? 'system'
  const customSelected = selected === 'custom'
  const dirty =
    customDraft !== null &&
    appearance !== null &&
    JSON.stringify(customDraft) !== JSON.stringify(appearance.custom)

  async function apply(next: AppearanceSettings): Promise<void> {
    setSaving(true)
    try {
      await onApply(next)
    } finally {
      setSaving(false)
    }
  }

  function select(preference: ThemePreference): void {
    if (!appearance || !customDraft) return
    const custom = preference === 'custom' ? customDraft : appearance.custom
    void apply({ preference, custom }).catch(() => undefined)
  }

  function updateCustom(patch: Partial<CustomTheme>): void {
    if (!customDraft) return
    onCustomDraft({ ...customDraft, ...patch })
  }

  const definition = customDraft
    ? customDraft.useForBoth
      ? customDraft.shared
      : customDraft[editorMode]
    : DEFAULT_CUSTOM_THEME.light

  return (
    <div
      data-custom-selected={customSelected}
      className="appearance-settings-layout grid min-h-0 flex-1 duration-200 ease-out motion-reduce:transition-none"
    >
      <section className="overflow-y-auto p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium">Theme library</h3>
          <span className="text-2xs text-muted-foreground">Presets apply instantly</span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-x-4 gap-y-5">
          {APPEARANCE_PRESETS.map((preset) => (
            <ThemeCard
              key={preset.id}
              name={preset.name}
              description={preset.description}
              colors={presetColors(preset.id, systemResolved)}
              selected={selected === preset.id}
              disabled={appearance === null || saving}
              onSelect={() => select(preset.id)}
            />
          ))}
          <ThemeCard
            name="Custom"
            description={customDraft?.name ?? DEFAULT_CUSTOM_THEME.name}
            colors={definition}
            selected={customSelected}
            custom
            disabled={appearance === null || saving}
            onSelect={() => select('custom')}
          />
        </div>
        <div className="mt-7 rounded-lg bg-background p-4">
          <h3 className="text-xs font-medium">How custom themes work</h3>
          <p className="mt-1.5 max-w-lg text-2xs leading-relaxed text-muted-foreground">
            You choose the character. Argos derives readable text, surfaces, hover states, and focus
            colors from it. Green, red, and amber remain reserved for product meaning.
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
            'custom-theme-editor flex h-full flex-col overflow-y-auto bg-background/40 p-5 transition-transform duration-200 ease-out motion-reduce:transform-none motion-reduce:transition-none',
            customSelected ? 'translate-x-0' : 'translate-x-5'
          )}
          aria-label="Custom theme editor"
        >
          <div>
            <span className="text-2xs font-medium text-muted-foreground">CUSTOM THEME</span>
            <input
              value={customDraft?.name ?? ''}
              maxLength={60}
              onChange={(event) => updateCustom({ name: event.currentTarget.value })}
              aria-label="Theme name"
              className="mt-1 w-full bg-transparent text-lg font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <div className="mt-4">
            <ThemePreview definition={definition} />
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
                aria-checked={customDraft?.useForBoth ?? false}
                aria-label="Use the same colors for light and dark"
                onClick={() => {
                  if (!customDraft) return
                  onCustomDraft(
                    setCustomThemeSharing(customDraft, !customDraft.useForBoth, editorMode)
                  )
                }}
                className={cn(
                  'relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                  customDraft?.useForBoth ? 'bg-primary' : 'bg-border'
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform',
                    customDraft?.useForBoth ? 'translate-x-4' : 'translate-x-0.5'
                  )}
                />
              </button>
            </div>

            {!customDraft?.useForBoth ? (
              <div
                className="grid grid-cols-2 rounded-md border border-border bg-muted p-0.5"
                role="group"
                aria-label="Custom theme mode"
              >
                {(['light', 'dark'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={editorMode === mode}
                    onClick={() => setEditorMode(mode)}
                    className={cn(
                      'rounded px-2 py-1 text-xs capitalize focus-visible:ring-2 focus-visible:ring-ring',
                      editorMode === mode
                        ? 'bg-surface-raised font-medium shadow-sm'
                        : 'text-muted-foreground'
                    )}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <ColorField
                label="Background"
                value={definition.background}
                onChange={(background) =>
                  updateColors(customDraft, editorMode, { background }, updateCustom)
                }
              />
              <ColorField
                label="Accent"
                value={definition.accent}
                onChange={(accent) =>
                  updateColors(customDraft, editorMode, { accent }, updateCustom)
                }
              />
            </div>
          </div>

          {error ? (
            <p role="alert" className="mt-4 text-2xs text-destructive">
              Appearance could not be saved. Your previous theme is still active.
            </p>
          ) : null}

          <div className="mt-auto flex items-center justify-between pt-4">
            <button
              type="button"
              disabled={saving}
              onClick={() => onCustomDraft(DEFAULT_CUSTOM_THEME)}
              className="text-2xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              Reset
            </button>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={!dirty || saving} onClick={onCancel}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!dirty || saving}
                onClick={() => {
                  if (customDraft) void apply({ preference: 'custom', custom: customDraft })
                }}
              >
                {saving ? 'Saving…' : 'Save & apply'}
              </Button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

function updateColors(
  custom: CustomTheme | null,
  mode: ResolvedTheme,
  patch: Partial<ThemeColors>,
  update: (patch: Partial<CustomTheme>) => void
): void {
  if (!custom) return
  if (custom.useForBoth) {
    update({ shared: { ...custom.shared, ...patch } })
    return
  }
  update({ [mode]: { ...custom[mode], ...patch } })
}

function presetColors(preference: ThemePreference, system: ResolvedTheme): ThemeColors {
  if (preference === 'system') return presetColors(system, system)
  if (preference === 'light') return PRESET_COLORS.light
  if (preference === 'dark') return PRESET_COLORS.dark
  return (
    APPEARANCE_PRESETS.find((preset) => preset.id === preference)?.definition ??
    DEFAULT_CUSTOM_THEME.light
  )
}

function ThemeCard({
  name,
  description,
  colors,
  selected,
  custom = false,
  disabled,
  onSelect
}: {
  name: string
  description: string
  colors: ThemeColors
  selected: boolean
  custom?: boolean
  disabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="text-left"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <div
        className={cn(
          'relative h-16 overflow-hidden rounded-md border transition',
          selected ? 'border-primary ring-2 ring-ring' : 'border-black/10 dark:border-white/10'
        )}
        style={{ backgroundColor: colors.background }}
      >
        <div className="absolute inset-x-2 top-2 flex gap-1">
          <span className="h-8 flex-1 rounded-sm bg-white/75" />
          <span className="h-8 w-7 rounded-sm" style={{ backgroundColor: colors.accent }} />
        </div>
        {custom && !selected ? (
          <span className="absolute inset-0 grid place-items-center">
            <span className="grid size-7 place-items-center rounded-full bg-black/65 text-white shadow">
              <Palette aria-hidden="true" className="size-3.5" />
            </span>
          </span>
        ) : null}
        {selected ? (
          <span
            className="absolute right-1.5 bottom-1.5 grid size-4 place-items-center rounded-full"
            style={{
              backgroundColor: colors.accent,
              color: derivePalette(colors).primaryForeground
            }}
          >
            <Check aria-hidden="true" className="size-2.5" strokeWidth={3} />
          </span>
        ) : null}
      </div>
      <span className="mt-2 block text-xs font-medium">{name}</span>
      <span className="block text-2xs text-muted-foreground">{description}</span>
    </button>
  )
}

function ThemePreview({ definition }: { definition: ThemeColors }): React.JSX.Element {
  const palette = derivePalette(definition)
  return (
    <div
      className="h-32 overflow-hidden rounded-lg border"
      style={{ backgroundColor: palette.background, borderColor: palette.border }}
    >
      <div
        className="flex h-7 items-center gap-1.5 border-b px-2"
        style={{ borderColor: palette.border }}
      >
        <span className="size-1.5 rounded-full bg-destructive" />
        <span className="size-1.5 rounded-full bg-notice-foreground" />
        <span className="size-1.5 rounded-full bg-positive" />
      </div>
      <div className="theme-preview-body flex">
        <div className="theme-preview-sidebar border-r p-2" style={{ borderColor: palette.border }}>
          <span
            className="block h-1.5 w-10 rounded-full"
            style={{ background: palette.mutedForeground }}
          />
          <span className="mt-2 block h-5 rounded" style={{ background: palette.accent }} />
          <span className="mt-1 block h-5 rounded" style={{ background: palette.muted }} />
        </div>
        <div className="flex-1 p-3">
          <span
            className="block h-2 w-20 rounded-full"
            style={{ background: palette.foreground }}
          />
          <span
            className="mt-2 block h-1.5 w-4/5 rounded-full"
            style={{ background: palette.mutedForeground }}
          />
          <span
            className="mt-1 block h-1.5 w-3/5 rounded-full"
            style={{ background: palette.mutedForeground }}
          />
          <span
            className="theme-preview-run mt-4 inline-block rounded px-2 py-1 font-medium"
            style={{ background: palette.primary, color: palette.primaryForeground }}
          >
            Run
          </span>
        </div>
      </div>
    </div>
  )
}

function ColorField({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const [written, setWritten] = useState<string | null>(null)
  return (
    <label className="block">
      <span className="mb-1.5 block text-2xs font-medium text-muted-foreground">{label}</span>
      <span className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-2 focus-within:ring-2 focus-within:ring-ring">
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="size-5 cursor-pointer border-0 bg-transparent p-0"
          aria-label={`${label} color picker`}
        />
        <input
          value={written ?? value.toUpperCase()}
          onChange={(event) => {
            const next = event.currentTarget.value
            setWritten(next)
            if (/^#[0-9a-fA-F]{6}$/.test(next)) {
              onChange(next.toLowerCase())
              setWritten(null)
            }
          }}
          onBlur={() => setWritten(null)}
          aria-label={`${label} hex value`}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
        />
      </span>
    </label>
  )
}
