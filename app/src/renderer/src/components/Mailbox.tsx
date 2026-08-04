import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Archive,
  Circle,
  CircleDashed,
  CircleSlash,
  FolderGit2,
  Inbox,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  X,
  type LucideIcon
} from 'lucide-react'
import type {
  MailboxProject,
  MailboxQuery,
  MailboxSession,
  MailboxSnapshot,
  SessionStatus,
  SessionSummary,
  StartSessionResult,
  ThemePreference,
  ThemeState
} from '@shared/contract'
import { AppMenu } from '@renderer/components/AppMenu'
import { Button } from '@renderer/components/ui/button'
import { Composer } from '@renderer/components/Composer'
import { Conversation } from '@renderer/components/Conversation'
import { Modal } from '@renderer/components/ui/dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger
} from '@renderer/components/ui/menu'
import { ReadinessDialog } from '@renderer/components/Readiness'
import { SessionSwitcher } from '@renderer/components/SessionSwitcher'
import { FilesPanel } from '@renderer/components/FilesPanel'
import { WhereAmI } from '@renderer/components/WhereAmI'
import { useSessionChanges } from '@renderer/lib/useSessionChanges'
import { cn } from '@renderer/lib/utils'

interface MailboxProps {
  theme: ThemeState | null
  onThemePreferenceChange: (preference: ThemePreference) => void
}

type CenterSurface =
  /** Home. A new chat, optionally already bound to a Project. */
  { kind: 'new-chat'; projectRoot?: string } | { kind: 'session'; session: SessionSummary }

type MailboxData =
  { state: 'reading' } | { state: 'ready'; snapshot: MailboxSnapshot } | { state: 'failed' }

/** What the rail asks for: every active Session, narrowed by nothing. */
const RAIL_QUERY: MailboxQuery = { search: '', view: 'active' }

/** The hover-revealed icon actions sharing a row with what they act on. */
const QUICK_ACTION_CLASS =
  'rounded p-1 text-muted-foreground hover:bg-border hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring'

/** The last segment of a Project root: how the person knows the folder. */
function folderName(root: string): string {
  return root.split('/').filter(Boolean).at(-1) ?? root
}

/**
 * Whether ⌘Z belongs to the focused element rather than to the inbox. A field
 * holding text owns its undo; an empty one — the composer at rest, where
 * focus usually lives — has nothing to take back, so the shortcut is free to
 * honor the promise the archive announcement just made.
 */
function ownsUndo(target: Element | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return target.value.length > 0
  }
  return target instanceof HTMLElement && target.isContentEditable
}

/**
 * The production frame: a collapsible Project-grouped sidebar on the left
 * (expanded list or compact rail), the app menu in its footer, and the
 * primary center surface for starting and reading Sessions.
 */
export function Mailbox({ theme, onThemePreferenceChange }: MailboxProps): React.JSX.Element {
  const [surface, setSurface] = useState<CenterSurface>({ kind: 'new-chat' })
  const [inboxCollapsed, setInboxCollapsed] = useState(false)
  const [readinessOpen, setReadinessOpen] = useState(false)
  // What just happened, said once for everyone: the strip below renders it
  // visibly and is itself the polite live region, so a failed action never
  // reads as an ignored click and the ⌘Z hint is discoverable by sight.
  // `at` retriggers the auto-hide when the same words are said again.
  const [notice, setNotice] = useState<{ text: string; undoable: boolean; at: number } | null>(null)
  const setAnnouncement = useCallback(
    (text: string, undoable = false) => setNotice({ text, undoable, at: Date.now() }),
    []
  )
  // Long enough to read and reach the Undo, short enough to never be chrome.
  useEffect(() => {
    if (notice === null) return
    const timer = window.setTimeout(() => setNotice(null), 6_000)
    return () => window.clearTimeout(timer)
  }, [notice])
  const [query, setQuery] = useState<MailboxQuery>({ search: '', view: 'active' })
  const [mailbox, setMailbox] = useState<MailboxData>({ state: 'reading' })
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  // ⌘K's palette, holding a fresh unfiltered list: the sidebar's search must
  // not silently narrow what the switcher can reach.
  const [switcher, setSwitcher] = useState<SessionSummary[] | null>(null)
  // The Files panel: toggled from the title-bar diff numbers, and the app's
  // only diff surface. Which file is open inside it is per visit, not stored.
  const [filesOpen, setFilesOpen] = useState(false)
  const [focusedFile, setFocusedFile] = useState<string | null>(null)
  // Sessions whose record could not be read. Shown rather than left out: a
  // Session that disappears without a word is the failure the store exists to
  // prevent, and not listing one is only half of not being silent.
  const [damaged, setDamaged] = useState<string[]>([])
  const searchRef = useRef<HTMLInputElement>(null)
  const requestSequenceRef = useRef(0)
  // The one archive ⌘Z takes back. An action, not a stack: the promise the
  // shortcut makes is "undo what I just did".
  const lastArchivedRef = useRef<SessionSummary | null>(null)

  // Collapsing hides the filters, so it also drops them: a rail narrowed by a
  // search nobody can see would answer "is anything waiting for me, anywhere"
  // with a list that leaves things out.
  const effectiveQuery = useMemo(
    () => (inboxCollapsed ? RAIL_QUERY : query),
    [inboxCollapsed, query]
  )

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
    const timer = window.setTimeout(
      () => void refreshMailbox(effectiveQuery),
      effectiveQuery.search ? 120 : 0
    )
    return () => window.clearTimeout(timer)
  }, [effectiveQuery, refreshMailbox])

  // A Session's status is derived from its Conversation, so the inbox is only
  // as true as the last time it read one. Anything that happens in a
  // Conversation is exactly what can change the dot on a row.
  useEffect(() => {
    let timer = 0
    const stop = window.shell.onConversationEvent(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void refreshMailbox(effectiveQuery), 150)
    })
    return () => {
      window.clearTimeout(timer)
      stop()
    }
  }, [effectiveQuery, refreshMailbox])

  useEffect(() => {
    void window.shell
      .listDamagedSessions()
      .then(setDamaged)
      .catch(() => setDamaged([]))
  }, [mailbox])

  /** Home. Optionally already bound, as a Project header's plus does. */
  const startNewChat = useCallback(
    (projectRoot?: string) => setSurface({ kind: 'new-chat', projectRoot }),
    []
  )

  function openSession(session: SessionSummary): void {
    // A fresh visit starts at the list, not wherever the last one left off.
    setFocusedFile(null)
    setSurface({ kind: 'session', session })
  }

  const togglePinned = useCallback(
    async (session: SessionSummary): Promise<void> => {
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
      void refreshMailbox(effectiveQuery)
    },
    [effectiveQuery, refreshMailbox, setAnnouncement]
  )

  const setArchived = useCallback(
    async (session: SessionSummary, archived: boolean): Promise<void> => {
      try {
        await window.shell.setSessionArchived({ sessionId: session.id, archived })
        if (archived) {
          lastArchivedRef.current = session
          setAnnouncement(`Archived “${session.title}”. Press ⌘Z to undo.`, true)
        } else {
          if (lastArchivedRef.current?.id === session.id) lastArchivedRef.current = null
          setAnnouncement(`Restored “${session.title}” to the inbox.`)
        }
        setSurface((current) =>
          archived && current.kind === 'session' && current.session.id === session.id
            ? { kind: 'new-chat' }
            : current
        )
      } catch {
        setAnnouncement(`Could not ${archived ? 'archive' : 'restore'} “${session.title}”.`)
      }
      void refreshMailbox(effectiveQuery)
    },
    [effectiveQuery, refreshMailbox, setAnnouncement]
  )

  const undoArchive = useCallback((): void => {
    const undone = lastArchivedRef.current
    if (undone) void setArchived(undone, false)
  }, [setArchived])

  const renameTo = useCallback(
    async (session: SessionSummary, title: string): Promise<void> => {
      setRenaming(null)
      const trimmed = title.trim()
      if (trimmed.length === 0 || trimmed === session.title) return
      try {
        const renamed = await window.shell.renameSession({ sessionId: session.id, title: trimmed })
        setAnnouncement(`Renamed to “${renamed.title}”.`)
        setSurface((current) =>
          current.kind === 'session' && current.session.id === session.id
            ? { kind: 'session', session: renamed }
            : current
        )
      } catch {
        setAnnouncement(`Could not rename “${session.title}”.`)
      }
      void refreshMailbox(effectiveQuery)
    },
    [effectiveQuery, refreshMailbox, setAnnouncement]
  )

  async function confirmDelete(session: SessionSummary): Promise<void> {
    setDeleting(null)
    try {
      await window.shell.deleteSession(session.id)
      setAnnouncement(`Deleted “${session.title}”. Your Project was not touched.`)
      setSurface((current) =>
        current.kind === 'session' && current.session.id === session.id
          ? { kind: 'new-chat' }
          : current
      )
    } catch {
      setAnnouncement(`Deleting “${session.title}” failed. Nothing was lost.`)
    }
    void refreshMailbox(effectiveQuery)
  }

  const selectedSession = surface.kind === 'session' ? surface.session : undefined
  // Session-cumulative and live: the same numbers the title bar wears and the
  // Files panel breaks down, from one read so they cannot disagree.
  const changes = useSessionChanges(selectedSession?.id ?? null)

  // What the announcement subscription below needs to know without
  // resubscribing on every render: who is on screen, and what everything is
  // called. Refs, because the subscription outlives both.
  const selectedIdRef = useRef<string | undefined>(undefined)
  const titlesRef = useRef(new Map<string, string>())
  const announcedRunsRef = useRef(new Set<string>())
  useEffect(() => {
    selectedIdRef.current = selectedSession?.id
  }, [selectedSession?.id])
  useEffect(() => {
    if (mailbox.state !== 'ready') return
    const titles = new Map<string, string>()
    for (const group of [...mailbox.snapshot.pinned, ...mailbox.snapshot.projects]) {
      for (const session of group.sessions) titles.set(session.id, session.title)
    }
    titlesRef.current = titles
  }, [mailbox])

  // A Run ending — or stopping to ask permission — is said out loud, so the
  // outcome strip and a screen reader hear the mail arrive. A finished Run is
  // announced even for the Session on screen: its only visible trace is a
  // quiet divider, and someone who sent a message must not have to re-read
  // the transcript to learn it was answered. Failures and approvals in the
  // open Session already speak for themselves — the error line and the
  // approval card are alerts of their own, and saying them twice says less.
  useEffect(
    () =>
      window.shell.onConversationEvent(({ sessionId, runId, event }) => {
        if (
          event.type !== 'completed' &&
          event.type !== 'failed' &&
          event.type !== 'approval-request'
        ) {
          return
        }
        const onScreen = sessionId === selectedIdRef.current
        if (onScreen && event.type !== 'completed') return
        const key = event.type === 'approval-request' ? `${runId}:${event.id}` : runId
        if (announcedRunsRef.current.has(key)) return
        announcedRunsRef.current.add(key)
        const title = titlesRef.current.get(sessionId) ?? 'another Session'
        setAnnouncement(
          event.type === 'completed'
            ? onScreen
              ? 'The Run finished.'
              : `The Run in “${title}” finished.`
            : event.type === 'failed'
              ? `The Run in “${title}” failed.`
              : `“${title}” is waiting for your approval.`
        )
      }),
    [setAnnouncement]
  )

  // The click on a native notification: Main asks for one Session by id, and
  // the freshest record of it is fetched rather than trusted from memory.
  useEffect(
    () =>
      window.shell.onOpenSessionRequest((sessionId) => {
        void window.shell.listSessions().then((listed) => {
          const found = listed.find((session) => session.id === sessionId)
          if (!found) return
          setFocusedFile(null)
          setSurface({ kind: 'session', session: found })
        }, undefined)
      }),
    []
  )

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement
      const typing =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      if (event.metaKey || event.ctrlKey) {
        if (event.key === '\\') {
          event.preventDefault()
          setInboxCollapsed((collapsed) => !collapsed)
        }
        // ⌘K works from anywhere, mid-typing included: going somewhere else
        // is exactly what someone mid-thought reaches for.
        if (event.key.toLowerCase() === 'k' && !event.shiftKey) {
          event.preventDefault()
          void window.shell.listSessions().then(setSwitcher, () => undefined)
        }
        if (event.shiftKey && event.key.toLowerCase() === 'p' && selectedSession) {
          event.preventDefault()
          void togglePinned(selectedSession)
        }
        // Ordinarily the application menu's Undo consumes ⌘Z before the page
        // sees it and Main forwards it instead (onUndoShortcut); this branch
        // catches the same key when it does arrive — synthesized input, or a
        // build without the menu. Undoing twice is a no-op, so both paths may
        // safely exist.
        if (event.key.toLowerCase() === 'z' && !event.shiftKey && !ownsUndo(target)) {
          undoArchive()
        }
        if (typing) return
        if (event.key === 'Backspace' && selectedSession) {
          event.preventDefault()
          void setArchived(selectedSession, selectedSession.archivedAt === null)
        }
        return
      }
      if (typing) return
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
  }, [startNewChat, selectedSession, togglePinned, setArchived, undoArchive])

  // ⌘Z arrives from Main — the menu's Undo owns the key itself. A field
  // holding text keeps its own undo; anywhere else the inbox's applies.
  useEffect(() => {
    return window.shell.onUndoShortcut(() => {
      if (!ownsUndo(document.activeElement)) undoArchive()
    })
  }, [undoArchive])

  function handleStarted({ session, runStarted }: StartSessionResult): void {
    void refreshMailbox(effectiveQuery)
    openSession(session)
    // Sending starts the work, so the announcement says whether it did. A
    // Session whose first Run never started is a real Session holding a real
    // message, and the one thing it needs is for somebody to know that.
    setAnnouncement(
      runStarted
        ? `Started “${session.title}”.`
        : `Created “${session.title}”, but its first Run did not start. Your message is kept — send it again from the Session.`
    )
  }

  const snapshot = mailbox.state === 'ready' ? mailbox.snapshot : null
  const allSessions =
    snapshot === null
      ? []
      : [...snapshot.pinned, ...snapshot.projects].flatMap((group) => group.sessions)

  const rowHandlers: RowHandlers = {
    selectedId: selectedSession?.id,
    renamingId: renaming,
    onOpen: openSession,
    onTogglePinned: (session) => void togglePinned(session),
    onSetArchived: (session, archived) => void setArchived(session, archived),
    // Deferred past the closing menu's focus restoration, which would
    // otherwise blur — and thereby cancel — the rename it just asked for.
    onRename: (session) => window.setTimeout(() => setRenaming(session.id), 0),
    onRenameTo: (session, title) => void renameTo(session, title),
    onRenameCancel: () => setRenaming(null),
    onDelete: setDeleting
  }

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
        <h1 className="min-w-0 truncate text-base font-medium">
          {selectedSession?.title ?? 'Sessions'}
        </h1>
        {selectedSession && (
          <div className="ml-auto">
            <WhereAmI
              key={selectedSession.id}
              session={selectedSession}
              totals={changes.totals}
              filesOpen={filesOpen}
              onToggleFiles={() => setFilesOpen((open) => !open)}
              onShowFiles={() => setFilesOpen(true)}
              onAnnounce={setAnnouncement}
            />
          </div>
        )}
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
            <nav aria-label="Session inbox" className="flex min-h-0 flex-1 flex-col">
              {damaged.length > 0 && (
                <p
                  role="status"
                  className="border-b border-notice-border bg-notice px-2 py-1.5 text-xs text-notice-foreground"
                >
                  {damaged.length === 1
                    ? '1 Session could not be read and is not listed.'
                    : `${damaged.length} Sessions could not be read and are not listed.`}{' '}
                  Nothing in your Projects was affected.
                </p>
              )}
              <div className="flex flex-col gap-1.5 p-2">
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
                <button
                  type="button"
                  onClick={() => startNewChat()}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Plus aria-hidden="true" className="size-3.5" />
                  New Session
                  <span
                    aria-hidden="true"
                    className="ml-auto font-mono text-2xs text-muted-foreground"
                  >
                    N
                  </span>
                </button>
              </div>

              {query.view === 'archived' && (
                <div className="flex items-center gap-1.5 border-y border-border px-3 py-1.5">
                  <Archive aria-hidden="true" className="size-3.5 text-muted-foreground" />
                  <h2 className="text-xs font-medium">Archived Sessions</h2>
                  <button
                    type="button"
                    aria-label="Back to the inbox"
                    title="Back to the inbox"
                    onClick={() => setQuery((current) => ({ ...current, view: 'active' }))}
                    className="ml-auto rounded p-1 text-muted-foreground hover:bg-border hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X aria-hidden="true" className="size-3.5" />
                  </button>
                </div>
              )}

              <div className="min-h-0 flex-1 overflow-y-auto py-1">
                <InboxContent
                  mailbox={mailbox}
                  query={query}
                  handlers={rowHandlers}
                  onNewChat={startNewChat}
                  onClearSearch={() => setQuery((current) => ({ ...current, search: '' }))}
                  onRetry={() => void refreshMailbox(effectiveQuery)}
                  onAnnounce={setAnnouncement}
                  onProjectsChanged={() => void refreshMailbox(effectiveQuery)}
                />
              </div>
            </nav>
            <AppMenu
              theme={theme}
              onThemeChange={onThemePreferenceChange}
              archivedTotal={snapshot?.archivedTotal ?? null}
              onShowArchived={() => setQuery((current) => ({ ...current, view: 'archived' }))}
              onOpenHarnesses={() => setReadinessOpen(true)}
              onGoToSession={() =>
                void window.shell.listSessions().then(setSwitcher, () => undefined)
              }
              onProjectsChanged={() => void refreshMailbox(effectiveQuery)}
              onAnnounce={setAnnouncement}
            />
          </div>
        )}

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {surface.kind === 'session' ? (
            <Conversation
              key={surface.session.id}
              session={surface.session}
              onOpenFile={(path) => {
                setFilesOpen(true)
                setFocusedFile(path)
              }}
            />
          ) : (
            <Composer
              key={surface.projectRoot ?? 'any-project'}
              boundProjectRoot={surface.projectRoot}
              onStarted={handleStarted}
              onOpenSession={openSession}
            />
          )}
        </main>

        {selectedSession && filesOpen && (
          <FilesPanel
            changes={changes}
            focusedPath={focusedFile}
            onFocus={setFocusedFile}
            onClose={() => setFilesOpen(false)}
          />
        )}
      </div>

      {/* The outcome strip: one quiet pill saying what just happened, for
          eyes and screen readers alike. It floats over the composer for a
          moment and leaves; the archive one carries its own way back. */}
      <div
        aria-live="polite"
        role="status"
        className="pointer-events-none absolute inset-x-0 bottom-5 z-40 flex justify-center"
      >
        {notice && (
          <div
            className={cn(
              'pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-surface-raised py-1.5 text-xs shadow-md',
              notice.undoable ? 'pr-1.5 pl-3.5' : 'px-3.5'
            )}
          >
            <span className="max-w-md truncate">{notice.text}</span>
            {notice.undoable && (
              <Button
                size="sm"
                variant="secondary"
                className="rounded-full"
                onClick={() => {
                  undoArchive()
                  setNotice(null)
                }}
              >
                Undo
              </Button>
            )}
          </div>
        )}
      </div>

      {deleting && (
        <DeleteConfirmDialog
          session={deleting}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void confirmDelete(deleting)}
        />
      )}

      {readinessOpen && <ReadinessDialog onClose={() => setReadinessOpen(false)} />}
      {switcher !== null && (
        <SessionSwitcher
          sessions={switcher}
          onClose={() => setSwitcher(null)}
          onOpen={(session) => {
            setSwitcher(null)
            openSession(session)
          }}
        />
      )}
    </div>
  )
}

/** Everything a Session row can do, passed as one piece. */
interface RowHandlers {
  selectedId: string | undefined
  renamingId: string | null
  onOpen: (session: MailboxSession) => void
  onTogglePinned: (session: MailboxSession) => void
  onSetArchived: (session: MailboxSession, archived: boolean) => void
  onRename: (session: MailboxSession) => void
  onRenameTo: (session: MailboxSession, title: string) => void
  onRenameCancel: () => void
  onDelete: (session: MailboxSession) => void
}

interface InboxContentProps {
  mailbox: MailboxData
  query: MailboxQuery
  handlers: RowHandlers
  onNewChat: (projectRoot?: string) => void
  onClearSearch: () => void
  onRetry: () => void
  onAnnounce: (text: string) => void
  onProjectsChanged: () => void
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

  // An empty mailbox says so even when Projects are already listed below:
  // the groups explain where Sessions would go, not that none exist.
  const emptyHint =
    snapshot.view === 'active' && snapshot.total === 0 ? (
      <div className="flex flex-col items-center gap-2 px-4 py-4 text-center">
        <Inbox aria-hidden="true" className="size-5 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          No Sessions yet. Press <kbd className="font-mono">N</kbd> to start one.
        </p>
        <Button variant="secondary" size="sm" onClick={() => props.onNewChat()}>
          Start a Session
        </Button>
      </div>
    ) : null

  if (query.search && snapshot.matched === 0) {
    return (
      <div role="status" className="flex flex-col items-center gap-2 px-4 py-6 text-center">
        <p className="text-xs text-muted-foreground">No Sessions match “{query.search}”.</p>
        <Button variant="secondary" size="sm" onClick={props.onClearSearch}>
          Clear search
        </Button>
      </div>
    )
  }

  // While searching, a Project with nothing to show is noise; at rest it is
  // still somewhere to start a Session, so it stays.
  const searching = query.search.trim().length > 0
  const projects = searching
    ? snapshot.projects.filter((group) => group.sessions.length > 0)
    : snapshot.projects

  if (snapshot.view === 'archived') {
    return (
      <section aria-label="Archived" className="px-2">
        {projects.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">
            No archived Sessions. Archiving never changes your Project.
          </p>
        ) : (
          projects.map((group) => (
            <ProjectGroup key={group.root} group={group} archived {...props} />
          ))
        )}
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {emptyHint}
      {snapshot.pinned.length > 0 && (
        <section aria-label="Pinned" className="px-2">
          <h2 className="px-2 pt-1 pb-0.5 font-mono text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            Pinned
          </h2>
          {snapshot.pinned.map((group) => (
            <ProjectGroup key={group.root} group={group} plainHeader {...props} />
          ))}
        </section>
      )}
      <section aria-label="Projects" className="px-2">
        <h2 className="px-2 pt-1 pb-0.5 font-mono text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          Projects
        </h2>
        {projects.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground italic">
            No Projects yet. Add one from the menu below.
          </p>
        ) : (
          projects.map((group) => <ProjectGroup key={group.root} group={group} {...props} />)
        )}
      </section>
    </div>
  )
}

interface ProjectGroupProps extends Omit<InboxContentProps, 'mailbox' | 'query'> {
  group: MailboxProject
  /** True in the archived view, where rows dim and offer Restore. */
  archived?: boolean
  /** True under Pinned, where the header only names the Project. */
  plainHeader?: boolean
}

function ProjectGroup({
  group,
  archived = false,
  plainHeader = false,
  handlers,
  onNewChat,
  onAnnounce,
  onProjectsChanged
}: ProjectGroupProps): React.JSX.Element {
  // One un-confirmed menu click used to remove a Project; a confirm brings it
  // in line with every other act that changes what the inbox offers. Removal
  // is gentle — Sessions keep an (unavailable) home and disk is untouched —
  // but the person deserves to read that before it happens, not after.
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  async function removeProject(): Promise<void> {
    setConfirmingRemove(false)
    try {
      await window.shell.removeProject(group.root)
      onAnnounce(`Removed “${group.name}”. Nothing on disk was touched.`)
    } catch {
      onAnnounce(`Could not remove “${group.name}”.`)
    }
    onProjectsChanged()
  }

  return (
    <section aria-label={group.name}>
      <div className="group/project relative">
        <div
          title={group.root}
          className="flex items-center gap-1.5 rounded-md py-1 pr-14 pl-2 text-xs text-foreground"
        >
          <FolderGit2 aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{group.name}</span>
          {!group.available && (
            <span className="flex shrink-0 items-center gap-1 rounded-sm bg-notice px-1 text-2xs font-medium text-notice-foreground">
              <AlertTriangle aria-hidden="true" className="size-2.5" />
              Unavailable
            </span>
          )}
        </div>
        {!plainHeader && !archived && (
          <span className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/project:opacity-100 group-hover/project:opacity-100">
            {group.available && (
              <button
                type="button"
                aria-label={`New Session in “${group.name}”`}
                title={`New Session in “${group.name}”`}
                onClick={() => onNewChat(group.root)}
                className={QUICK_ACTION_CLASS}
              >
                <Plus aria-hidden="true" className="size-3.5" />
              </button>
            )}
            <Menu>
              <MenuTrigger aria-label={`More for “${group.name}”`} className={QUICK_ACTION_CLASS}>
                <MoreHorizontal aria-hidden="true" className="size-3.5" />
              </MenuTrigger>
              <MenuContent>
                {/* Deferred past the closing menu's focus restoration, which
                    would otherwise land focus behind the dialog it opens. */}
                <MenuItem onClick={() => window.setTimeout(() => setConfirmingRemove(true), 0)}>
                  <X aria-hidden="true" className="size-3.5 text-muted-foreground" />
                  Remove Project…
                </MenuItem>
              </MenuContent>
            </Menu>
          </span>
        )}
      </div>
      {confirmingRemove && (
        <Modal labelledBy="remove-project-title" onDismiss={() => setConfirmingRemove(false)}>
          <h2 id="remove-project-title" className="text-sm font-semibold">
            Remove “{group.name}” from the app?
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            It stops being offered for new Sessions; the ones it has stay in the inbox, marked
            unavailable. Nothing on disk is touched —{' '}
            <span className="font-mono break-all">{group.root}</span> stays exactly as it is, and
            you can add it again at any time.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              data-autofocus=""
              variant="secondary"
              size="sm"
              onClick={() => setConfirmingRemove(false)}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={() => void removeProject()}>
              Remove Project
            </Button>
          </div>
        </Modal>
      )}
      <ul className="flex flex-col gap-px">
        {group.sessions.map((session) => (
          <SessionRow key={session.id} session={session} archived={archived} handlers={handlers} />
        ))}
      </ul>
    </section>
  )
}

/** What the dot on a row admits about the Session, when there is anything. */
const DOT_OF_STATUS: Partial<Record<SessionStatus, { colorClass: string; said: string }>> = {
  blocked: { colorClass: 'bg-status-blocked', said: 'Waiting on you' },
  running: { colorClass: 'bg-status-running', said: 'Running' },
  failed: { colorClass: 'bg-status-failed', said: 'The last Run failed' }
}

function SessionRow({
  session,
  archived,
  handlers
}: {
  session: MailboxSession
  archived: boolean
  handlers: RowHandlers
}): React.JSX.Element {
  const dot = DOT_OF_STATUS[session.status]
  const said =
    session.waitingFor === 'approval'
      ? 'Waiting for your approval'
      : session.waitingFor === 'question'
        ? 'Waiting for your answer'
        : dot?.said

  if (handlers.renamingId === session.id) {
    return (
      <li className="py-0.5 pr-2 pl-7">
        <RenameInput session={session} handlers={handlers} />
      </li>
    )
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<li className={cn('group relative', archived && 'opacity-75')} />}
      >
        <button
          type="button"
          onClick={() => handlers.onOpen(session)}
          aria-current={handlers.selectedId === session.id ? 'true' : undefined}
          className={cn(
            'flex w-full items-center gap-2 rounded-md py-1.5 pl-7 text-left text-xs transition-colors',
            archived ? 'pr-2' : 'pr-14',
            handlers.selectedId === session.id
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          )}
        >
          <span className="min-w-0 flex-1 truncate">{session.title}</span>
          {session.dormant && (
            <span
              title="Nothing has run here in a while. It wakes the moment you send a message."
              className="shrink-0 rounded-sm bg-notice px-1 text-2xs font-medium text-notice-foreground"
            >
              Dormant
            </span>
          )}
          {said && (
            // The dot yields to the quick actions: hover is for acting, and
            // the actions land exactly where it sits.
            <span
              role="img"
              aria-label={said}
              title={said}
              className={cn(
                'size-1.5 shrink-0 rounded-full transition-opacity group-focus-within:opacity-0 group-hover:opacity-0',
                session.waitingFor !== null ? 'bg-status-blocked' : dot?.colorClass
              )}
            />
          )}
        </button>
        <span className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {archived ? (
            <button
              type="button"
              onClick={() => handlers.onSetArchived(session, false)}
              className="rounded-md border border-border px-1.5 py-0.5 text-2xs text-foreground hover:bg-border focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
            >
              Restore
            </button>
          ) : (
            <button
              type="button"
              aria-label={session.pinned ? `Unpin “${session.title}”` : `Pin “${session.title}”`}
              title={session.pinned ? `Unpin “${session.title}”` : `Pin “${session.title}”`}
              onClick={() => handlers.onTogglePinned(session)}
              className={QUICK_ACTION_CLASS}
            >
              {session.pinned ? (
                <PinOff aria-hidden="true" className="size-3.5" />
              ) : (
                <Pin aria-hidden="true" className="size-3.5" />
              )}
            </button>
          )}
          <Menu>
            <MenuTrigger aria-label={`More for “${session.title}”`} className={QUICK_ACTION_CLASS}>
              <MoreHorizontal aria-hidden="true" className="size-3.5" />
            </MenuTrigger>
            <MenuContent>
              <SessionMenuItems session={session} handlers={handlers} />
            </MenuContent>
          </Menu>
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <SessionMenuItems session={session} handlers={handlers} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * The row while it is being renamed. Focus moves in because the menu that
 * asked for the rename has just closed over this exact spot; the whole title
 * is selected so typing replaces it.
 */
function RenameInput({
  session,
  handlers
}: {
  session: MailboxSession
  handlers: RowHandlers
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  return (
    <input
      ref={inputRef}
      type="text"
      aria-label={`Rename “${session.title}”`}
      defaultValue={session.title}
      onKeyDown={(event) => {
        if (event.key === 'Enter') handlers.onRenameTo(session, event.currentTarget.value)
        if (event.key === 'Escape') handlers.onRenameCancel()
      }}
      onBlur={handlers.onRenameCancel}
      className="w-full rounded-md border border-border bg-surface px-1.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  )
}

/** One set of actions, spoken through either the ⋯ menu or a right-click. */
function SessionMenuItems({
  session,
  handlers
}: {
  session: MailboxSession
  handlers: RowHandlers
}): React.JSX.Element {
  const archived = session.archivedAt !== null
  return (
    <>
      <MenuItem onClick={() => handlers.onTogglePinned(session)}>
        {session.pinned ? (
          <PinOff aria-hidden="true" className="size-3.5 text-muted-foreground" />
        ) : (
          <Pin aria-hidden="true" className="size-3.5 text-muted-foreground" />
        )}
        {session.pinned ? 'Unpin' : 'Pin'}
        <MenuShortcut>⇧⌘P</MenuShortcut>
      </MenuItem>
      <MenuItem onClick={() => handlers.onSetArchived(session, !archived)}>
        <Archive aria-hidden="true" className="size-3.5 text-muted-foreground" />
        {archived ? 'Restore' : 'Archive'}
        <MenuShortcut>⌘⌫</MenuShortcut>
      </MenuItem>
      <MenuItem onClick={() => handlers.onRename(session)}>
        <Pencil aria-hidden="true" className="size-3.5 text-muted-foreground" />
        Rename
      </MenuItem>
      <MenuSeparator />
      <MenuItem className="text-destructive" onClick={() => handlers.onDelete(session)}>
        <Trash2 aria-hidden="true" className="size-3.5" />
        Delete…
      </MenuItem>
    </>
  )
}

/**
 * The one destructive dialog in the app (mockup 3b). Archiving asks nothing;
 * a Conversation is permanent history, so deleting one does.
 */
function DeleteConfirmDialog({
  session,
  onCancel,
  onConfirm
}: {
  session: SessionSummary
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <Modal destructive labelledBy="delete-confirm-title" onDismiss={onCancel}>
      <h2 id="delete-confirm-title" className="text-sm font-semibold">
        Delete “{session.title}”?
      </h2>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        The Conversation is deleted permanently. Files the Session changed stay on disk in{' '}
        <span className="font-mono">{folderName(session.projectRoot)}</span> — use git to undo
        those.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button data-autofocus="" variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" size="sm" onClick={onConfirm}>
          Delete Session
        </Button>
      </div>
    </Modal>
  )
}

/**
 * What the rail says about a Session with no room for words.
 *
 * Every state gets its own mark. The rail used to fall back to one generic
 * message icon, which was a placeholder left behind when ticket 03 removed
 * the kind icons: it gave every Session the same face, which is the one thing
 * a status rail must not do.
 */
const RAIL_STATUS: Record<SessionStatus, { icon: LucideIcon; colorClass: string; said: string }> = {
  blocked: {
    icon: AlertTriangle,
    colorClass: 'text-status-blocked',
    said: ', needs attention'
  },
  running: {
    icon: CircleDashed,
    colorClass: 'text-status-running',
    said: ', running'
  },
  failed: {
    icon: CircleSlash,
    colorClass: 'text-status-failed',
    said: ', last Run failed'
  },
  idle: {
    icon: Circle,
    colorClass: 'text-status-idle',
    said: ''
  }
}

/** What a Session looks like with no room to say anything about it. */
function RailIcon({ status }: { status: SessionStatus }): React.JSX.Element {
  const marked = RAIL_STATUS[status]
  return <marked.icon aria-hidden="true" className={cn('size-3.5 shrink-0', marked.colorClass)} />
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
 * without displacing the center surface.
 */
function CompactRail({
  sessions,
  selectedId,
  onOpen,
  onExpand,
  onNewChat
}: CompactRailProps): React.JSX.Element {
  const blocked = sessions.filter((session) => session.status === 'blocked')
  const waiting = blocked.length
  const oneBlocked = blocked.length === 1 ? blocked[0] : undefined
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
      {waiting > 0 && (
        // The one question the rail must still answer: is anything waiting for
        // me. Collapsing the inbox hides the groups, never this — and when
        // exactly one Session is waiting, the count is a door, not a sign:
        // clicking it goes straight to the thing that wants an answer.
        <button
          type="button"
          aria-label={
            oneBlocked
              ? `“${oneBlocked.title}” needs attention. Open it`
              : `${String(waiting)} Sessions need attention. Expand inbox`
          }
          title={
            oneBlocked
              ? `“${oneBlocked.title}” needs attention`
              : `${String(waiting)} need attention`
          }
          onClick={() => (oneBlocked ? onOpen(oneBlocked) : onExpand())}
          className="flex size-7 items-center justify-center rounded-full bg-status-blocked-surface text-xs font-medium text-status-blocked focus-visible:ring-2 focus-visible:ring-ring"
        >
          {waiting}
        </button>
      )}
      <div aria-hidden="true" className="my-1 h-px w-6 bg-border" />
      <ul className="flex flex-col items-center gap-1">
        {sessions.map((session) => (
          <li key={session.id} className="relative">
            <button
              type="button"
              aria-label={`${session.title}${RAIL_STATUS[session.status].said}`}
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
              <RailIcon status={session.status} />
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
