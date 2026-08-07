/**
 * PROTOTYPE — throwaway. Three answers to one question:
 *
 * > When a Run spawns subagents, where does the Conversation say so, and what
 * > does opening one look like?
 *
 * Switch with `?variant=A|B|C`, the floating bar, or the arrow keys. The Run is
 * replayed on a clock so each surface is judged while the fleet is moving:
 * scrub it, pause it, or leave it looping.
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChevronLeft, ChevronRight, Moon, Pause, Play, Sun } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { RUN_LENGTH, SUBAGENTS, STATE_TEXT, stateAt } from './fleet'
import { VariantA } from './variant-a'
import { VariantB } from './variant-b'
import { VariantC } from './variant-c'
import './styles.css'

const VARIANTS = {
  A: { name: 'Pills in the prose', render: VariantA },
  B: { name: 'One folded block', render: VariantB },
  C: { name: 'The fleet has its own dock', render: VariantC }
} as const

type VariantKey = keyof typeof VARIANTS
const KEYS = Object.keys(VARIANTS) as VariantKey[]

/** How often the replay ticks, and by how much. */
const TICK_MS = 200
const TICK_SECONDS = 0.2

function readVariant(): VariantKey {
  const asked = new URLSearchParams(window.location.search).get('variant')?.toUpperCase()
  return KEYS.find((key) => key === asked) ?? 'A'
}

function App(): React.JSX.Element {
  const [variant, setVariant] = useState<VariantKey>(readVariant)
  const [now, setNow] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [dark, setDark] = useState(false)

  useEffect(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('variant', variant)
    window.history.replaceState(null, '', url)
  }, [variant])

  useEffect(() => {
    document.documentElement.dataset['theme'] = dark ? 'dark' : 'light'
  }, [dark])

  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      setNow((seconds) => (seconds + TICK_SECONDS) % (RUN_LENGTH + 4))
    }, TICK_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [playing])

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable === true)
      if (typing) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      setVariant((current) => step(current, event.key === 'ArrowRight' ? 1 : -1))
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const Variant = VARIANTS[variant].render

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        <FakeSidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
            <span className="text-sm font-medium">Bounded recorded session diff</span>
            <span className="font-mono text-2xs text-muted-foreground">MEM-94</span>
          </header>
          <div className="min-h-0 flex-1">
            <Variant now={now} />
          </div>
          <FakeComposer />
        </main>
      </div>

      <Switcher
        variant={variant}
        onVariant={setVariant}
        now={now}
        playing={playing}
        onPlaying={setPlaying}
        onScrub={(seconds) => {
          setPlaying(false)
          setNow(seconds)
        }}
        dark={dark}
        onDark={setDark}
      />
    </div>
  )
}

function step(current: VariantKey, by: number): VariantKey {
  const next = (KEYS.indexOf(current) + by + KEYS.length) % KEYS.length
  return KEYS[next] as VariantKey
}

/**
 * The floating bar: which variant, where the replay is, and the fleet's state
 * spelled out — a surface that looks fine at second 30 and unreadable at
 * second 9 is a surface that has not been judged.
 */
function Switcher({
  variant,
  onVariant,
  now,
  playing,
  onPlaying,
  onScrub,
  dark,
  onDark
}: {
  variant: VariantKey
  onVariant: (key: VariantKey) => void
  now: number
  playing: boolean
  onPlaying: (playing: boolean) => void
  onScrub: (seconds: number) => void
  dark: boolean
  onDark: (dark: boolean) => void
}): React.JSX.Element {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-surface-raised px-1.5 py-1 shadow-lg">
        <BarButton
          label="Previous variant"
          onClick={() => {
            onVariant(step(variant, -1))
          }}
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </BarButton>
        <span className="px-1.5 text-xs whitespace-nowrap">
          <span className="font-mono">{variant}</span> — {VARIANTS[variant].name}
        </span>
        <BarButton
          label="Next variant"
          onClick={() => {
            onVariant(step(variant, 1))
          }}
        >
          <ChevronRight aria-hidden="true" className="size-4" />
        </BarButton>

        <span className="mx-1 h-5 w-px bg-border" />

        <BarButton
          label={playing ? 'Pause the replay' : 'Play the replay'}
          onClick={() => {
            onPlaying(!playing)
          }}
        >
          {playing ? (
            <Pause aria-hidden="true" className="size-3.5" />
          ) : (
            <Play aria-hidden="true" className="size-3.5" />
          )}
        </BarButton>
        <input
          type="range"
          min={0}
          max={RUN_LENGTH + 4}
          step={0.2}
          value={now}
          aria-label="Scrub the replay"
          onChange={(event) => {
            onScrub(Number(event.target.value))
          }}
          className="w-32 accent-primary"
        />
        <span className="w-8 shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
          {now.toFixed(0)}s
        </span>

        <span className="mx-1 h-5 w-px bg-border" />

        <span className="flex items-center gap-1.5 pr-1 font-mono text-2xs text-muted-foreground">
          {SUBAGENTS.map((agent) => (
            <span key={agent.id} title={agent.name}>
              {agent.id}:{STATE_TEXT[stateAt(agent, now)].toLowerCase()}
            </span>
          ))}
        </span>

        <BarButton
          label={dark ? 'Light theme' : 'Dark theme'}
          onClick={() => {
            onDark(!dark)
          }}
        >
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
      className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  )
}

/** Context, not design: the app's furniture, so density is judged honestly. */
function FakeSidebar(): React.JSX.Element {
  const sessions = ['Bounded recorded session diff', 'Contract obsolete seams', 'Sidebar polish']
  return (
    <nav className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface px-2 py-3 md:flex">
      <span className="px-2 pb-2 text-2xs tracking-wide text-muted-foreground uppercase">
        Conversations
      </span>
      {sessions.map((session, index) => (
        <span
          key={session}
          className={cn(
            'truncate rounded-md px-2 py-1.5 text-xs',
            index === 0 ? 'bg-muted text-foreground' : 'text-muted-foreground'
          )}
        >
          {session}
        </span>
      ))}
    </nav>
  )
}

function FakeComposer(): React.JSX.Element {
  return (
    <div className="shrink-0 border-t border-border px-4 py-3 pb-14">
      <div className="mx-auto max-w-3xl rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
        Reply to this Run…
      </div>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
