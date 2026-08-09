import { useState, type CSSProperties, type ReactNode } from 'react'
import { Check, ChevronRight, Circle, Palette, Plus, Search, Settings2 } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import {
  PRESETS,
  appearanceForBackground,
  type Scheme,
  type ThemeDraft,
  type ThemeId,
  type ThemePreset
} from './theme'

export function Workspace(): React.JSX.Element {
  const sessions = ['Theme customization', 'Permission mode copy', 'Subagent dock polish']
  return (
    <div className="absolute inset-0 flex bg-background text-foreground">
      <aside className="hidden w-60 shrink-0 border-r border-border bg-surface p-2 md:block">
        <div className="flex h-9 items-center justify-between px-2">
          <span className="text-sm font-semibold tracking-tight">Argos</span>
          <span className="grid size-6 place-items-center rounded text-muted-foreground">
            <Settings2 className="size-3.5" aria-hidden="true" />
          </span>
        </div>
        <button className="mt-2 flex h-8 w-full items-center gap-2 rounded-md bg-primary px-2 text-xs text-primary-foreground">
          <Plus className="size-3.5" aria-hidden="true" /> New Session
        </button>
        <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-2xs text-muted-foreground">
          <Search className="size-3" aria-hidden="true" /> Search Sessions
        </div>
        <p className="mt-5 px-2 text-2xs tracking-wide text-muted-foreground uppercase">Today</p>
        <div className="mt-1 space-y-0.5">
          {sessions.map((session, index) => (
            <div
              key={session}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-2 text-xs',
                index === 0 ? 'bg-accent text-foreground' : 'text-muted-foreground'
              )}
            >
              <Circle className="size-2 fill-current" aria-hidden="true" />
              <span className="truncate">{session}</span>
            </div>
          ))}
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Theme customization</span>
            <span className="font-mono text-2xs text-muted-foreground">Local</span>
          </div>
          <span className="text-2xs text-muted-foreground">main</span>
        </header>
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 overflow-hidden px-8 py-8">
          <div className="max-w-xl rounded-lg border border-border bg-surface p-4">
            <p className="text-sm font-medium">You</p>
            <p className="mt-2 text-sm leading-relaxed">
              Let users choose preset themes and make one from a background and accent color.
            </p>
          </div>
          <div className="max-w-2xl">
            <p className="text-sm leading-relaxed">
              I’d keep the editor simple while deriving the full semantic palette behind it. That
              preserves readable code, status colors, and focus states.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-border bg-surface p-3">
                <p className="text-xs font-medium">Background</p>
                <p className="mt-1 text-2xs text-muted-foreground">
                  Sets the character of surfaces.
                </p>
              </div>
              <div className="rounded-lg border border-border bg-surface p-3">
                <p className="text-xs font-medium text-primary">Accent color</p>
                <p className="mt-1 text-2xs text-muted-foreground">Buttons, focus, and emphasis.</p>
              </div>
            </div>
          </div>
        </div>
        <div className="mx-auto mb-8 w-[min(680px,calc(100%-48px))] rounded-xl border border-border bg-surface-raised px-4 py-3 shadow-md">
          <span className="text-sm text-muted-foreground">Ask Argos anything…</span>
        </div>
      </main>
    </div>
  )
}

export function ThemeSwatch({
  preset,
  selected
}: {
  preset: ThemePreset
  selected: boolean
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'relative h-16 overflow-hidden rounded-md border transition',
        selected ? 'border-primary ring-2 ring-ring' : 'border-black/10 dark:border-white/10'
      )}
      style={{ backgroundColor: preset.background }}
    >
      <div className="absolute inset-x-2 top-2 flex gap-1">
        <span className="h-8 flex-1 rounded-sm bg-white/75 dark:bg-white/10" />
        <span className="h-8 w-7 rounded-sm" style={{ backgroundColor: preset.accent }} />
      </div>
      {selected ? (
        <span
          className="absolute right-1.5 bottom-1.5 grid size-4 place-items-center rounded-full"
          style={{
            backgroundColor: preset.accent,
            color: preset.scheme === 'dark' ? '#101318' : '#ffffff'
          }}
        >
          <Check className="size-2.5" strokeWidth={3} aria-hidden="true" />
        </span>
      ) : null}
    </div>
  )
}

export function PresetButton({
  preset,
  selected,
  onSelect,
  compact = false
}: {
  preset: ThemePreset
  selected: boolean
  onSelect: (id: ThemeId) => void
  compact?: boolean
}): React.JSX.Element {
  if (compact) {
    return (
      <button
        type="button"
        onClick={() => onSelect(preset.id)}
        className={cn(
          'flex w-full items-center gap-3 rounded-lg border p-2 text-left transition',
          selected ? 'border-primary bg-accent' : 'border-border hover:bg-muted'
        )}
      >
        <span className="flex shrink-0 overflow-hidden rounded-full border border-border">
          <span className="size-5" style={{ backgroundColor: preset.background }} />
          <span className="size-5" style={{ backgroundColor: preset.accent }} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium">{preset.name}</span>
          <span className="block text-2xs text-muted-foreground">{preset.description}</span>
        </span>
        {selected ? (
          <Check className="size-3.5 text-primary" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
        )}
      </button>
    )
  }

  return (
    <button type="button" className="text-left" onClick={() => onSelect(preset.id)}>
      <ThemeSwatch preset={preset} selected={selected} />
      <span className="mt-2 block text-xs font-medium">{preset.name}</span>
      <span className="block text-2xs text-muted-foreground">{preset.description}</span>
    </button>
  )
}

export function ColorField({
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
              onChange(next)
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

export function SchemeControl({
  value,
  onChange
}: {
  value: Scheme
  onChange: (scheme: Scheme) => void
}): React.JSX.Element {
  return (
    <div
      className="grid grid-cols-2 rounded-md border border-border bg-muted p-0.5"
      role="group"
      aria-label="Base appearance"
    >
      {(['light', 'dark'] as const).map((scheme) => (
        <button
          key={scheme}
          type="button"
          aria-pressed={value === scheme}
          onClick={() => onChange(scheme)}
          className={cn(
            'rounded px-2 py-1 text-xs capitalize',
            value === scheme ? 'bg-surface-raised font-medium shadow-sm' : 'text-muted-foreground'
          )}
        >
          {scheme}
        </button>
      ))}
    </div>
  )
}

export function MiniPreview({
  draft,
  roomy = false
}: {
  draft: ThemeDraft
  roomy?: boolean
}): React.JSX.Element {
  const dark = appearanceForBackground(draft.background) === 'dark'
  return (
    <div
      className={cn('overflow-hidden rounded-lg border border-border', roomy ? 'h-52' : 'h-32')}
      style={{ backgroundColor: draft.background }}
    >
      <div className="flex h-7 items-center gap-1.5 border-b border-black/10 px-2 dark:border-white/10">
        <span className="size-1.5 rounded-full bg-red-400" />
        <span className="size-1.5 rounded-full bg-amber-400" />
        <span className="size-1.5 rounded-full bg-green-400" />
      </div>
      <div className="flex h-[calc(100%-28px)]">
        <div className="w-[30%] border-r border-black/10 p-2 dark:border-white/10">
          <span
            className="block h-1.5 w-10 rounded-full"
            style={{ backgroundColor: dark ? '#ffffff55' : '#11131844' }}
          />
          <span
            className="mt-2 block h-5 rounded"
            style={{ backgroundColor: `${draft.accent}28` }}
          />
          <span
            className="mt-1 block h-5 rounded"
            style={{ backgroundColor: dark ? '#ffffff0d' : '#ffffff80' }}
          />
        </div>
        <div className="flex-1 p-3">
          <span
            className="block h-2 w-20 rounded-full"
            style={{ backgroundColor: dark ? '#ffffffc8' : '#111318cc' }}
          />
          <span
            className="mt-2 block h-1.5 w-4/5 rounded-full"
            style={{ backgroundColor: dark ? '#ffffff45' : '#1113183a' }}
          />
          <span
            className="mt-1 block h-1.5 w-3/5 rounded-full"
            style={{ backgroundColor: dark ? '#ffffff45' : '#1113183a' }}
          />
          <span
            className="mt-4 inline-block rounded px-2 py-1 text-[9px] font-medium"
            style={{ backgroundColor: draft.accent, color: dark ? '#101318' : '#ffffff' }}
          >
            Run
          </span>
        </div>
      </div>
    </div>
  )
}

export function CustomCard({
  selected,
  draft,
  onSelect
}: {
  selected: boolean
  draft: ThemeDraft
  onSelect: () => void
}): React.JSX.Element {
  const preset: ThemePreset = { id: 'system', description: 'Your colors', ...draft }
  return (
    <button type="button" className="text-left" onClick={onSelect}>
      <div className="relative">
        <ThemeSwatch preset={preset} selected={selected} />
        {!selected ? (
          <span className="absolute inset-0 grid place-items-center">
            <span className="grid size-7 place-items-center rounded-full bg-black/65 text-white shadow">
              <Palette className="size-3.5" aria-hidden="true" />
            </span>
          </span>
        ) : null}
      </div>
      <span className="mt-2 block text-xs font-medium">Custom</span>
      <span className="block text-2xs text-muted-foreground">{draft.name}</span>
    </button>
  )
}

export function Button({
  children,
  onClick,
  quiet = false,
  disabled = false
}: {
  children: ReactNode
  onClick?: () => void
  quiet?: boolean
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-md px-3 py-1.5 text-xs font-medium transition disabled:opacity-40',
        quiet
          ? 'border border-border bg-surface hover:bg-muted'
          : 'bg-primary text-primary-foreground hover:bg-primary-hover'
      )}
    >
      {children}
    </button>
  )
}

export function DialogFrame({
  children,
  width = 'max-w-4xl',
  className
}: {
  children: ReactNode
  width?: string
  className?: string
}): React.JSX.Element {
  return (
    <div className="absolute inset-0 z-10 grid place-items-center bg-black/30 p-8 backdrop-blur-[2px]">
      <section
        className={cn(
          'max-h-[calc(100vh-80px)] w-full overflow-hidden rounded-xl border border-border bg-surface-raised shadow-lg',
          width,
          className
        )}
        aria-label="Appearance settings"
      >
        {children}
      </section>
    </div>
  )
}

export function PresetStrip({
  selected,
  onSelect
}: {
  selected: ThemeId
  onSelect: (id: ThemeId) => void
}): React.JSX.Element {
  return (
    <div className="flex gap-2">
      {PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          onClick={() => onSelect(preset.id)}
          title={preset.name}
          aria-label={preset.name}
          className={cn(
            'size-7 rounded-full border-2 shadow-sm',
            selected === preset.id ? 'border-primary ring-2 ring-ring' : 'border-surface-raised'
          )}
          style={
            {
              background: `linear-gradient(135deg, ${preset.background} 0 52%, ${preset.accent} 52%)`
            } as CSSProperties
          }
        />
      ))}
    </div>
  )
}
