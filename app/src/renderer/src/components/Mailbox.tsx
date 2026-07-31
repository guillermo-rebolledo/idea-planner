import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  CircleDashed,
  Clock3,
  Inbox,
  ImagePlus,
  Lightbulb,
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
  DeleteIdeaPreview,
  DeleteIdeaResult,
  IdeaSummary,
  MailboxGroupKey,
  MailboxIdea,
  MailboxQuery,
  MailboxSnapshot,
  OpenedIdea,
  LibrarySnapshot,
  ReconciliationState,
  ReferenceAttachmentView,
  ThemePreference,
  ThemeState
} from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { CaptureForm } from '@renderer/components/CaptureForm'
import { ReadinessDialog } from '@renderer/components/Readiness'
import { IDEA_KIND_META, IdeaKindIcon } from '@renderer/components/idea-kind'
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
  | { kind: 'opening'; idea: IdeaSummary }
  | { kind: 'idea'; openedIdea: OpenedIdea; reconciliation: ReconciliationState }
  | { kind: 'unrecoverable'; idea: IdeaSummary }
  | { kind: 'missing'; idea: IdeaSummary }
  | { kind: 'failed'; idea: IdeaSummary }
  | { kind: 'reconciliation'; idea: IdeaSummary; state: ReconciliationState }
  | { kind: 'delete-preview'; idea: IdeaSummary; preview: DeleteIdeaPreview }
  | { kind: 'delete-result'; title: string; relativePath: string; result: DeleteIdeaResult }

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

const KIND_FILTER_OPTIONS: { value: MailboxQuery['kind']; label: string }[] = [
  { value: 'all', label: 'All kinds' },
  { value: 'software', label: 'Software' },
  { value: 'general', label: 'General' }
]

/**
 * The Focus Mailbox production frame: a collapsible Idea inbox on the left
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
  const [query, setQuery] = useState<MailboxQuery>({ search: '', kind: 'all', view: 'active' })
  const [mailbox, setMailbox] = useState<MailboxData>({ state: 'indexing' })
  const searchRef = useRef<HTMLInputElement>(null)
  const requestSequenceRef = useRef(0)

  const refreshMailbox = useCallback(async (nextQuery: MailboxQuery) => {
    const requestId = ++requestSequenceRef.current
    try {
      const snapshot = await window.ideaShell.queryMailbox(nextQuery)
      if (requestSequenceRef.current === requestId) {
        setMailbox({ state: 'ready', snapshot })
        if (snapshot.index === 'rebuilt') {
          setAnnouncement('The search index was rebuilt from your canonical Idea content.')
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

  function handleSaved(idea: IdeaSummary): void {
    onLibraryChanged({ ...library, ideas: [idea, ...library.ideas] })
    void refreshMailbox(query)
    void openIdea(idea)
    setAnnouncement(`Saved “${idea.title}” for later.`)
  }

  async function openIdea(idea: IdeaSummary): Promise<void> {
    setSurface({ kind: 'opening', idea })
    try {
      const reconciliation = await window.ideaShell.reconcileIdea({
        relativePath: idea.relativePath,
        reason: 'opened'
      })
      if (!['ready', 'changed'].includes(reconciliation.status)) {
        if (reconciliation.status === 'location-missing') {
          try {
            await window.ideaShell.openIdea(idea.relativePath)
          } catch (error) {
            const message = error instanceof Error ? error.message : ''
            if (message.includes('UNRECOVERABLE_CONTENT')) {
              setSurface({ kind: 'unrecoverable', idea })
              return
            }
          }
        }
        setSurface({ kind: 'reconciliation', idea, state: reconciliation })
        return
      }
      const openedIdea = await window.ideaShell.openIdea(idea.relativePath)
      setSurface({ kind: 'idea', openedIdea, reconciliation })
      if (reconciliation.status === 'changed') {
        setAnnouncement(`External changes to “${idea.title}” were saved as a new local version.`)
      }
      if (openedIdea.idea.openState === 'recovered') {
        setAnnouncement(`Recovered “${openedIdea.idea.title}” from canonical local content.`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      setSurface({
        kind: message.includes('UNRECOVERABLE_CONTENT')
          ? 'unrecoverable'
          : message.includes('IDEA_NOT_FOUND')
            ? 'missing'
            : 'failed',
        idea
      })
    }
  }

  useEffect(() => {
    if (surface.kind !== 'idea') return
    const idea = surface.openedIdea.idea
    const timer = window.setInterval(() => {
      void window.ideaShell.latestReconciliation(idea.relativePath).then((state) => {
        if (!state) return
        if (!['ready', 'changed'].includes(state.status)) {
          setSurface({ kind: 'reconciliation', idea, state })
        } else if (state.status === 'changed') {
          void openIdea(idea)
        }
      })
    }, 750)
    return () => window.clearInterval(timer)
  }, [surface])

  async function togglePinned(idea: IdeaSummary): Promise<void> {
    try {
      const updated = await window.ideaShell.setIdeaPinned({
        relativePath: idea.relativePath,
        pinned: !idea.pinned
      })
      setAnnouncement(updated.pinned ? `Pinned “${idea.title}”.` : `Unpinned “${idea.title}”.`)
    } catch {
      setAnnouncement(`Could not update the pin on “${idea.title}”.`)
    }
    void refreshMailbox(query)
  }

  async function setArchived(idea: IdeaSummary, archived: boolean): Promise<void> {
    try {
      await window.ideaShell.setIdeaArchived({ relativePath: idea.relativePath, archived })
      setAnnouncement(
        archived
          ? `Archived “${idea.title}”. Nothing moved on disk; restore it any time.`
          : `Restored “${idea.title}” to the inbox.`
      )
      setSurface((current) =>
        (current.kind === 'idea' && current.openedIdea.idea.relativePath === idea.relativePath) ||
        (current.kind === 'opening' && current.idea.relativePath === idea.relativePath)
          ? { kind: 'empty' }
          : current
      )
    } catch {
      setAnnouncement(`Could not ${archived ? 'archive' : 'restore'} “${idea.title}”.`)
    }
    void refreshMailbox(query)
  }

  async function startDelete(idea: IdeaSummary): Promise<void> {
    try {
      const preview = await window.ideaShell.previewDeleteIdea(idea.relativePath)
      setSurface({ kind: 'delete-preview', idea, preview })
    } catch {
      setAnnouncement(`Could not prepare “${idea.title}” for deletion.`)
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
      const result = await window.ideaShell.deleteIdeaPermanently({ relativePath, targets })
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

  const selectedIdea =
    surface.kind === 'idea'
      ? surface.openedIdea.idea
      : surface.kind === 'opening' ||
          surface.kind === 'unrecoverable' ||
          surface.kind === 'missing' ||
          surface.kind === 'failed' ||
          surface.kind === 'reconciliation'
        ? surface.idea
        : surface.kind === 'delete-preview'
          ? surface.idea
          : undefined

  const snapshot = mailbox.state === 'ready' ? mailbox.snapshot : null
  const allIdeas = snapshot?.groups.flatMap((group) => group.ideas) ?? []

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
        <h1 className="text-[13px] font-semibold">Ideas</h1>
        <div className="ml-auto flex items-center gap-2">
          <ThemeSelect theme={theme} onChange={onThemePreferenceChange} />
          <Button
            variant="ghost"
            size="sm"
            aria-label="AI Providers"
            onClick={() => setReadinessOpen(true)}
          >
            <Bot aria-hidden="true" className="size-3.5" />
            AI Providers
          </Button>
          <Button onClick={startCapture} size="sm">
            <Plus aria-hidden="true" className="size-3.5" />
            New Idea
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {inboxCollapsed ? (
          <CompactRail
            ideas={allIdeas}
            selectedId={selectedIdea?.id}
            onOpen={(idea) => void openIdea(idea)}
            onExpand={() => setInboxCollapsed(false)}
            onCapture={startCapture}
          />
        ) : (
          <nav
            aria-label="Idea inbox"
            className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/40"
          >
            <div className="flex flex-col gap-2 border-b border-border p-2">
              <label className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2 focus-within:ring-2 focus-within:ring-ring">
                <Search aria-hidden="true" className="size-3.5 text-muted-foreground" />
                <input
                  ref={searchRef}
                  type="search"
                  aria-label="Search Ideas"
                  placeholder="Search Ideas"
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
                <select
                  aria-label="Filter by kind"
                  value={query.kind}
                  onChange={(event) =>
                    setQuery((current) => ({
                      ...current,
                      kind: event.target.value as MailboxQuery['kind']
                    }))
                  }
                  className="ml-auto h-6 rounded-md border border-border bg-surface px-1 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {KIND_FILTER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto py-2">
              <InboxContent
                mailbox={mailbox}
                query={query}
                selectedId={selectedIdea?.id}
                onOpen={(idea) => void openIdea(idea)}
                onCapture={startCapture}
                onClearSearch={() => setQuery((current) => ({ ...current, search: '' }))}
                onRetry={() => void refreshMailbox(query)}
                onTogglePinned={(idea) => void togglePinned(idea)}
                onSetArchived={(idea, archived) => void setArchived(idea, archived)}
                onDelete={(idea) => void startDelete(idea)}
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
            <IdeaOpening title={surface.idea.title} />
          ) : surface.kind === 'unrecoverable' ? (
            <CenterNotice
              title={`“${surface.idea.title}” needs attention`}
              body="Canonical Idea content is missing or unreadable. No partial content was opened."
              actionLabel="Try again"
              onAction={() => void openIdea(surface.idea)}
            />
          ) : surface.kind === 'missing' ? (
            <CenterNotice
              title={`“${surface.idea.title}” is not at its known location`}
              body="Its folder was moved or deleted outside the app. Refresh the inbox to match what is on disk; nothing is deleted by refreshing."
              actionLabel="Refresh inbox"
              onAction={() => {
                setSurface({ kind: 'empty' })
                void refreshMailbox(query)
              }}
            />
          ) : surface.kind === 'failed' ? (
            <CenterNotice
              title={`“${surface.idea.title}” could not be opened`}
              body="The app could not finish reading local content. The Idea was not classified as corrupt."
              actionLabel="Try again"
              onAction={() => void openIdea(surface.idea)}
            />
          ) : surface.kind === 'reconciliation' ? (
            <ReconciliationNotice
              idea={surface.idea}
              state={surface.state}
              onRetry={() => void openIdea(surface.idea)}
              onLocate={() => {
                void window.ideaShell.locateIdea(surface.idea.relativePath).then((result) => {
                  if (!result.canceled) void openIdea(surface.idea)
                })
              }}
              onResolve={(documentId, choice, aiDraft) => {
                void window.ideaShell
                  .resolveManagedConflict({
                    relativePath: surface.idea.relativePath,
                    documentId,
                    choice,
                    ...(choice === 'keep-ai-draft' ? { aiDraft } : {})
                  })
                  .then(() => openIdea(surface.idea))
              }}
              onResolveDuplicate={(documentId) => {
                void window.ideaShell
                  .resolveDuplicateManagedDocument(surface.idea.relativePath, documentId)
                  .then((result) => {
                    if (!result.canceled) void openIdea(surface.idea)
                  })
              }}
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
          ) : surface.kind === 'idea' ? (
            <IdeaDetail
              openedIdea={surface.openedIdea}
              reconciliation={surface.reconciliation}
              onRestore={(documentId, version) => {
                void window.ideaShell
                  .restoreManagedVersion({
                    relativePath: surface.openedIdea.idea.relativePath,
                    documentId,
                    version
                  })
                  .then(() => openIdea(surface.openedIdea.idea))
              }}
              onTogglePinned={(idea) => void togglePinned(idea)}
              onSetArchived={(idea, archived) => void setArchived(idea, archived)}
              onDelete={(idea) => void startDelete(idea)}
            />
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

      {readinessOpen && <ReadinessDialog onClose={() => setReadinessOpen(false)} />}
    </div>
  )
}

function ReconciliationNotice({
  idea,
  state,
  onRetry,
  onLocate,
  onResolve,
  onResolveDuplicate
}: {
  idea: IdeaSummary
  state: ReconciliationState
  onRetry: () => void
  onLocate: () => void
  onResolve: (documentId: string, choice: 'keep-disk' | 'keep-ai-draft', aiDraft: string) => void
  onResolveDuplicate: (documentId: string) => void
}): React.JSX.Element {
  const copy: Record<ReconciliationState['status'], { title: string; body: string }> = {
    ready: { title: 'Local content is ready', body: 'Managed content is current.' },
    changed: { title: 'External changes detected', body: 'A new local version is available.' },
    conflict: {
      title: 'Run paused for a content conflict',
      body: 'Choose Keep disk version or Keep AI draft. Nothing was merged automatically.'
    },
    'location-missing': {
      title: 'Location missing',
      body: 'The app did not search elsewhere. Use Locate after reconnecting the volume or moving the folder.'
    },
    'unsafe-path': {
      title: 'Unsafe managed-content path',
      body: 'A managed path resolves outside the approved Working Directory and was not opened.'
    },
    'duplicate-identity': {
      title: 'Duplicate managed-content identity',
      body: 'Two local copies claim the same stable identity. Choose the intended copy before continuing.'
    },
    offline: {
      title: 'Working Directory offline',
      body: 'Local placeholders remain visible while the registered volume is unavailable.'
    },
    'sync-copy-ambiguous': {
      title: 'Synced copies need attention',
      body: 'Multiple sync copies are present. The app will not guess which one is authoritative.'
    }
  }
  const message = copy[state.status]
  return (
    <section className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6" role="alert">
      <div className="rounded-md border border-notice-border bg-notice p-4 text-notice-foreground">
        <h2 className="font-semibold">{message.title}</h2>
        <p className="mt-1 text-sm">{message.body}</p>
      </div>
      {state.conflicts.map((conflict) => (
        <div key={conflict.documentId} className="rounded-md border border-border bg-surface p-3">
          <p className="text-xs font-medium">Managed document conflict</p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onResolve(conflict.documentId, 'keep-disk', conflict.aiDraft)}
            >
              Keep disk version
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onResolve(conflict.documentId, 'keep-ai-draft', conflict.aiDraft)}
            >
              Keep AI draft
            </Button>
          </div>
        </div>
      ))}
      {state.duplicateCandidates.map((candidate) => (
        <div key={candidate.documentId} className="rounded-md border border-border bg-surface p-3">
          <p className="text-xs font-medium">Copies claiming {candidate.documentId}</p>
          <ul className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
            {candidate.paths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          <Button
            className="mt-3"
            size="sm"
            variant="secondary"
            onClick={() => onResolveDuplicate(candidate.documentId)}
          >
            Choose intended copy…
          </Button>
        </div>
      ))}
      {state.duplicateCandidates.length === 0 && (
        <Button
          variant="secondary"
          onClick={state.recoveryAction === 'locate' ? onLocate : onRetry}
        >
          {state.recoveryAction === 'locate' ? 'Locate…' : 'Check again'}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">“{idea.title}” was left unchanged.</p>
    </section>
  )
}

interface InboxContentProps {
  mailbox: MailboxData
  query: MailboxQuery
  selectedId: string | undefined
  onOpen: (idea: MailboxIdea) => void
  onCapture: () => void
  onClearSearch: () => void
  onRetry: () => void
  onTogglePinned: (idea: MailboxIdea) => void
  onSetArchived: (idea: MailboxIdea, archived: boolean) => void
  onDelete: (idea: MailboxIdea) => void
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
        Indexing Ideas from local content…
      </p>
    )
  }

  if (mailbox.state === 'failed') {
    return (
      <div role="alert" className="flex flex-col items-center gap-2 px-4 py-6 text-center">
        <p className="text-xs text-muted-foreground">The Idea inbox could not be read.</p>
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
        No archived Ideas. Archiving keeps every file in place.
      </p>
    ) : (
      <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
        <Inbox aria-hidden="true" className="size-5 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          No Ideas yet. Press <kbd className="font-mono">N</kbd> to capture one.
        </p>
        <Button variant="secondary" size="sm" onClick={props.onCapture}>
          Capture an Idea
        </Button>
      </div>
    )
  }

  if (snapshot.matched === 0) {
    return (
      <div role="status" className="flex flex-col items-center gap-2 px-4 py-6 text-center">
        <p className="text-xs text-muted-foreground">
          No Ideas match {query.search ? `“${query.search}”` : 'the current filters'}.
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
        <IdeaGroup key={group.key} groupKey={group.key} ideas={group.ideas} {...props} />
      ))}
    </div>
  )
}

interface IdeaGroupProps extends Omit<InboxContentProps, 'mailbox' | 'query'> {
  groupKey: MailboxGroupKey
  ideas: MailboxIdea[]
}

function IdeaGroup({ groupKey, ideas, ...props }: IdeaGroupProps): React.JSX.Element {
  const meta = GROUP_META[groupKey]
  return (
    <section aria-label={meta.label} className="px-2">
      <h2 className="flex items-center gap-1.5 px-2 pb-1 text-[10px] font-semibold tracking-wide uppercase">
        <meta.icon aria-hidden="true" className={cn('size-3', meta.colorClass)} />
        <span className={meta.colorClass}>{meta.label}</span>
        <span className="text-muted-foreground">{ideas.length}</span>
      </h2>
      {ideas.length === 0 ? (
        <p className="px-2 pb-1 text-[11px] text-muted-foreground italic">
          {groupKey === 'running' ? 'No Runs yet' : 'None'}
        </p>
      ) : (
        <ul className="flex flex-col gap-px">
          {ideas.map((idea) => (
            <IdeaRow key={idea.id} idea={idea} {...props} />
          ))}
        </ul>
      )}
    </section>
  )
}

interface IdeaRowProps extends Omit<IdeaGroupProps, 'groupKey' | 'ideas'> {
  idea: MailboxIdea
}

function IdeaRow({ idea, selectedId, ...props }: IdeaRowProps): React.JSX.Element {
  const archived = idea.archivedAt !== null
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => props.onOpen(idea)}
        aria-current={selectedId === idea.id ? 'true' : undefined}
        className={cn(
          'flex w-full items-center gap-2 rounded-md py-1.5 pr-20 pl-2 text-left transition-colors',
          selectedId === idea.id
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        )}
      >
        <IdeaKindIcon kind={idea.kind} />
        <span className="min-w-0 flex-1 truncate">{idea.title}</span>
        {idea.dormant && (
          <span className="rounded-sm bg-notice px-1 text-[10px] font-medium text-notice-foreground">
            Dormant
          </span>
        )}
        {idea.openState === 'unrecoverable-content' ||
        idea.openState === 'read-only-newer-format' ? (
          <AlertTriangle
            role="img"
            aria-label="Needs attention"
            className="size-3 text-amber-600 dark:text-amber-400"
          />
        ) : null}
      </button>
      <span className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <RowAction
          label={idea.pinned ? `Unpin “${idea.title}”` : `Pin “${idea.title}”`}
          icon={idea.pinned ? PinOff : Pin}
          onClick={() => props.onTogglePinned(idea)}
        />
        <RowAction
          label={archived ? `Restore “${idea.title}”` : `Archive “${idea.title}”`}
          icon={archived ? ArchiveRestore : Archive}
          onClick={() => props.onSetArchived(idea, !archived)}
        />
        <RowAction
          label={`Delete “${idea.title}” permanently…`}
          icon={Trash2}
          onClick={() => props.onDelete(idea)}
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
  ideas: MailboxIdea[]
  selectedId: string | undefined
  onOpen: (idea: MailboxIdea) => void
  onExpand: () => void
  onCapture: () => void
}

/**
 * The collapsed inbox: a narrow rail that keeps every Idea reachable without
 * displacing the central Focus Deck.
 */
function CompactRail({
  ideas,
  selectedId,
  onOpen,
  onExpand,
  onCapture
}: CompactRailProps): React.JSX.Element {
  return (
    <nav
      aria-label="Idea inbox (compact)"
      className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border bg-muted/40 py-2"
    >
      <button
        type="button"
        aria-label="New Idea"
        title="New Idea"
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
        {ideas.map((idea) => (
          <li key={idea.id} className="relative">
            <button
              type="button"
              aria-label={idea.title}
              title={idea.title}
              aria-current={selectedId === idea.id ? 'true' : undefined}
              onClick={() => onOpen(idea)}
              className={cn(
                'rounded-md p-2 transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                selectedId === idea.id
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <IdeaKindIcon kind={idea.kind} />
            </button>
            {idea.pinned && (
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

function IdeaOpening({ title }: { title: string }): React.JSX.Element {
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
  preview: DeleteIdeaPreview
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
          Exactly these app-owned items move to the macOS Trash. Nothing else in your Idea Library
          is touched, and you can put them back from the Trash.
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
  result: DeleteIdeaResult
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

function IdeaDetail({
  openedIdea,
  reconciliation,
  onRestore,
  onTogglePinned,
  onSetArchived,
  onDelete
}: {
  openedIdea: OpenedIdea
  reconciliation: ReconciliationState
  onRestore: (documentId: string, version: number) => void
  onTogglePinned: (idea: IdeaSummary) => void
  onSetArchived: (idea: IdeaSummary, archived: boolean) => void
  onDelete: (idea: IdeaSummary) => void
}): React.JSX.Element {
  const idea = openedIdea.idea
  const [references, setReferences] = useState<ReferenceAttachmentView[]>([])
  const [referenceError, setReferenceError] = useState<string | null>(null)
  useEffect(() => {
    void window.ideaShell
      .listReferenceAttachments(idea.relativePath)
      .then(setReferences, () => setReferenceError('Reference Attachments could not be read.'))
  }, [idea.relativePath])

  async function chooseReference(): Promise<void> {
    setReferenceError(null)
    try {
      const result = await window.ideaShell.chooseReferenceAttachment({
        relativePath: idea.relativePath,
        messageId: `${idea.id}:manual-context`
      })
      if (!result.canceled) setReferences((current) => [...current, result.reference])
    } catch {
      setReferenceError('Choose a valid PNG or JPEG image.')
    }
  }

  async function keepReference(referenceId: string): Promise<void> {
    try {
      const kept = await window.ideaShell.keepReferenceWithIdea({
        relativePath: idea.relativePath,
        referenceId
      })
      setReferences((current) =>
        current.map((reference) => (reference.id === kept.id ? kept : reference))
      )
    } catch {
      setReferenceError('Locate the image before keeping it with the Idea.')
    }
  }

  async function locateReference(referenceId: string): Promise<void> {
    const result = await window.ideaShell.locateReferenceAttachment({
      relativePath: idea.relativePath,
      referenceId
    })
    if (!result.canceled) {
      setReferences((current) =>
        current.map((reference) =>
          reference.id === result.reference.id ? result.reference : reference
        )
      )
    }
  }

  async function continueWithout(referenceId: string): Promise<void> {
    await window.ideaShell.continueWithoutReference({
      relativePath: idea.relativePath,
      referenceId
    })
    setReferences((current) => current.filter((reference) => reference.id !== referenceId))
  }
  const savedAt = new Date(idea.updatedAt)
  const archived = idea.archivedAt !== null
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
        {idea.pinned && (
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
      <h2 className="mt-2 text-lg font-semibold select-text">{idea.title}</h2>
      {openedIdea.notice && (
        <div
          className="mt-4 rounded-md border border-border bg-muted/50 p-3 text-sm text-foreground"
          role={idea.openState === 'read-only-newer-format' ? 'alert' : 'status'}
        >
          <p>{openedIdea.notice}</p>
          {idea.openState === 'read-only-newer-format' && (
            <p className="mt-1 text-xs text-muted-foreground">
              The content is open read-only; nothing on disk was changed.
            </p>
          )}
        </div>
      )}
      <p className="mt-4 rounded-md border border-border bg-surface p-3 font-mono text-xs break-all text-muted-foreground select-text">
        {openedIdea.documents.root.path}
      </p>
      <section
        className="mt-4 rounded-md border border-border bg-surface p-3"
        aria-labelledby="references-heading"
      >
        <div className="flex items-center gap-2">
          <div>
            <h3 id="references-heading" className="text-sm font-medium">
              Reference Attachments
            </h3>
            <p className="text-xs text-muted-foreground">
              Images stay external unless you choose Keep with Idea.
            </p>
          </div>
          <Button
            className="ml-auto"
            size="sm"
            variant="secondary"
            onClick={() => void chooseReference()}
          >
            <ImagePlus aria-hidden="true" className="size-3.5" /> Add image…
          </Button>
        </div>
        {references.length > 0 && (
          <ul className="mt-3 flex flex-col gap-2">
            {references.map((reference) => (
              <li
                key={reference.id}
                className="flex items-center gap-2 rounded border border-border p-2 text-xs"
              >
                <span className="min-w-0 flex-1 truncate">{reference.safeName}</span>
                {reference.availability === 'missing' ? (
                  <span className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void locateReference(reference.id)}
                    >
                      Locate image…
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void continueWithout(reference.id)}
                    >
                      Continue without it
                    </Button>
                  </span>
                ) : reference.durablePath ? (
                  <span className="text-muted-foreground">Kept with Idea</span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void keepReference(reference.id)}
                  >
                    Keep with Idea
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {referenceError && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {referenceError}
          </p>
        )}
      </section>
      {reconciliation.history.length > reconciliation.documents.length && (
        <details className="mt-4 rounded-md border border-border bg-surface p-3">
          <summary className="cursor-pointer text-sm font-medium">Version history</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {reconciliation.history.map((entry) => {
              const current = reconciliation.documents.find(
                (document) => document.id === entry.documentId
              )
              return (
                <li
                  key={`${entry.documentId}:${entry.version}`}
                  className="flex items-center gap-2 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {current?.path ?? 'Managed document'} · version {entry.version}
                  </span>
                  {current && entry.version < current.version && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onRestore(entry.documentId, entry.version)}
                    >
                      Restore as current
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </details>
      )}
      {idea.openState !== 'read-only-newer-format' && (
        <div className="mt-4 flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => onTogglePinned(idea)}>
            {idea.pinned ? (
              <>
                <PinOff aria-hidden="true" className="size-3.5" /> Unpin
              </>
            ) : (
              <>
                <Pin aria-hidden="true" className="size-3.5" /> Pin
              </>
            )}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onSetArchived(idea, !archived)}>
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
          <Button variant="secondary" size="sm" onClick={() => onDelete(idea)}>
            <Trash2 aria-hidden="true" className="size-3.5" /> Delete…
          </Button>
        </div>
      )}
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
