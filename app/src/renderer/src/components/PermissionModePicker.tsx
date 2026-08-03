import { useEffect, useState } from 'react'
import { Check, Lock, TriangleAlert } from 'lucide-react'
import type { PermissionMode } from '@shared/contract'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
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
        <PopoverTrigger
          aria-label="Permission Mode"
          disabled={disabled ?? false}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs',
            fullAccess
              ? 'bg-status-blocked-surface text-status-blocked'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          )}
        >
          {fullAccess && <TriangleAlert aria-hidden="true" className="size-3 shrink-0" />}
          {MODE_COPY[value].title}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72">
          <p className="px-3 pt-2.5 pb-1 font-mono text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
            Permission Mode
          </p>
          <div className="flex flex-col gap-0.5 px-1.5 pb-2">
            {(['ask', 'auto'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={cn(
                  'rounded-md px-2 py-1.5 text-left hover:bg-muted/60',
                  mode === value && 'bg-accent'
                )}
                onClick={() => {
                  onChange(mode)
                  setOpen(false)
                }}
              >
                <span
                  className={cn(
                    'flex items-center gap-1.5 text-xs font-medium',
                    mode === 'auto' && 'text-status-blocked'
                  )}
                >
                  {mode === 'auto' && (
                    <TriangleAlert aria-hidden="true" className="size-3 shrink-0" />
                  )}
                  {MODE_COPY[mode].title}
                  {mode === value && <Check aria-hidden="true" className="ml-auto size-3" />}
                </span>
                <span className="mt-0.5 block text-2xs leading-relaxed text-muted-foreground">
                  {MODE_COPY[mode].description}
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="flex w-full items-center gap-1.5 border-t border-border px-3 py-2 text-left text-2xs text-muted-foreground hover:bg-muted/60"
            onClick={manage}
          >
            <Lock aria-hidden="true" className="size-3 shrink-0" />
            {count === null
              ? 'Standing Approvals'
              : `${String(count)} Standing Approval${count === 1 ? '' : 's'} for ${projectName(projectRoot)}`}
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

/** The Project as a person names it: the folder, not the whole path. */
function projectName(projectRoot: string): string {
  return projectRoot.split('/').filter(Boolean).at(-1) ?? projectRoot
}
