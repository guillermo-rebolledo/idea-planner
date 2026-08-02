import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  CircleDashed,
  Clock3,
  Inbox,
  MessageSquare,
  PanelLeft,
  Bot,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import type {
  SessionSummary,
  MailboxGroupKey,
  MailboxSession,
  MailboxQuery,
  MailboxSnapshot,
  ThemePreference,
  ThemeState
} from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { Composer } from '@renderer/components/Composer'
import { Conversation } from '@renderer/components/Conversation'
import { Projects } from '@renderer/components/Projects'
import { ReadinessDialog } from '@renderer/components/Readiness'
import { cn } from '@renderer/lib/utils'

interface MailboxProps {
  theme: ThemeState | null
  onThemePreferenceChange: (preference: ThemePreference) => void
}

type CenterSurface =
  /** Home. A new chat, optionally already bound to a Project. */
  | { kind: 'new-chat'; projectRoot?: string }
  | { kind: 'session'; session: SessionSummary }
  | { kind: 'confirm-delete'; session: SessionSummary }

type MailboxData =
  { state: 'reading' } | { state: 'ready'; snapshot: MailboxSnapshot } | { state: 'failed' }

interface GroupMeta {
  label: string
  icon: LucideIcon
  colorClass: string
}

const GROUP_META: Record<MailboxGroupKey, GroupMeta> = {
  pinned: { label: 'Pinned', icon: Pin, colorClass: 'text-primary' },
  'needs-attention': {
    label: 'Needs attention',
    icon: AlertTriangle,
    colorClass: 'text-amber-600 dark:text-amber-400'
  },
  running: { label: 'Running', icon: CircleDashed, colorClass: 'text-sky-600 dark:text-sky-400' },
  recent: { label: 'Recent', icon: Clock3, colorClass: 'text-muted-foreground' },
  archived: { label: 'Archived', icon: Archive, colorClass: 'text-muted-foreground' }
}

/**
 * The Focus Mailbox production frame: a collapsible Session inbox on the left
 * (expanded list or compact rail) and the primary center surface, which this
 * slice uses for starting a Session, reading it, and deleting it.
 */
export function Mailbox({ theme, onThemePreferenceChange }: MailboxProps): React.JSX.Element {
  const [surface, setSurface] = useState<CenterSurface>({ kind: 'new-chat' })
  const [inboxCollapsed, setInboxCollapsed] = useState(false)
  const [readinessOpen, setReadinessOpen] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [query, setQuery] = useState<MailboxQuery>({ search: '', view: 'active' })
  const [mailbox, setMailbox] = useState<MailboxData>({ state: 'reading' })
  // Sessions whose record could not be read. Shown rather than left out: a
  // Session that disappears without a word is the failure the store exists to
  // prevent, and not listing one is only half of not being silent.
  const [damaged, setDamaged] = useState<string[]>([])
  const searchRef = useRef<HTMLInputElement>(null)
  const requestSequenceRef = useRef(0)

  const refreshMailbox = useCallback(async (nextQuery: MailboxQuery) => {
    const requestId = ++requestSequenceRef.current
    try {
      const snapshot = await window.shell.queryMailbox(nextQuery)
      if (requestSequenceRef.current === requestId) setMailbox({ state: 'ready', snapshot })
    } catch {
      if (requestSequenceRef.current === requestId) setMailbox({ state: 'failed' })
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshMailbox(query), query.search ? 120 : 0)
    return () => window.clearTimeout(timer)
  }, [query, refreshMailbox])

  useEffect(() => {
    void window.shell
      .listDamagedSessions()
      .then(setDamaged)
      .catch(() => setDamaged([]))
  }, [mailbox])

  /** Home. Optionally already bound, as the button on a Project row does. */
  const startNewChat = useCallback(
    (projectRoot?: string) => setSurface({ kind: 'new-chat', projectRoot }),
    []
  )

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement
      const typing =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      if (typing || event.metaKey || event.ctrlKey) {
        if (event.key === '\\' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          setInboxCollapsed((collapsed) => !collapsed)
        }
        return
      }
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        startNewChat()
      }
      if (event.key === '/') {
        event.preventDefault()
        setInboxCollapsed(false)
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [startNewChat])

  function handleStarted(session: SessionSummary): void {
    void refreshMailbox(query)
    openSession(session)
    setAnnouncement(`Started “${session.title}”.`)
  }

  function openSession(session: SessionSummary): void {
    setSurface({ kind: 'session', session })
  }

  async function togglePinned(session: SessionSummary): Promise<void> {
    try {
      const updated = await window.shell.setSessionPinned({
        sessionId: session.id,
        pinned: !session.pinned
      })
      setAnnouncement(
        updated.pinned ? `Pinned “${session.title}”.` : `Unpinned “${session.title}”.`
      )
    } catch {
      setAnnouncement(`Could not update the pin on “${session.title}”.`)
    }
    void refreshMailbox(query)
  }

  async function setArchived(session: SessionSummary, archived: boolean): Promise<void> {
    try {
      await window.shell.setSessionArchived({ sessionId: session.id, archived })
      setAnnouncement(
        archived
          ? `Archived “${session.title}”. Nothing about it moves; restore it any time.`
          : `Restored “${session.title}” to the inbox.`
      )
      setSurface((current) =>
        current.kind === 'session' && current.session.id === session.id
          ? { kind: 'new-chat' }
          : current
      )
    } catch {
      setAnnouncement(`Could not ${archived ? 'archive' : 'restore'} “${session.title}”.`)
    }
    void refreshMailbox(query)
  }

  async function confirmDelete(session: SessionSummary): Promise<void> {
    try {
      await window.shell.deleteSession(session.id)
      setAnnouncement(`Deleted “${session.title}”. Your Project was not touched.`)
      setSurface({ kind: 'new-chat' })
    } catch {
      setAnnouncement(`Deleting “${session.title}” failed. Nothing was lost.`)
    }
    void refreshMailbox(query)
  }

  const selectedSession =
    surface.kind === 'session' || surface.kind === 'confirm-delete' ? surface.session : undefined

  const snapshot = mailbox.state === 'ready' ? mailbox.snapshot : null
  const allSessions = snapshot?.groups.flatMap((group) => group.sessions) ?? []

  return (
    <div className="relative flex h-full flex-col">
      <header className="app-drag-region flex h-11 shrink-0 items-center gap-2 border-b border-border pr-3 pl-20">
        <Button
          variant="ghost"
          size="icon"
          aria-label={inboxCollapsed ? 'Expand inbox' : 'Collapse inbox to rail'}
          aria-expanded={!inboxCollapsed}
          onClick={() => setInboxCollapsed((collapsed) => !collapsed)}
        >
          <PanelLeft aria-hidden="true" className="size-4" />
        </Button>
        <h1 className="text-[13px] font-semibold">Sessions</h1>
        <div className="ml-auto flex items-center gap-2">
          <ThemeSelect theme={theme} onChange={onThemePreferenceChange} />
          <Button
            variant="ghost"
            size="sm"
            aria-label="Harnesses"
            onClick={() => setReadinessOpen(true)}
          >
            <Bot aria-hidden="true" className="size-3.5" />
            Harnesses
          </Button>
          <Button onClick={() => startNewChat()} size="sm">
            <Plus aria-hidden="true" className="size-3.5" />
            New chat
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {inboxCollapsed ? (
          <CompactRail
            sessions={allSessions}
            selectedId={selectedSession?.id}
            onOpen={openSession}
            onExpand={() => setInboxCollapsed(false)}
            onNewChat={() => startNewChat()}
          />
        ) : (
          <div className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/40">
            <Projects onNewChat={(root) => startNewChat(root)} />
            <nav aria-label="Session inbox" className="flex min-h-0 flex-1 flex-col">
              {damaged.length > 0 && (
                <p
                  role="status"
                  className="border-b border-notice-border bg-notice px-2 py-1.5 text-[11px] text-notice-foreground"
                >
                  {damaged.length === 1
                    ? '1 Session could not be read and is not listed.'
                    : `${damaged.length} Sessions could not be read and are not listed.`}{' '}
                  Nothing in your Projects was affected.
                </p>
              )}
              <div className="flex flex-col gap-2 border-b border-border p-2">
                <label className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2 focus-within:ring-2 focus-within:ring-ring">
                  <Search aria-hidden="true" className="size-3.5 text-muted-foreground" />
                  <input
                    ref={searchRef}
                    type="search"
                    aria-label="Search Sessions"
                    placeholder="Search Sessions"
                    value={query.search}
                    onChange={(event) =>
                      setQuery((current) => ({ ...current, search: event.target.value }))
                    }
                    className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                  />
                </label>
                <div className="flex items-center gap-1">
                  <div
                    role="group"
                    aria-label="Inbox view"
                    className="flex rounded-md border border-border p-0.5"
                  >
                    <ViewToggle
                      label="Inbox"
                      active={query.view === 'active'}
                      onClick={() => setQuery((current) => ({ ...current, view: 'active' }))}
                    />
                    <ViewToggle
                      label="Archive"
                      active={query.view === 'archived'}
                      onClick={() => setQuery((current) => ({ ...current, view: 'archived' }))}
                    />
                  </div>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto py-2">
                <InboxContent
                  mailbox={mailbox}
                  query={query}
                  selectedId={selectedSession?.id}
                  onOpen={openSession}
                  onNewChat={() => startNewChat()}
                  onClearSearch={() => setQuery((current) => ({ ...current, search: '' }))}
                  onRetry={() => void refreshMailbox(query)}
                  onTogglePinned={(session) => void togglePinned(session)}
                  onSetArchived={(session, archived) => void setArchived(session, archived)}
                  onDelete={(session) => setSurface({ kind: 'confirm-delete', session })}
                />
              </div>
            </nav>
          </div>
        )}

        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {surface.kind === 'confirm-delete' ? (
            <DeleteConfirmSurface
              session={surface.session}
              onCancel={() => setSurface({ kind: 'new-chat' })}
              onConfirm={() => void confirmDelete(surface.session)}
            />
          ) : surface.kind === 'session' ? (
            <SessionDetail
              session={surface.session}
              onTogglePinned={(session) => void togglePinned(session)}
              onSetArchived={(session, archived) => void setArchived(session, archived)}
              onDelete={(session) => setSurface({ kind: 'confirm-delete', session })}
            />
          ) : (
            <Composer
              key={surface.projectRoot ?? 'any-project'}
              boundProjectRoot={surface.projectRoot}
              onStarted={handleStarted}
            />
          )}
        </main>
      </div>

      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>

      {readinessOpen && <ReadinessDialog onClose={() => setReadinessOpen(false)} />}
    </div>
  )
}

interface InboxContentProps {
  mailbox: MailboxData
  query: MailboxQuery
  selectedId: string | undefined
  onOpen: (session: MailboxSession) => void
  onNewChat: () => void
  onClearSearch: () => void
  onRetry: () => void
  onTogglePinned: (session: MailboxSession) => void
  onSetArchived: (session: MailboxSession, archived: boolean) => void
  onDelete: (session: MailboxSession) => void
}

function InboxContent(props: InboxContentProps): React.JSX.Element {
  const { mailbox, query } = props

  if (mailbox.state === 'reading') {
    return (
      <p
        role="status"
        aria-live="polite"
        className="px-4 py-6 text-center text-xs text-muted-foreground"
      >
        Reading your Sessions…
      </p>
    )
  }

  if (mailbox.state === 'failed') {
    return (
      <div role="alert" className="flex flex-col items-center gap-2 px-4 py-6 text-center">
        <p className="text-xs text-muted-foreground">The Session inbox could not be read.</p>
        <Button variant="secondary" size="sm" onClick={props.onRetry}>
          Try again
        </Button>
      </div>
    )
  }

  const { snapshot } = mailbox

  if (snapshot.total === 0) {
    return snapshot.view === 'archived' ? (
      <p className="px-4 py-6 text-center text-xs text-muted-foreground">
        No archived Sessions. Archiving never changes your Project.
      </p>
    ) : (
      <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
        <Inbox aria-hidden="true" className="size-5 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          No Sessions yet. Press <kbd className="font-mono">N</kbd> to start one.
        </p>
        <Button variant="secondary" size="sm" onClick={props.onNewChat}>
          Start a Session
        </Button>
      </div>
    )
  }

  if (snapshot.matched === 0) {
    return (
      <div role="status" className="flex flex-col items-center gap-2 px-4 py-6 text-center">
        <p className="text-xs text-muted-foreground">
          No Sessions match {query.search ? `“${query.search}”` : 'the current filters'}.
        </p>
        <Button variant="secondary" size="sm" onClick={props.onClearSearch}>
          Clear search
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {snapshot.groups.map((group) => (
        <SessionGroup key={group.key} groupKey={group.key} sessions={group.sessions} {...props} />
      ))}
    </div>
  )
}

interface SessionGroupProps extends Omit<InboxContentProps, 'mailbox' | 'query'> {
  groupKey: MailboxGroupKey
  sessions: MailboxSession[]
}

function SessionGroup({ groupKey, sessions, ...props }: SessionGroupProps): React.JSX.Element {
  const meta = GROUP_META[groupKey]
  return (
    <section aria-label={meta.label} className="px-2">
      <h2 className="flex items-center gap-1.5 px-2 pb-1 text-[10px] font-semibold tracking-wide uppercase">
        <meta.icon aria-hidden="true" className={cn('size-3', meta.colorClass)} />
        <span className={meta.colorClass}>{meta.label}</span>
        <span className="text-muted-foreground">{sessions.length}</span>
      </h2>
      {sessions.length === 0 ? (
        <p className="px-2 pb-1 text-[11px] text-muted-foreground italic">
          {groupKey === 'running' ? 'No Runs yet' : 'None'}
        </p>
      ) : (
        <ul className="flex flex-col gap-px">
          {sessions.map((session) => (
            <SessionRow key={session.id} session={session} {...props} />
          ))}
        </ul>
      )}
    </section>
  )
}

interface SessionRowProps extends Omit<SessionGroupProps, 'groupKey' | 'sessions'> {
  session: MailboxSession
}

function SessionRow({ session, selectedId, ...props }: SessionRowProps): React.JSX.Element {
  const archived = session.archivedAt !== null
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => props.onOpen(session)}
        aria-current={selectedId === session.id ? 'true' : undefined}
        className={cn(
          'flex w-full items-center gap-2 rounded-md py-1.5 pr-20 pl-2 text-left transition-colors',
          selectedId === session.id
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        )}
      >
        <MessageSquare aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        {session.dormant && (
          <span className="rounded-sm bg-notice px-1 text-[10px] font-medium text-notice-foreground">
            Dormant
          </span>
        )}
      </button>
      <span className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <RowAction
          label={session.pinned ? `Unpin “${session.title}”` : `Pin “${session.title}”`}
          icon={session.pinned ? PinOff : Pin}
          onClick={() => props.onTogglePinned(session)}
        />
        <RowAction
          label={archived ? `Restore “${session.title}”` : `Archive “${session.title}”`}
          icon={archived ? ArchiveRestore : Archive}
          onClick={() => props.onSetArchived(session, !archived)}
        />
        <RowAction
          label={`Delete “${session.title}” permanently…`}
          icon={Trash2}
          onClick={() => props.onDelete(session)}
        />
      </span>
    </li>
  )
}

function RowAction({
  label,
  icon: Icon,
  onClick
}: {
  label: string
  icon: LucideIcon
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded p-1 text-muted-foreground hover:bg-border hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon aria-hidden="true" className="size-3.5" />
    </button>
  )
}

function ViewToggle({
  label,
  active,
  onClick
}: {
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded px-2 py-0.5 text-xs transition-colors',
        active
          ? 'bg-accent font-medium text-foreground'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {label}
    </button>
  )
}

interface CompactRailProps {
  sessions: MailboxSession[]
  selectedId: string | undefined
  onOpen: (session: MailboxSession) => void
  onExpand: () => void
  onNewChat: () => void
}

/**
 * The collapsed inbox: a narrow rail that keeps every Session reachable
 * without displacing the central Focus Deck.
 */
function CompactRail({
  sessions,
  selectedId,
  onOpen,
  onExpand,
  onNewChat
}: CompactRailProps): React.JSX.Element {
  return (
    <nav
      aria-label="Session inbox (compact)"
      className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border bg-muted/40 py-2"
    >
      <button
        type="button"
        aria-label="New Session"
        title="New Session"
        onClick={onNewChat}
        className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus aria-hidden="true" className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Expand inbox"
        title="Expand inbox"
        onClick={onExpand}
        className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Search aria-hidden="true" className="size-4" />
      </button>
      <div aria-hidden="true" className="my-1 h-px w-6 bg-border" />
      <ul className="flex flex-col items-center gap-1">
        {sessions.map((session) => (
          <li key={session.id} className="relative">
            <button
              type="button"
              aria-label={session.title}
              title={session.title}
              aria-current={selectedId === session.id ? 'true' : undefined}
              onClick={() => onOpen(session)}
              className={cn(
                'rounded-md p-2 transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                selectedId === session.id
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <MessageSquare aria-hidden="true" className="size-3.5 shrink-0" />
            </button>
            {session.pinned && (
              <Pin
                aria-hidden="true"
                className="absolute -top-0.5 -right-0.5 size-2.5 text-primary"
              />
            )}
          </li>
        ))}
      </ul>
    </nav>
  )
}

function DeleteConfirmSurface({
  session,
  onCancel,
  onConfirm
}: {
  session: SessionSummary
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  // Focus lands on the safe action when the destructive surface opens.
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])
  return (
    <section
      aria-labelledby="delete-confirm-title"
      className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6"
    >
      <div>
        <h2 id="delete-confirm-title" className="text-lg font-semibold">
          Delete “{session.title}”?
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This forgets the Session and its Conversation. Your Project is not touched, so everything
          the agent changed stays exactly where it is, under git.
        </p>
      </div>
      <p className="rounded-md border border-border bg-surface p-3 font-mono text-xs break-all text-muted-foreground select-text">
        {session.projectRoot}
      </p>
      <div className="flex items-center gap-2">
        <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          Delete Session
        </Button>
      </div>
    </section>
  )
}

function SessionDetail({
  session,
  onTogglePinned,
  onSetArchived,
  onDelete
}: {
  session: SessionSummary
  onTogglePinned: (session: SessionSummary) => void
  onSetArchived: (session: SessionSummary, archived: boolean) => void
  onDelete: (session: SessionSummary) => void
}): React.JSX.Element {
  const savedAt = new Date(session.updatedAt)
  const archived = session.archivedAt !== null
  return (
    <article className="mx-auto w-full max-w-xl p-6" aria-label={session.title}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          Started on{' '}
          {savedAt.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          })}
        </span>
        {session.pinned && (
          <span className="flex items-center gap-1 text-primary">
            <Pin aria-hidden="true" className="size-3" /> Pinned
          </span>
        )}
        {archived && (
          <span className="flex items-center gap-1">
            <Archive aria-hidden="true" className="size-3" /> Archived
          </span>
        )}
      </div>
      <h2 className="mt-2 text-lg font-semibold select-text">{session.title}</h2>
      {/* The Project this Session works in, named exactly. */}
      <p className="mt-4 rounded-md border border-border bg-surface p-3 font-mono text-xs break-all text-muted-foreground select-text">
        {session.projectRoot}
      </p>
      <Conversation key={session.id} session={session} />
      <div className="mt-4 flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => onTogglePinned(session)}>
          {session.pinned ? (
            <>
              <PinOff aria-hidden="true" className="size-3.5" /> Unpin
            </>
          ) : (
            <>
              <Pin aria-hidden="true" className="size-3.5" /> Pin
            </>
          )}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => onSetArchived(session, !archived)}>
          {archived ? (
            <>
              <ArchiveRestore aria-hidden="true" className="size-3.5" /> Restore
            </>
          ) : (
            <>
              <Archive aria-hidden="true" className="size-3.5" /> Archive
            </>
          )}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => onDelete(session)}>
          <Trash2 aria-hidden="true" className="size-3.5" /> Delete…
        </Button>
      </div>
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
