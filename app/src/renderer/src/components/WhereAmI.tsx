import { useCallback, useEffect, useState } from 'react'
import {
  AppWindow,
  ChevronDown,
  ChevronRight,
  FileDiff,
  Folder,
  FolderTree,
  GitBranch,
  Monitor,
  SquareTerminal,
  type LucideIcon
} from 'lucide-react'
import type {
  CheckoutFacts,
  CheckoutStateObservation,
  DetectedEditor,
  EditorCatalog,
  EditorId,
  SessionSummary
} from '@shared/contract'
import { DiffCounts } from '@renderer/components/Diff'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import type { DiffTotals } from '@renderer/lib/useSessionChanges'
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger
} from '@renderer/components/ui/menu'
import { cn } from '@renderer/lib/utils'
import { PullRequestAction } from '@renderer/components/PullRequestAction'

/**
 * The title-bar "where am I?" cluster (mockup 2a): branch · Local/Worktree ·
 * `+N −M` · "Open in". It stays quiet — mono for branch and counts, no colour
 * anywhere except the diff numbers — and every fact on it is observed rather
 * than stored: the branch belongs to git and moves under the app.
 *
 * Clicking the branch or the Checkout opens the Project card (mockup 2b);
 * clicking the diff numbers toggles the Files panel; "Open in" hands the
 * Checkout to an editor detected on this Mac and remembers the choice.
 */

interface WhereAmIProps {
  session: SessionSummary
  totals: DiffTotals
  filesOpen: boolean
  onToggleFiles: () => void
  /** Opens the panel without toggling, as the card's Changes row does. */
  onShowFiles: () => void
  onAnnounce: (text: string) => void
  onPullRequestPublished: () => void
}

/** The last segment of a Project root: how the person knows the folder. */
function folderName(root: string): string {
  return root.split('/').filter(Boolean).at(-1) ?? root
}

const EDITOR_ICON: Record<EditorId, LucideIcon> = {
  cursor: AppWindow,
  vscode: AppWindow,
  zed: AppWindow,
  terminal: SquareTerminal,
  finder: Folder
}

const CHIP_CLASS =
  'flex h-6 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground'

function checkoutStateText(observation: CheckoutStateObservation): string {
  if (observation.status === 'git-unavailable') return 'Git unavailable'
  if (observation.status === 'not-a-repository') return 'Not a Git repository'
  const labels = {
    clean: 'Clean',
    merge: 'Merge in progress',
    rebase: 'Rebase in progress',
    'squash-merge': 'Squash merge in progress',
    'cherry-pick': 'Cherry-pick in progress',
    revert: 'Revert in progress',
    'unresolved-index': 'Unresolved index',
    'unsafe-root': 'Unsafe Checkout root'
  } as const
  return labels[observation.state]
}

export function WhereAmI({
  session,
  totals,
  filesOpen,
  onToggleFiles,
  onShowFiles,
  onAnnounce,
  onPullRequestPublished
}: WhereAmIProps): React.JSX.Element {
  const [facts, setFacts] = useState<CheckoutFacts | null>(null)
  const [editors, setEditors] = useState<EditorCatalog | null>(null)
  const [cardOpen, setCardOpen] = useState(false)

  const refresh = useCallback(() => {
    void window.shell.getCheckoutFacts(session.id).then(setFacts, () => setFacts(null))
    void window.shell.listEditors().then(setEditors, () => setEditors(null))
  }, [session.id])

  // Observed when the Session is opened and whenever the person comes back to
  // the window: a terminal beside the app is exactly where branches move.
  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  // The Conversation stream says a Run did something; the branch may be part
  // of what it did. Cheap to re-ask, and only for this Session.
  useEffect(() => {
    let timer = 0
    const stop = window.shell.onConversationEvent((streamed) => {
      if (streamed.sessionId !== session.id) return
      window.clearTimeout(timer)
      timer = window.setTimeout(refresh, 500)
    })
    return () => {
      window.clearTimeout(timer)
      stop()
    }
  }, [session.id, refresh])

  const open = useCallback(
    async (editor: EditorId) => {
      try {
        setEditors(await window.shell.openInEditor({ sessionId: session.id, editor }))
        onAnnounce('Opened the Checkout. The agent’s edits are already there.')
      } catch {
        onAnnounce('That could not be opened.')
      }
    },
    [session.id, onAnnounce]
  )

  const checkout = facts?.checkout ?? session.checkout
  const isWorktree = checkout.kind === 'worktree'

  return (
    <div className="flex items-center gap-1.5">
      <PullRequestAction
        session={session}
        onPublished={onPullRequestPublished}
        onAnnounce={onAnnounce}
      />
      <Popover open={cardOpen} onOpenChange={setCardOpen}>
        {/* One trigger wearing two chips: branch and Checkout open the same
            Project card, and splitting them would be two buttons for one
            answer. */}
        <PopoverTrigger
          aria-label={`Project card for ${folderName(session.projectRoot)}`}
          className="group flex items-center gap-1.5 rounded-md focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* The chip waits for git rather than flashing a dash it will
              replace. Once the facts are in, — is honest: detached HEAD.
              Hover lights both chips: they are one button, and a chip that
              never reacts reads as a label rather than a way in. */}
          {facts !== null && (
            <span
              className={cn(
                CHIP_CLASS,
                'font-mono transition-colors group-hover:bg-accent group-hover:text-foreground group-data-popup-open:bg-accent'
              )}
            >
              <GitBranch aria-hidden="true" className="size-3" />
              {facts.branch ?? '—'}
            </span>
          )}
          <span
            className={cn(
              CHIP_CLASS,
              'transition-colors group-hover:bg-accent group-hover:text-foreground group-data-popup-open:bg-accent'
            )}
          >
            {isWorktree ? 'Worktree' : 'Local'}
          </span>
          {facts !== null &&
            (facts.state.status !== 'observed' || facts.state.state !== 'clean') && (
              <span className={cn(CHIP_CLASS, 'text-notice-foreground')}>
                {checkoutStateText(facts.state)}
              </span>
            )}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72">
          <ProjectCard
            session={session}
            facts={facts}
            editors={editors}
            totals={totals}
            onShowFiles={() => {
              setCardOpen(false)
              onShowFiles()
            }}
            onOpen={(editor) => {
              setCardOpen(false)
              void open(editor)
            }}
          />
        </PopoverContent>
      </Popover>

      <button
        type="button"
        aria-expanded={filesOpen}
        aria-label={`Files this Session changed: ${String(totals.added)} lines added, ${String(totals.removed)} removed`}
        onClick={onToggleFiles}
        className={cn(
          CHIP_CLASS,
          'gap-1 font-mono hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
          filesOpen && 'bg-accent'
        )}
      >
        <DiffCounts added={totals.added} removed={totals.removed} />
      </button>

      <Menu>
        <MenuTrigger
          aria-label="Open the Checkout in an editor"
          className={cn(
            CHIP_CLASS,
            'font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent'
          )}
        >
          Open in
          <ChevronDown aria-hidden="true" className="size-3" />
        </MenuTrigger>
        <MenuContent align="end" className="min-w-60">
          <EditorMenuItems editors={editors} onOpen={(editor) => void open(editor)} />
        </MenuContent>
      </Menu>
    </div>
  )
}

/**
 * The "Detected on this Mac" menu (mockup 2a): editors first, then the two
 * places every Mac has, then what opening actually means.
 */
function EditorMenuItems({
  editors,
  onOpen
}: {
  editors: EditorCatalog | null
  onOpen: (editor: EditorId) => void
}): React.JSX.Element {
  const detected = (editors?.editors ?? []).filter(
    (editor) => editor.id !== 'terminal' && editor.id !== 'finder'
  )
  const system = (editors?.editors ?? []).filter(
    (editor) => editor.id === 'terminal' || editor.id === 'finder'
  )
  const row = (editor: DetectedEditor): React.JSX.Element => {
    const Icon = EDITOR_ICON[editor.id]
    return (
      <MenuItem key={editor.id} onClick={() => onOpen(editor.id)}>
        <Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
        {editor.name}
        {editors?.lastChoice === editor.id && (
          <span className="ml-auto text-2xs text-muted-foreground">last used</span>
        )}
      </MenuItem>
    )
  }
  return (
    <>
      <p className="px-2 pt-1.5 pb-0.5 font-mono text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        Detected on this Mac
      </p>
      {detected.length === 0 && (
        <p className="px-2 py-1 text-xs text-muted-foreground">No editor was detected.</p>
      )}
      {detected.map(row)}
      <MenuSeparator />
      {system.map(row)}
      <MenuSeparator />
      <p className="px-2 py-1.5 text-2xs text-muted-foreground">
        Opens the Project folder — the agent’s edits are already there.
      </p>
    </>
  )
}

/**
 * The Project card (mockup 2b): every "where am I?" fact on one quiet card —
 * Changes, the Checkout, the branch, and the way out to an editor.
 */
function ProjectCard({
  session,
  facts,
  editors,
  totals,
  onShowFiles,
  onOpen
}: {
  session: SessionSummary
  facts: CheckoutFacts | null
  editors: EditorCatalog | null
  totals: DiffTotals
  onShowFiles: () => void
  onOpen: (editor: EditorId) => void
}): React.JSX.Element {
  const checkout = facts?.checkout ?? session.checkout
  // What the chip itself would open: the remembered editor, else the first
  // offered one. Terminal is always offered, so there is always an answer.
  const offered = editors?.editors ?? []
  const preferred =
    offered.find((editor) => editor.id === editors?.lastChoice) ?? offered[0] ?? null

  const ROW_CLASS =
    'flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring'

  return (
    <div role="group" aria-label="Project card" className="flex flex-col">
      <p className="px-3.5 pt-3 pb-1 font-mono text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        {folderName(session.projectRoot)}
      </p>
      <div className="flex flex-col p-1.5">
        <button type="button" onClick={onShowFiles} className={ROW_CLASS}>
          <FileDiff aria-hidden="true" className="size-3.5 text-muted-foreground" />
          Changes
          <span className="ml-auto font-mono">
            <DiffCounts added={totals.added} removed={totals.removed} />
          </span>
        </button>
        {checkout.kind === 'local' ? (
          <div className={cn(ROW_CLASS, 'hover:bg-transparent')}>
            <Monitor aria-hidden="true" className="size-3.5 text-muted-foreground" />
            Local
            <span className="ml-auto text-2xs text-muted-foreground">working copy</span>
          </div>
        ) : (
          <div className={cn(ROW_CLASS, 'items-start hover:bg-transparent')}>
            <FolderTree aria-hidden="true" className="mt-0.5 size-3.5 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block">Worktree</span>
              <span
                className="mt-0.5 block truncate font-mono text-2xs text-muted-foreground"
                title={checkout.path}
              >
                {checkout.path}
              </span>
            </span>
          </div>
        )}
        <div className={cn(ROW_CLASS, 'hover:bg-transparent')}>
          <GitBranch aria-hidden="true" className="size-3.5 text-muted-foreground" />
          <span className="font-mono">{facts?.branch ?? 'no branch'}</span>
        </div>
        {facts !== null && (
          <div className={cn(ROW_CLASS, 'hover:bg-transparent')}>
            <span className="text-muted-foreground">Checkout State</span>
            <span className="ml-auto text-right">{checkoutStateText(facts.state)}</span>
          </div>
        )}
      </div>
      <div className="border-t border-border p-1.5">
        <Menu>
          <MenuTrigger className={cn(ROW_CLASS, 'data-popup-open:bg-accent')}>
            {preferred !== null ? (
              <>
                {(() => {
                  const Icon = EDITOR_ICON[preferred.id]
                  return <Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                })()}
                Open in {preferred.name}
              </>
            ) : (
              'Open in…'
            )}
            <span className="ml-auto flex items-center gap-0.5 text-2xs text-muted-foreground">
              change
              <ChevronRight aria-hidden="true" className="size-3" />
            </span>
          </MenuTrigger>
          <MenuContent align="start" side="bottom" className="min-w-60">
            <EditorMenuItems editors={editors} onOpen={onOpen} />
          </MenuContent>
        </Menu>
      </div>
      <p className="border-t border-border px-3.5 py-2.5 text-2xs leading-relaxed text-muted-foreground">
        Clicking Changes opens “Files this Session changed”. Everything on disk, under git.
      </p>
    </div>
  )
}
