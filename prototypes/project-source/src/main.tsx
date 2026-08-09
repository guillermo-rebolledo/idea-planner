/**
 * PROTOTYPE — throwaway. Three variants answering:
 *
 * > How should adding a Project expand from a native folder picker into a
 * > Local folder / Git URL / GitHub flow?
 *
 * Switch with `?variant=A|B|C`, the floating bar, or ← / →. Compare the same
 * source/configure/cloning/failure state across every variant.
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChevronLeft, ChevronRight, Moon, Sun } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import {
  SCENARIOS,
  readScenario,
  readVariant,
  type FlowState,
  type Scenario,
  type SourceKind,
  type VariantKey,
  type VariantProps
} from './model'
import { VariantA } from './variant-a'
import { VariantB } from './variant-b'
import { VariantC } from './variant-c'
import './styles.css'

const VARIANTS: Record<
  VariantKey,
  { name: string; render: (props: VariantProps) => React.JSX.Element }
> = {
  A: { name: 'Command palette', render: VariantA },
  B: { name: 'Project launchpad', render: VariantB },
  C: { name: 'Guided wizard', render: VariantC }
}
const VARIANT_KEYS: VariantKey[] = ['A', 'B', 'C']

function App(): React.JSX.Element {
  const [variant, setVariant] = useState<VariantKey>(readVariant)
  const [dark, setDark] = useState(false)
  const [state, setState] = useState<FlowState>({
    scenario: readScenario(),
    source: 'github',
    repository: 'pingdotgg/t3code',
    destination: '~/Developer/t3code'
  })

  useEffect(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('variant', variant)
    url.searchParams.set('state', state.scenario)
    window.history.replaceState(null, '', url)
  }, [variant, state.scenario])

  useEffect(() => {
    document.documentElement.dataset['theme'] = dark ? 'dark' : 'light'
  }, [dark])

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null
      if (
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      )
        return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      setVariant((current) => stepVariant(current, event.key === 'ArrowRight' ? 1 : -1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const setScenario = (scenario: Scenario): void =>
    setState((current) => ({ ...current, scenario }))
  const setSource = (source: SourceKind): void => {
    setState((current) => ({
      ...current,
      source,
      repository:
        source === 'github'
          ? 'pingdotgg/t3code'
          : source === 'url'
            ? 'git@github.com:pingdotgg/t3code.git'
            : current.repository
    }))
  }
  const props: VariantProps = {
    state,
    setScenario,
    setSource,
    setRepository: (repository) => setState((current) => ({ ...current, repository })),
    setDestination: (destination) => setState((current) => ({ ...current, destination }))
  }
  const Variant = VARIANTS[variant].render

  return (
    <div className="h-full overflow-hidden bg-background text-foreground">
      <Variant {...props} />
      {!import.meta.env.PROD && (
        <PrototypeSwitcher
          variant={variant}
          setVariant={setVariant}
          scenario={state.scenario}
          setScenario={setScenario}
          source={state.source}
          dark={dark}
          setDark={setDark}
        />
      )}
    </div>
  )
}

function stepVariant(current: VariantKey, by: number): VariantKey {
  const index = (VARIANT_KEYS.indexOf(current) + by + VARIANT_KEYS.length) % VARIANT_KEYS.length
  return VARIANT_KEYS[index] as VariantKey
}

function PrototypeSwitcher({
  variant,
  setVariant,
  scenario,
  setScenario,
  source,
  dark,
  setDark
}: {
  variant: VariantKey
  setVariant: (variant: VariantKey) => void
  scenario: Scenario
  setScenario: (scenario: Scenario) => void
  source: SourceKind
  dark: boolean
  setDark: (dark: boolean) => void
}): React.JSX.Element {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-3">
      <div className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-full border border-border bg-surface-raised px-1.5 py-1 shadow-lg">
        <BarButton label="Previous variant" onClick={() => setVariant(stepVariant(variant, -1))}>
          <ChevronLeft aria-hidden="true" className="size-4" />
        </BarButton>
        <span className="px-1.5 text-xs whitespace-nowrap">
          <span className="font-mono">{variant}</span> — {VARIANTS[variant].name}
        </span>
        <BarButton label="Next variant" onClick={() => setVariant(stepVariant(variant, 1))}>
          <ChevronRight aria-hidden="true" className="size-4" />
        </BarButton>
        <span className="mx-1 h-5 w-px shrink-0 bg-border" />
        {SCENARIOS.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setScenario(item)}
            className={cn(
              'rounded-full px-2 py-1 text-2xs capitalize',
              item === scenario
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            {item}
          </button>
        ))}
        <span className="mx-1 h-5 w-px shrink-0 bg-border" />
        <span className="px-1 font-mono text-2xs whitespace-nowrap text-muted-foreground">
          {source} · {scenario}
        </span>
        <BarButton label={dark ? 'Light theme' : 'Dark theme'} onClick={() => setDark(!dark)}>
          {dark ? (
            <Sun aria-hidden="true" className="size-3.5" />
          ) : (
            <Moon aria-hidden="true" className="size-3.5" />
          )}
        </BarButton>
      </div>
    </div>
  )
}

function BarButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
