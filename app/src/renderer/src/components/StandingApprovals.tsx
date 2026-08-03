import { ruleText, type StandingApproval } from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { Modal } from '@renderer/components/ui/dialog'

/**
 * The minimal Standing Approvals manager, reachable from the app menu and
 * from the Permission Mode popover's footer. One dialog for both, because
 * what is permanently allowed should read the same wherever it is asked.
 */

export interface ProjectApprovals {
  root: string
  name: string
  approvals: StandingApproval[]
}

/** Every Project's Standing Approvals, one read per Project. */
export async function listApprovalsByProject(): Promise<ProjectApprovals[]> {
  const projects = await window.shell.listProjects()
  return Promise.all(
    projects.map(async (project) => ({
      root: project.root,
      name: project.name,
      approvals: await window.shell.listStandingApprovals(project.root)
    }))
  )
}

/**
 * What every Project has permanently allowed, and the button that takes one
 * back. Nothing is edited or created here: granting stays exclusively
 * "Always allow" on a real Approval Request.
 */
export function StandingApprovalsDialog({
  approvals,
  onRevoke,
  onDismiss
}: {
  approvals: ProjectApprovals[]
  onRevoke: (projectRoot: string, approval: StandingApproval) => void
  onDismiss: () => void
}): React.JSX.Element {
  const granted = approvals.filter((entry) => entry.approvals.length > 0)
  return (
    <Modal labelledBy="standing-approvals-title" onDismiss={onDismiss} className="max-w-md">
      <h2 id="standing-approvals-title" className="text-sm font-medium">
        Standing Approvals
      </h2>
      {granted.length === 0 ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Nothing is permanently allowed. Granting happens on a real Approval Request — “Always
          allow” is the only way in.
        </p>
      ) : (
        <div className="mt-3 flex max-h-80 flex-col gap-3 overflow-y-auto">
          {granted.map((entry) => (
            <section key={entry.root} aria-label={entry.name}>
              <h3 className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                {entry.name}
              </h3>
              <ul className="mt-1 flex flex-col gap-1.5">
                {entry.approvals.map((approval) => (
                  <li key={approval.id} className="flex items-start gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs">{approval.summary}</span>
                      {/* The rule itself, because the rule is what decides. */}
                      <span className="block font-mono text-2xs break-all text-muted-foreground select-text">
                        {ruleText(approval)}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 shrink-0"
                      onClick={() => onRevoke(entry.root, approval)}
                    >
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <Button data-autofocus="" variant="secondary" size="sm" onClick={onDismiss}>
          Close
        </Button>
      </div>
    </Modal>
  )
}
