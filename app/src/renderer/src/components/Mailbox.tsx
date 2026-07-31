import { useCallback, useEffect, useState } from 'react'
import { Inbox, Lightbulb, PanelLeft, Plus } from 'lucide-react'
import type { IdeaSummary, LibrarySnapshot, ThemePreference, ThemeState } from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { CaptureForm } from '@renderer/components/CaptureForm'
import { IDEA_KIND_META, IdeaKindIcon } from '@renderer/components/idea-kind'
import { cn } from '@renderer/lib/utils'

interface MailboxProps {
  library: LibrarySnapshot
  onLibraryChanged: (library: LibrarySnapshot) => void
  theme: ThemeState | null
  onThemePreferenceChange: (preference: ThemePreference) => void
}

type CenterSurface = { kind: 'empty' } | { kind: 'capture' } | { kind: 'idea'; ideaId: string }

/**
 * The Focus Mailbox production frame: collapsible Idea inbox on the left and
 * a primary center surface. In this slice the center holds capture and a
 * saved-Idea view; later slices put the permanent Conversation here.
 */
export function Mailbox({
  library,
  onLibraryChanged,
  theme,
  onThemePreferenceChange
}: MailboxProps): React.JSX.Element {
  const [surface, setSurface] = useState<CenterSurface>({ kind: 'empty' })
  const [inboxCollapsed, setInboxCollapsed] = useState(false)
  const [announcement, setAnnouncement] = useState('')

  const startCapture = useCallback(() => setSurface({ kind: 'capture' }), [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement
      const typing =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      if (event.key.toLowerCase() === 'n' && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        startCapture()
      }
      if (event.key === '\\' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setInboxCollapsed((collapsed) => !collapsed)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [startCapture])

  function handleSaved(idea: IdeaSummary): void {
    onLibraryChanged({ ...library, ideas: [idea, ...library.ideas] })
    setSurface({ kind: 'idea', ideaId: idea.id })
    setAnnouncement(`Saved “${idea.title}” for later.`)
  }

  const selectedIdea =
    surface.kind === 'idea' ? library.ideas.find((idea) => idea.id === surface.ideaId) : undefined

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag-region flex h-11 shrink-0 items-center gap-2 border-b border-border pr-3 pl-20">
        <Button
          variant="ghost"
          size="icon"
          aria-label={inboxCollapsed ? 'Show inbox' : 'Hide inbox'}
          aria-expanded={!inboxCollapsed}
          onClick={() => setInboxCollapsed((collapsed) => !collapsed)}
        >
          <PanelLeft aria-hidden="true" className="size-4" />
        </Button>
        <h1 className="text-[13px] font-semibold">Ideas</h1>
        <span className="truncate font-mono text-[11px] text-muted-foreground" title={library.path}>
          {library.path}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <ThemeSelect theme={theme} onChange={onThemePreferenceChange} />
          <Button onClick={startCapture} size="sm">
            <Plus aria-hidden="true" className="size-3.5" />
            New Idea
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {!inboxCollapsed && (
          <nav
            aria-label="Idea inbox"
            className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-muted/40 py-2"
          >
            {library.ideas.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
                <Inbox aria-hidden="true" className="size-5 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">
                  No Ideas yet. Press <kbd className="font-mono">N</kbd> to capture one.
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-px px-2">
                {library.ideas.map((idea) => (
                  <li key={idea.id}>
                    <button
                      type="button"
                      onClick={() => setSurface({ kind: 'idea', ideaId: idea.id })}
                      aria-current={selectedIdea?.id === idea.id ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                        selectedIdea?.id === idea.id
                          ? 'bg-accent text-foreground'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                      )}
                    >
                      <IdeaKindIcon kind={idea.kind} />
                      <span className="min-w-0 flex-1 truncate">{idea.title}</span>
                      <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                        Saved
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </nav>
        )}

        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {surface.kind === 'capture' ? (
            <CaptureForm onSaved={handleSaved} onCancel={() => setSurface({ kind: 'empty' })} />
          ) : selectedIdea ? (
            <IdeaDetail idea={selectedIdea} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <Lightbulb aria-hidden="true" className="size-6 text-muted-foreground" />
              <div>
                <p className="font-medium">Capture an Idea before it fades</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Press <kbd className="rounded border border-border px-1 font-mono">N</kbd> or use
                  New Idea. Saving never starts AI.
                </p>
              </div>
            </div>
          )}
        </main>
      </div>

      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}

function IdeaDetail({ idea }: { idea: IdeaSummary }): React.JSX.Element {
  const savedAt = new Date(idea.updatedAt)
  return (
    <article className="mx-auto w-full max-w-xl p-6" aria-label={idea.title}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <IdeaKindIcon kind={idea.kind} />
        <span>{IDEA_KIND_META[idea.kind].label}</span>
        <span aria-hidden="true">·</span>
        <span>
          Saved for later on{' '}
          {savedAt.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          })}
        </span>
      </div>
      <h2 className="mt-2 text-lg font-semibold select-text">{idea.title}</h2>
      <p className="mt-4 rounded-md border border-border bg-surface p-3 font-mono text-xs break-all text-muted-foreground select-text">
        {idea.relativePath}/idea.md
      </p>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        This Idea is plain Markdown inside your Idea Library. Developing it with AI is a separate,
        explicit step that arrives in a later milestone.
      </p>
    </article>
  )
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

function ThemeSelect({
  theme,
  onChange
}: {
  theme: ThemeState | null
  onChange: (preference: ThemePreference) => void
}): React.JSX.Element {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      Appearance
      <select
        value={theme?.preference ?? 'system'}
        onChange={(event) => onChange(event.target.value as ThemePreference)}
        className="h-6 rounded-md border border-border bg-surface px-1 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {THEME_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}
