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
  DeleteSessionPreview,
  DeleteSessionResult,
  SessionSummary,
  MailboxGroupKey,
  MailboxSession,
  MailboxQuery,
  MailboxSnapshot,
  OpenedSession,
  LibrarySnapshot,
  ThemePreference,
  ThemeState
} from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { CaptureForm } from '@renderer/components/CaptureForm'
import { Conversation } from '@renderer/components/Conversation'
import { ReadinessDialog } from '@renderer/components/Readiness'
import { cn } from '@renderer/lib/utils'

interface MailboxProps {
  library: LibrarySnapshot
  onLibraryChanged: (library: LibrarySnapshot) => void
  theme: ThemeState | null
  onThemePreferenceChange: (preference: ThemePreference) => void
}

type CenterSurface =
  | { kind: 'empty' }
  | { kind: 'capture' }
  | { kind: 'opening'; session: SessionSummary }
  | { kind: 'session'; openedSession: OpenedSession }
  | { kind: 'failed'; session: SessionSummary }
  | { kind: 'delete-preview'; session: SessionSummary; preview: DeleteSessionPreview }
  | { kind: 'delete-result'; title: string; relativePath: string; result: DeleteSessionResult }

type MailboxData =
  { state: 'indexing' } | { state: 'ready'; snapshot: MailboxSnapshot } | { state: 'failed' }

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
 * slice uses for capture, reading, and the permanent-delete flow.
 */
export function Mailbox({
  library,
  onLibraryChanged,
  theme,
  onThemePreferenceChange
}: MailboxProps): React.JSX.Element {
  const [surface, setSurface] = useState<CenterSurface>({ kind: 'empty' })
  const [inboxCollapsed, setInboxCollapsed] = useState(false)
  const [readinessOpen, setReadinessOpen] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [query, setQuery] = useState<MailboxQuery>({ search: '', view: 'active' })
  const [mailbox, setMailbox] = useState<MailboxData>({ state: 'indexing' })
  const searchRef = useRef<HTMLInputElement>(null)
  const requestSequenceRef = useRef(0)

  const refreshMailbox = useCallback(async (nextQuery: MailboxQuery) => {
    const requestId = ++requestSequenceRef.current
    try {
      const snapshot = await window.shell.queryMailbox(nextQuery)
      if (requestSequenceRef.current === requestId) {
        setMailbox({ state: 'ready', snapshot })
        if (snapshot.index === 'rebuilt') {
          setAnnouncement('The search index was rebuilt from your canonical Session content.')
        }
      }
    } catch {
      if (requestSequenceRef.current === requestId) setMailbox({ state: 'failed' })
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshMailbox(query), query.search ? 120 : 0)
    return () => window.clearTimeout(timer)
  }, [query, refreshMailbox])

  const startCapture = useCallback(() => setSurface({ kind: 'capture' }), [])

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
        startCapture()
      }
      if (event.key === '/') {
        event.preventDefault()
        setInboxCollapsed(false)
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [startCapture])

  function handleSaved(session: SessionSummary): void {
    onLibraryChanged({ ...library, sessions: [session, ...library.sessions] })
    void refreshMailbox(query)
    void openSession(session)
    setAnnouncement(`Saved “${session.title}” for later.`)
  }

  async function openSession(session: SessionSummary): Promise<void> {
    setSurface({ kind: 'opening', session })
    try {
      const openedSession = await window.shell.openSession(session.relativePath)
      setSurface({ kind: 'session', openedSession })
    } catch {
      setSurface({ kind: 'failed', session })
    }
  }

  async function togglePinned(session: SessionSummary): Promise<void> {
    try {
      const updated = await window.shell.setSessionPinned({
        relativePath: session.relativePath,
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
      await window.shell.setSessionArchived({ relativePath: session.relativePath, archived })
      setAnnouncement(
        archived
          ? `Archived “${session.title}”. Nothing moved on disk; restore it any time.`
          : `Restored “${session.title}” to the inbox.`
      )
      setSurface((current) =>
        (current.kind === 'session' &&
          current.openedSession.session.relativePath === session.relativePath) ||
        (current.kind === 'opening' && current.session.relativePath === session.relativePath)
          ? { kind: 'empty' }
          : current
      )
    } catch {
      setAnnouncement(`Could not ${archived ? 'archive' : 'restore'} “${session.title}”.`)
    }
    void refreshMailbox(query)
  }

  async function startDelete(session: SessionSummary): Promise<void> {
    try {
      const preview = await window.shell.previewDeleteSession(session.relativePath)
      setSurface({ kind: 'delete-preview', session, preview })
    } catch {
      setAnnouncement(`Could not prepare “${session.title}” for deletion.`)
    }
  }

  // Delete acts on the exact targets the person confirmed in the preview, so
  // a retry after a partial failure finishes only what is still in place.
  async function confirmDelete(
    title: string,
    relativePath: string,
    targets: string[]
  ): Promise<void> {
    try {
      const result = await window.shell.deleteSessionPermanently({ relativePath, targets })
      void refreshMailbox(query)
      if (result.failed.length > 0) {
        setAnnouncement(`Some of “${title}” could not be moved to the Trash.`)
        setSurface({ kind: 'delete-result', title, relativePath, result })
      } else {
        setAnnouncement(`Moved “${title}” to the Trash.`)
        setSurface({ kind: 'empty' })
      }
    } catch {
      setAnnouncement(`Deleting “${title}” failed. Nothing further was moved.`)
      void refreshMailbox(query)
    }
  }

  const selectedSession =
    surface.kind === 'session'
      ? surface.openedSession.session
      : surface.kind === 'opening' || surface.kind === 'failed' || surface.kind === 'delete-preview'
        ? surface.session
        : undefined

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
          <Button onClick={startCapture} size="sm">
            <Plus aria-hidden="true" className="size-3.5" />
            New Session
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {inboxCollapsed ? (
          <CompactRail
            sessions={allSessions}
            selectedId={selectedSession?.id}
            onOpen={(session) => void openSession(session)}
            onExpand={() => setInboxCollapsed(false)}
            onCapture={startCapture}
          />
        ) : (
          <nav
            aria-label="Session inbox"
            className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/40"
          >
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
                onOpen={(session) => void openSession(session)}
                onCapture={startCapture}
                onClearSearch={() => setQuery((current) => ({ ...current, search: '' }))}
                onRetry={() => void refreshMailbox(query)}
                onTogglePinned={(session) => void togglePinned(session)}
                onSetArchived={(session, archived) => void setArchived(session, archived)}
                onDelete={(session) => void startDelete(session)}
              />
            </div>
          </nav>
        )}

        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {surface.kind === 'capture' ? (
            <CaptureForm
              onSaved={handleSaved}
              onCancel={() => setSurface({ kind: 'empty' })}
              onShowReadiness={() => setReadinessOpen(true)}
            />
          ) : surface.kind === 'opening' ? (
            <SessionOpening title={surface.session.title} />
          ) : surface.kind === 'failed' ? (
            <CenterNotice
              title={`“${surface.session.title}” could not be opened`}
              body="The app could not finish reading local content. The Session was not classified as corrupt."
              actionLabel="Try again"
              onAction={() => void openSession(surface.session)}
            />
          ) : surface.kind === 'delete-preview' ? (
            <DeletePreviewSurface
              preview={surface.preview}
              onCancel={() => setSurface({ kind: 'empty' })}
              onConfirm={() =>
                void confirmDelete(
                  surface.preview.title,
                  surface.preview.relativePath,
                  surface.preview.targets
                )
              }
            />
          ) : surface.kind === 'delete-result' ? (
            <DeleteResultSurface
              title={surface.title}
              result={surface.result}
              onRetry={() =>
                void confirmDelete(
                  surface.title,
                  surface.relativePath,
                  surface.result.failed.map((failure) => failure.path)
                )
              }
              onClose={() => setSurface({ kind: 'empty' })}
            />
          ) : surface.kind === 'session' ? (
            <SessionDetail
              openedSession={surface.openedSession}
              onTogglePinned={(session) => void togglePinned(session)}
              onSetArchived={(session, archived) => void setArchived(session, archived)}
              onDelete={(session) => void startDelete(session)}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <MessageSquare aria-hidden="true" className="size-6 text-muted-foreground" />
              <div>
                <p className="font-medium">Start a Session before the thought fades</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Press <kbd className="rounded border border-border px-1 font-mono">N</kbd> or use
                  New Session. Saving never starts a Run.
                </p>
              </div>
            </div>
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
  onCapture: () => void
  onClearSearch: () => void
  onRetry: () => void
  onTogglePinned: (session: MailboxSession) => void
  onSetArchived: (session: MailboxSession, archived: boolean) => void
  onDelete: (session: MailboxSession) => void
}

function InboxContent(props: InboxContentProps): React.JSX.Element {
  const { mailbox, query } = props

  if (mailbox.state === 'indexing') {
    return (
      <p
        role="status"
        aria-live="polite"
        className="px-4 py-6 text-center text-xs text-muted-foreground"
      >
        Indexing Sessions from local content…
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
        No archived Sessions. Archiving keeps every file in place.
      </p>
    ) : (
      <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
        <Inbox aria-hidden="true" className="size-5 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          No Sessions yet. Press <kbd className="font-mono">N</kbd> to start one.
        </p>
        <Button variant="secondary" size="sm" onClick={props.onCapture}>
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
  onCapture: () => void
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
  onCapture
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
        onClick={onCapture}
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

function SessionOpening({ title }: { title: string }): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center p-8" role="status" aria-live="polite">
      <p className="text-sm text-muted-foreground">Opening “{title}” from local content…</p>
    </div>
  )
}

function CenterNotice({
  title,
  body,
  actionLabel,
  onAction
}: {
  title: string
  body: string
  actionLabel: string
  onAction: () => void
}): React.JSX.Element {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
      role="alert"
    >
      <div>
        <h2 className="font-semibold">{title}</h2>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
      </div>
      <Button variant="secondary" onClick={onAction}>
        {actionLabel}
      </Button>
    </div>
  )
}

function DeletePreviewSurface({
  preview,
  onCancel,
  onConfirm
}: {
  preview: DeleteSessionPreview
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  // Focus lands on the safe action when the destructive preview opens.
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])
  return (
    <section
      aria-labelledby="delete-preview-title"
      className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6"
    >
      <div>
        <h2 id="delete-preview-title" className="text-lg font-semibold">
          Delete “{preview.title}” permanently?
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Exactly these app-owned items move to the macOS Trash. Nothing else in your library is
          touched, and you can put them back from the Trash.
        </p>
      </div>
      <ul
        aria-label="Items that move to the Trash"
        className="flex flex-col gap-1 rounded-md border border-border bg-surface p-3 font-mono text-xs"
      >
        {preview.targets.map((target) => (
          <li key={target} className="break-all select-text">
            {target}
          </li>
        ))}
      </ul>
      {preview.keeps.length > 0 && (
        <div className="rounded-md border border-notice-border bg-notice p-3 text-xs text-notice-foreground">
          <p className="font-medium">Kept in place — not created by this app:</p>
          <ul aria-label="Items kept in place" className="mt-1 flex flex-col gap-1 font-mono">
            {preview.keeps.map((keep) => (
              <li key={keep} className="break-all select-text">
                {keep}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          Move to Trash
        </Button>
      </div>
    </section>
  )
}

function DeleteResultSurface({
  title,
  result,
  onRetry,
  onClose
}: {
  title: string
  result: DeleteSessionResult
  onRetry: () => void
  onClose: () => void
}): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
  }, [])
  return (
    <section
      role="alert"
      aria-labelledby="delete-result-title"
      className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6"
    >
      <div>
        <h2 id="delete-result-title" className="text-lg font-semibold">
          Some of “{title}” is still in place
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {result.trashed.length} item{result.trashed.length === 1 ? '' : 's'} moved to the Trash,
          but these could not be moved:
        </p>
      </div>
      <ul
        aria-label="Items that could not be moved to the Trash"
        className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3 text-xs"
      >
        {result.failed.map((failure) => (
          <li key={failure.path} className="select-text">
            <span className="font-mono break-all">{failure.path}</span>
            <span className="mt-0.5 block text-muted-foreground">{failure.message}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <Button ref={closeRef} variant="secondary" onClick={onClose}>
          Close
        </Button>
        <Button variant="secondary" onClick={onRetry}>
          Try the remaining items again
        </Button>
      </div>
    </section>
  )
}

function SessionDetail({
  openedSession,
  onTogglePinned,
  onSetArchived,
  onDelete
}: {
  openedSession: OpenedSession
  onTogglePinned: (session: SessionSummary) => void
  onSetArchived: (session: SessionSummary, archived: boolean) => void
  onDelete: (session: SessionSummary) => void
}): React.JSX.Element {
  const session = openedSession.session
  const savedAt = new Date(session.updatedAt)
  const archived = session.archivedAt !== null
  return (
    <article className="mx-auto w-full max-w-xl p-6" aria-label={session.title}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          Saved for later on{' '}
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
      <p className="mt-4 rounded-md border border-border bg-surface p-3 font-mono text-xs break-all text-muted-foreground select-text">
        {openedSession.documents.root.path}
      </p>
      <Conversation key={session.relativePath} session={session} />
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
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        This Session is plain Markdown inside your library. Developing it with a Harness is always a
        separate, explicit step you start yourself.
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
