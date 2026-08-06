import { useCallback, useEffect, useState } from 'react'
import { Archive, ArrowRightLeft, Bot, FolderPlus, Lock, Settings } from 'lucide-react'
import {
  type ChooseProjectResult,
  type ReadinessSnapshot,
  type StandingApproval,
  type ThemePreference,
  type ThemeState
} from '@shared/contract'
import {
  listApprovalsByProject,
  StandingApprovalsDialog,
  type ProjectApprovals
} from '@renderer/components/StandingApprovals'
import { Button } from '@renderer/components/ui/button'
import { Modal } from '@renderer/components/ui/dialog'
import { SettingsDialog } from '@renderer/components/Settings'
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger
} from '@renderer/components/ui/menu'
import { cn } from '@renderer/lib/utils'

interface AppMenuProps {
  theme: ThemeState | null
  onThemeChange: (preference: ThemePreference) => void
  /** Archived Sessions across every Project; null while the mailbox reads. */
  archivedTotal: number | null
  onShowArchived: () => void
  onOpenHarnesses: () => void
  /** Opens the ⌘K switcher — named here so the shortcut can be learned. */
  onGoToSession: () => void
  /** The mailbox re-reads after a Project is added, so its group appears. */
  onProjectsChanged: () => void
  onAnnounce: (text: string) => void
}

/** A folder the app declined, with the exact path the person offered it. */
type Refusal = Extract<ChooseProjectResult, { status: 'refused' }>

/** A folder inside a Project whose root git puts somewhere else. */
type RootConfirmation = Extract<ChooseProjectResult, { status: 'confirm-root' }>

/**
 * The app menu, anchored in the sidebar footer (mockup 3c). The rarely
 * touched things live here — adding a Project, Harnesses, Standing Approvals,
 * the theme, the archive — so no other surface has to grow chrome for them.
 * The footer itself is the trigger, and it carries an attention dot when a
 * Harness needs the person.
 */
export function AppMenu({
  theme,
  onThemeChange,
  archivedTotal,
  onShowArchived,
  onOpenHarnesses,
  onGoToSession,
  onProjectsChanged,
  onAnnounce
}: AppMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [readiness, setReadiness] = useState<ReadinessSnapshot | null>(null)
  const [approvals, setApprovals] = useState<ProjectApprovals[]>([])
  const [approvalsOpen, setApprovalsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [confirmation, setConfirmation] = useState<RootConfirmation | null>(null)
  const [busy, setBusy] = useState(false)

  const refreshReadiness = useCallback(() => {
    window.shell.getReadiness().then(setReadiness, () => setReadiness(null))
  }, [])

  const refreshApprovals = useCallback(() => {
    listApprovalsByProject().then(setApprovals, () => setApprovals([]))
  }, [])

  useEffect(refreshReadiness, [refreshReadiness])

  // Both are cheap reads, refreshed when the menu opens so the numbers it
  // shows are the numbers that are true.
  useEffect(() => {
    if (!open) return
    refreshReadiness()
    refreshApprovals()
  }, [open, refreshReadiness, refreshApprovals])

  const needsAttention =
    readiness?.harnesses.some((harness) => !harness.capabilities.developSession.available) ?? false
  const approvalCount = approvals.reduce((count, entry) => count + entry.approvals.length, 0)

  const adopt = useCallback(
    (result: ChooseProjectResult) => {
      if (result.status === 'cancelled') return
      if (result.status === 'refused') {
        setConfirmation(null)
        setRefusal(result)
        return
      }
      if (result.status === 'confirm-root') {
        setRefusal(null)
        setConfirmation(result)
        return
      }
      setRefusal(null)
      setConfirmation(null)
      onAnnounce(`Added “${result.project.name}”.`)
      onProjectsChanged()
    },
    [onAnnounce, onProjectsChanged]
  )

  /** Offers a folder, or answers one of the app's follow-up questions. */
  async function offer(work: () => Promise<ChooseProjectResult>, failure: string): Promise<void> {
    setBusy(true)
    try {
      adopt(await work())
    } catch {
      onAnnounce(failure)
    } finally {
      setBusy(false)
    }
  }

  async function revoke(projectRoot: string, approval: StandingApproval): Promise<void> {
    try {
      await window.shell.revokeStandingApproval({ projectRoot, id: approval.id })
      onAnnounce('Revoked. The next Run asks about it again.')
    } catch {
      onAnnounce('That could not be revoked.')
    }
    refreshApprovals()
  }

  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          aria-label="App menu"
          className="flex w-full items-center gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground"
        >
          <span className="relative">
            <Bot aria-hidden="true" className="size-3.5" />
            {needsAttention && (
              <span
                aria-hidden="true"
                className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-status-blocked"
              />
            )}
          </span>
          Argos
          {needsAttention && <span className="sr-only">— a Harness needs you</span>}
        </MenuTrigger>
        <MenuContent side="top" align="start" className="m-2">
          <MenuItem
            onClick={() =>
              void offer(() => window.shell.chooseProject(), 'That folder could not be added.')
            }
          >
            <FolderPlus aria-hidden="true" className="size-3.5 text-muted-foreground" />
            Add Project…
          </MenuItem>
          <MenuItem onClick={onOpenHarnesses}>
            <Bot aria-hidden="true" className="size-3.5 text-muted-foreground" />
            Harnesses
            <span className="ml-auto flex items-center gap-1.5">
              {readiness?.harnesses.map((harness) => (
                <span
                  key={harness.harness}
                  role="img"
                  aria-label={`${harness.displayName}: ${
                    harness.capabilities.developSession.available ? 'ready' : 'needs you'
                  }`}
                  className={cn(
                    'size-1.5 rounded-full',
                    harness.capabilities.developSession.available
                      ? 'bg-positive'
                      : 'bg-status-blocked'
                  )}
                />
              ))}
            </span>
          </MenuItem>
          <MenuItem onClick={() => setApprovalsOpen(true)}>
            <Lock aria-hidden="true" className="size-3.5 text-muted-foreground" />
            Standing Approvals
            <span className="ml-auto font-mono text-2xs text-muted-foreground">
              {approvalCount}
            </span>
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => setSettingsOpen(true)}>
            <Settings aria-hidden="true" className="size-3.5 text-muted-foreground" />
            Settings…
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={onGoToSession}>
            <ArrowRightLeft aria-hidden="true" className="size-3.5 text-muted-foreground" />
            Go to a Session…
            <MenuShortcut>⌘K</MenuShortcut>
          </MenuItem>
          <MenuItem onClick={onShowArchived}>
            <Archive aria-hidden="true" className="size-3.5 text-muted-foreground" />
            Archived Sessions
            <span className="ml-auto font-mono text-2xs text-muted-foreground">
              {archivedTotal ?? ''}
            </span>
          </MenuItem>
        </MenuContent>
      </Menu>

      {approvalsOpen && (
        <StandingApprovalsDialog
          approvals={approvals}
          onRevoke={(projectRoot, approval) => void revoke(projectRoot, approval)}
          onDismiss={() => setApprovalsOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          theme={theme}
          onThemeChange={onThemeChange}
          onDismiss={() => setSettingsOpen(false)}
        />
      )}

      {refusal && (
        <Modal labelledBy="add-project-refused-title" onDismiss={() => setRefusal(null)}>
          {refusal.reason === 'not-a-repository' ? (
            <>
              <h2 id="add-project-refused-title" className="text-sm font-medium">
                That folder is not under git yet
              </h2>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                A Project has to be — every safety guarantee here comes from git.
              </p>
              <p className="mt-2 font-mono text-xs break-all select-text">{refusal.path}</p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Setting it up runs <span className="font-mono">git init</span> there and changes
                nothing else. It is the only Git command this app ever runs for you.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  data-autofocus=""
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => setRefusal(null)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void offer(
                      () => window.shell.initializeProject(refusal.path),
                      'git could not set it up.'
                    )
                  }
                >
                  Set up git here
                </Button>
              </div>
            </>
          ) : (
            <>
              <h2 id="add-project-refused-title" className="text-sm font-medium">
                git could not be found on this machine
              </h2>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                This folder could not be added:
              </p>
              <p className="mt-2 font-mono text-xs break-all select-text">{refusal.path}</p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Install git, then add the folder again.
              </p>
              <div className="mt-4 flex justify-end">
                <Button data-autofocus="" size="sm" onClick={() => setRefusal(null)}>
                  Close
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}

      {confirmation && (
        <Modal labelledBy="add-project-confirm-title" onDismiss={() => setConfirmation(null)}>
          <h2 id="add-project-confirm-title" className="text-sm font-medium">
            That folder is inside a Project
          </h2>
          <p className="mt-2 font-mono text-xs break-all select-text">{confirmation.chosen}</p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            The Project itself begins here, and this is what would be added:
          </p>
          <p className="mt-2 font-mono text-xs break-all select-text">{confirmation.root}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              data-autofocus=""
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void offer(
                  () => window.shell.confirmProject(confirmation.root),
                  'That Project could not be added.'
                )
              }
            >
              Add this Project
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}
