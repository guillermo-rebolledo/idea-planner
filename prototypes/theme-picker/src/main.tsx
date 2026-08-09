/**
 * PROTOTYPE — throwaway. Three variants of appearance settings, switchable
 * with `?variant=`, on top of a realistic Argos workspace.
 */
import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Workspace } from './parts'
import {
  DEFAULT_DRAFT,
  activeDefinition,
  appearanceForBackground,
  isDirty,
  paletteFor,
  type ThemeDraft,
  type ThemeId,
  type ThemeState
} from './theme'
import { VariantA } from './variant-a'
import { VariantB } from './variant-b'
import { VariantC } from './variant-c'
import './styles.css'

const VARIANTS = {
  A: { name: 'Library + inspector', render: VariantA },
  B: { name: 'Guided compact flow', render: VariantB },
  C: { name: 'Live canvas drawer', render: VariantC }
} as const
type VariantKey = keyof typeof VARIANTS
const KEYS = Object.keys(VARIANTS) as VariantKey[]

function readVariant(): VariantKey {
  const asked = new URLSearchParams(window.location.search).get('variant')?.toUpperCase()
  return KEYS.find((key) => key === asked) ?? 'A'
}

function App(): React.JSX.Element {
  const [variant, setVariant] = useState<VariantKey>(readVariant)
  const [state, setState] = useState<ThemeState>({
    selected: 'system',
    draft: DEFAULT_DRAFT,
    saved: DEFAULT_DRAFT
  })
  const definition = useMemo(() => activeDefinition(state), [state])

  useEffect(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('variant', variant)
    window.history.replaceState(null, '', url)
  }, [variant])

  useEffect(() => {
    document.documentElement.dataset['theme'] = appearanceForBackground(definition.background)
    const style = document.documentElement.style
    const palette = paletteFor(definition)
    for (const [role, value] of Object.entries(palette)) style.setProperty(role, value)
  }, [definition])

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (typing || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
      event.preventDefault()
      setVariant((current) => step(current, event.key === 'ArrowRight' ? 1 : -1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const actions = {
    select: (selected: ThemeId) => setState((current) => ({ ...current, selected })),
    updateDraft: (patch: Partial<ThemeDraft>) =>
      setState((current) => ({
        ...current,
        draft: { ...current.draft, ...patch }
      })),
    save: () => setState((current) => ({ ...current, selected: 'custom', saved: current.draft })),
    cancel: () => setState((current) => ({ ...current, draft: current.saved })),
    reset: () => setState((current) => ({ ...current, selected: 'custom', draft: DEFAULT_DRAFT }))
  } as const
  const Variant = VARIANTS[variant].render

  return (
    <div className="relative h-full overflow-hidden bg-background text-foreground">
      <Workspace />
      <Variant {...state} {...actions} />
      {import.meta.env.DEV ? (
        <Switcher variant={variant} onVariant={setVariant} state={state} definition={definition} />
      ) : null}
    </div>
  )
}

function step(current: VariantKey, by: number): VariantKey {
  return KEYS[(KEYS.indexOf(current) + by + KEYS.length) % KEYS.length] as VariantKey
}

function Switcher({
  variant,
  onVariant,
  state,
  definition
}: {
  variant: VariantKey
  onVariant: (key: VariantKey) => void
  state: ThemeState
  definition: ThemeDraft
}): React.JSX.Element {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div className="prototype-switcher pointer-events-auto flex max-w-full items-center gap-1 rounded-full px-1.5 py-1 shadow-lg">
        <button
          type="button"
          aria-label="Previous variant"
          onClick={() => onVariant(step(variant, -1))}
          className="grid size-7 place-items-center rounded-full hover:bg-white/10"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="px-1.5 text-xs whitespace-nowrap">
          <span className="font-mono">{variant}</span> — {VARIANTS[variant].name}
        </span>
        <button
          type="button"
          aria-label="Next variant"
          onClick={() => onVariant(step(variant, 1))}
          className="grid size-7 place-items-center rounded-full hover:bg-white/10"
        >
          <ChevronRight className="size-4" />
        </button>
        <span className="mx-1 h-5 w-px bg-white/20" />
        <span className="truncate px-1 font-mono text-[10px] text-white/65">
          selected:{state.selected} · base:{definition.scheme} · bg:{definition.background} ·
          accent:{definition.accent} · {isDirty(state) ? 'unsaved' : 'saved'}
        </span>
      </div>
    </div>
  )
}

const root = document.getElementById('root')
if (root === null) throw new Error('Missing #root element')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
