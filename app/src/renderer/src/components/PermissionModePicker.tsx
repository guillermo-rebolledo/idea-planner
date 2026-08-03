import { useEffect, useState } from 'react'
import { Lock, TriangleAlert } from 'lucide-react'
import { projectDisplayName, type PermissionMode } from '@shared/contract'
import { ChipTrigger, PopoverHeading } from '@renderer/components/ui/chip-popover'
import { ChoiceRow } from '@renderer/components/ui/choice'
import { Popover, PopoverContent } from '@renderer/components/ui/popover'
import {
  listApprovalsByProject,
  StandingApprovalsDialog,
  type ProjectApprovals
} from '@renderer/components/StandingApprovals'
import { cn } from '@renderer/lib/utils'

/**
 * The Permission Mode chip and its popover (mockup 1f). The chip stays quiet
 * in Ask and turns amber in Full access — the one standing reminder that the
 * agent edits and runs without asking. The footer names what this Project has
 * permanently allowed and opens the minimal manager; granting itself stays
 * exclusively "Always allow" on a real Approval Request.
 */

const MODE_COPY: Record<PermissionMode, { title: string; description: string }> = {
  ask: {
    title: 'Ask',
    description: 'The agent stops for your consent before edits and commands.'
  },
  auto: {
    title: 'Full access',
    description: 'Edits and runs without asking. The chip stays amber as a reminder.'
  }
}

export function PermissionModePicker({
  value,
  onChange,
  projectRoot,
  disabled
}: {
  value: PermissionMode
  onChange: (mode: PermissionMode) => void
  projectRoot: string
  disabled?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [count, setCount] = useState<number | null>(null)
  const [managing, setManaging] = useState<ProjectApprovals[] | null>(null)

  // Counted when the popover opens, not kept: grants and revocations happen
  // on other surfaces, and a stale count is a wrong promise.
  useEffect(() => {
    if (!open) return
    void window.shell.listStandingApprovals(projectRoot).then(
      (listed) => setCount(listed.length),
      () => setCount(null)
    )
  }, [open, projectRoot])

  const manage = (): void => {
    void listApprovalsByProject().then(
      (approvals) => {
        setManaging(approvals)
        setOpen(false)
      },
      () => undefined
    )
  }

  const revoke = (root: string, id: string): void => {
    void window.shell
      .revokeStandingApproval({ projectRoot: root, id })
      .then(listApprovalsByProject)
      .then(setManaging, () => undefined)
  }

  const fullAccess = value === 'auto'
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <ChipTrigger aria-label="Permission Mode" disabled={disabled ?? false} alert={fullAccess}>
          {fullAccess && <TriangleAlert aria-hidden="true" className="size-3 shrink-0" />}
          {MODE_COPY[value].title}
        </ChipTrigger>
        <PopoverContent align="start" className="w-72">
          <PopoverHeading>Permission Mode</PopoverHeading>
          <div className="flex flex-col gap-0.5 px-1.5 pb-2">
            {(['ask', 'auto'] as const).map((mode) => (
              <ChoiceRow
                key={mode}
                icon={
                  mode === 'auto' ? (
                    <TriangleAlert aria-hidden="true" className="size-3.5 text-status-blocked" />
                  ) : undefined
                }
                name={
                  <span className={cn(mode === 'auto' && 'text-status-blocked')}>
                    {MODE_COPY[mode].title}
                  </span>
                }
                description={MODE_COPY[mode].description}
                chosen={mode === value}
                onClick={() => {
                  onChange(mode)
                  setOpen(false)
                }}
              />
            ))}
          </div>
          <button
            type="button"
            className="flex w-full items-center gap-1.5 border-t border-border px-3 py-2 text-left text-2xs text-muted-foreground hover:bg-accent"
            onClick={manage}
          >
            <Lock aria-hidden="true" className="size-3 shrink-0" />
            {count === null
              ? 'Standing Approvals'
              : `${String(count)} Standing Approval${count === 1 ? '' : 's'} for ${projectDisplayName(projectRoot)}`}
            <span className="ml-auto text-foreground">Manage</span>
          </button>
        </PopoverContent>
      </Popover>
      {managing !== null && (
        <StandingApprovalsDialog
          approvals={managing}
          onRevoke={(root, approval) => revoke(root, approval.id)}
          onDismiss={() => setManaging(null)}
        />
      )}
    </>
  )
}
