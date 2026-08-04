import { useMemo, useRef, useState } from 'react'
import { Pin } from 'lucide-react'
import type { SessionSummary } from '@shared/contract'
import { useDialogFocus } from '@renderer/components/ui/dialog'
import { cn } from '@renderer/lib/utils'

/**
 * ⌘K: the keyboard way across the inbox. One field, every active Session,
 * arrow keys to choose — for the person with fifteen Sessions open who knows
 * exactly which one they want and does not want to walk the sidebar to it.
 * Focus stays in the field the whole time (the list moves by
 * aria-activedescendant), so typing and choosing are one motion.
 */

/** The last segment of a Project root: how the person knows the folder. */
function folderName(root: string): string {
  return root.split('/').filter(Boolean).at(-1) ?? root
}

/** How many rows the palette offers; typing narrows toward the one wanted. */
const LIMIT = 12

export function SessionSwitcher({
  sessions,
  onOpen,
  onClose
}: {
  /** Every Session the switcher may offer, unfiltered. */
  sessions: SessionSummary[]
  onOpen: (session: SessionSummary) => void
  onClose: () => void
}): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  useDialogFocus(panelRef)
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState(0)

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return sessions
      .filter((session) => session.archivedAt === null)
      .filter(
        (session) =>
          needle === '' ||
          session.title.toLowerCase().includes(needle) ||
          folderName(session.projectRoot).toLowerCase().includes(needle)
      )
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
      )
      .slice(0, LIMIT)
  }, [sessions, query])

  // Kept in range as typing narrows the list, without a state reset per key.
  const active = matches.length === 0 ? -1 : Math.min(chosen, matches.length - 1)

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center bg-background/60 p-6 pt-20"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Go to a Session"
        tabIndex={-1}
        className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-surface-raised shadow-lg outline-none"
      >
        <input
          data-autofocus=""
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="session-switcher-options"
          aria-activedescendant={active >= 0 ? `session-switcher-option-${active}` : undefined}
          aria-label="Go to a Session"
          placeholder="Go to a Session…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setChosen(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              onClose()
              return
            }
            if (matches.length === 0) return
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setChosen((active + 1) % matches.length)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setChosen((active - 1 + matches.length) % matches.length)
            } else if (event.key === 'Enter' && active >= 0) {
              event.preventDefault()
              const found = matches[active]
              if (found) onOpen(found)
            }
          }}
          className="w-full border-b border-border bg-transparent px-3.5 py-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        {matches.length === 0 ? (
          <p className="px-3.5 py-3 text-xs text-muted-foreground">
            No Session matches. Archived ones are not offered here — the Archived view holds them.
          </p>
        ) : (
          <ul
            id="session-switcher-options"
            role="listbox"
            aria-label="Sessions"
            className="max-h-80 overflow-y-auto py-1"
          >
            {matches.map((session, index) => (
              // The pointer way in, sharing one row with the keyboard's.
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events
              <li
                key={session.id}
                id={`session-switcher-option-${index}`}
                role="option"
                aria-selected={index === active}
                onClick={() => onOpen(session)}
                onMouseMove={() => setChosen(index)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 px-3.5 py-1.5 text-xs',
                  index === active && 'bg-accent'
                )}
              >
                {session.pinned && (
                  <Pin aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                  {folderName(session.projectRoot)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-border px-3.5 py-2 font-mono text-2xs text-muted-foreground">
          ↑↓ choose · ⏎ open · esc close
        </p>
      </div>
    </div>
  )
}
