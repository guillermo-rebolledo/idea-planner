import { useCallback, useEffect, useState } from 'react'
import { Archive, ArrowRightLeft, Bot, Download, FolderPlus, Lock, Settings } from 'lucide-react'
import {
  type AppearanceSettings,
  type ReadinessSnapshot,
  type StandingApproval,
  type ThemeState
} from '@shared/contract'
import {
  listApprovalsByProject,
  StandingApprovalsDialog,
  type ProjectApprovals
} from '@renderer/components/StandingApprovals'
import { SettingsDialog, type SettingsSection } from '@renderer/components/Settings'
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger
} from '@renderer/components/ui/menu'
import { useUpdateAvailability } from '@renderer/lib/useUpdateAvailability'
import { cn } from '@renderer/lib/utils'

interface AppMenuProps {
  theme: ThemeState | null
  onAppearanceChange: (appearance: AppearanceSettings) => Promise<void>
  /** Archived Sessions across every Project; null while the mailbox reads. */
  archivedTotal: number | null
  onShowArchived: () => void
  /** Opens the ⌘K switcher — named here so the shortcut can be learned. */
  onGoToSession: () => void
  onAddProject: () => void
  onAnnounce: (text: string) => void
}

/**
 * The app menu, anchored in the sidebar footer (mockup 3c). The rarely
 * touched things live here — adding a Project, Harnesses, Standing Approvals,
 * the theme, the archive — so no other surface has to grow chrome for them.
 * The footer itself is the trigger, and it carries an attention dot when a
 * Harness needs the person.
 */
export function AppMenu({
  theme,
  onAppearanceChange,
  archivedTotal,
  onShowArchived,
  onGoToSession,
  onAddProject,
  onAnnounce
}: AppMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [readiness, setReadiness] = useState<ReadinessSnapshot | null>(null)
  const [approvals, setApprovals] = useState<ProjectApprovals[]>([])
  const [approvalsOpen, setApprovalsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null)
  // A newer Argos is news, not an interruption: it arrives as a dot on a
  // footer nobody has to look at, and waits there.
  const update = useUpdateAvailability()

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
  const updateAvailable = update?.available ?? null
  // The footer is a button, so what it has to say has to be in its name: text
  // inside it is never read once the button is labelled.
  const menuLabel = [
    'App menu',
    needsAttention ? 'a Harness needs you' : null,
    updateAvailable ? `Argos ${updateAvailable.version} is available` : null
  ]
    .filter((part) => part !== null)
    .join(' — ')

  async function takeUpdate(): Promise<void> {
    try {
      await window.shell.openUpdate()
      onAnnounce('Opening the release in your browser. Argos installs nothing on its own.')
    } catch {
      onAnnounce('That release could not be opened.')
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
          aria-label={menuLabel}
          className="flex w-full items-center gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground"
        >
          <span className="relative">
            <Bot aria-hidden="true" className="size-3.5" />
            {(needsAttention || updateAvailable) && (
              <span
                aria-hidden="true"
                className={cn(
                  'absolute -top-0.5 -right-0.5 size-1.5 rounded-full',
                  // A Harness that cannot run is between the person and their
                  // work. A newer version is not, and waits behind it.
                  needsAttention ? 'bg-status-blocked' : 'bg-primary'
                )}
              />
            )}
          </span>
          Argos
        </MenuTrigger>
        <MenuContent side="top" align="start" className="m-2">
          <MenuItem onClick={onAddProject}>
            <FolderPlus aria-hidden="true" className="size-3.5 text-muted-foreground" />
            Add Project…
          </MenuItem>
          <MenuItem onClick={() => setSettingsSection('harnesses')}>
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
          {updateAvailable && (
            <MenuItem onClick={() => void takeUpdate()}>
              <Download aria-hidden="true" className="size-3.5 text-muted-foreground" />
              Argos {updateAvailable.version} is available
              <span className="ml-auto text-2xs text-muted-foreground">Get it</span>
            </MenuItem>
          )}
          <MenuItem onClick={() => setSettingsSection('general')}>
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

      {settingsSection && (
        <SettingsDialog
          theme={theme}
          initialSection={settingsSection}
          onAppearanceChange={onAppearanceChange}
          onDismiss={() => setSettingsSection(null)}
        />
      )}
    </>
  )
}
