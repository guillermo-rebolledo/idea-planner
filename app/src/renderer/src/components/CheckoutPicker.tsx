import { useEffect, useState } from 'react'
import { FolderTree, Monitor } from 'lucide-react'
import type { BranchList, CheckoutRequest } from '@shared/contract'
import { ChipTrigger, PopoverHeading } from '@renderer/components/ui/chip-popover'
import { ChoiceRow } from '@renderer/components/ui/choice'
import { Popover, PopoverContent } from '@renderer/components/ui/popover'

/**
 * The Checkout chip for a Session that does not exist yet. A Checkout is
 * fixed at creation, so this is the one moment there is anything to choose:
 * Local — the Project's working copy, edited in place (ADR 0004) — or an
 * isolated checkout, a linked worktree cut from a chosen base branch. Once
 * the Session exists the choice freezes into the title-bar cluster.
 */
/**
 * The base an isolated checkout is cut from when nobody has said: the branch
 * the working copy is on, else the most recent branch, else nothing — one
 * rule, wherever a base has to be presumed.
 */
function defaultBase(branches: BranchList | 'unreadable' | null): string {
  if (branches === null || branches === 'unreadable') return ''
  return branches.current ?? branches.branches[0] ?? ''
}

/** The branches there are to offer, which for an unreadable list is none. */
function listed(branches: BranchList | 'unreadable' | null): string[] {
  return branches === null || branches === 'unreadable' ? [] : branches.branches
}

export function CheckoutPicker({
  projectRoot,
  value,
  onChange,
  disabled
}: {
  projectRoot: string
  value: CheckoutRequest
  onChange: (checkout: CheckoutRequest) => void
  disabled?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // Null while nothing has been asked; 'unreadable' when git itself failed —
  // which is not the same as a Project with no branches.
  const [branches, setBranches] = useState<BranchList | 'unreadable' | null>(null)

  // Observed when the popover opens — branches move in any terminal at any
  // time — and also when an isolated default arrives with no base yet, so the
  // chip can settle onto a real branch without being clicked.
  const unsettled = value.kind === 'isolated' && value.baseBranch === ''
  useEffect(() => {
    if ((!open && !unsettled) || !projectRoot) return
    void window.shell.listBranches(projectRoot).then(setBranches, () => setBranches('unreadable'))
  }, [open, unsettled, projectRoot])

  // Isolated was chosen before the branches had loaded: settle the base onto
  // the branch the working copy is on as soon as it is known. A Project with
  // no branch to cut from — none at all, or none readable — settles back to
  // Local rather than leaving Send disabled with nothing to say.
  useEffect(() => {
    if (value.kind !== 'isolated' || value.baseBranch !== '' || branches === null) return
    const settled = defaultBase(branches)
    onChange(settled ? { kind: 'isolated', baseBranch: settled } : { kind: 'local' })
  }, [value, branches, onChange])

  const isolated = value.kind === 'isolated'
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ChipTrigger aria-label="Checkout" disabled={(disabled ?? false) || !projectRoot}>
        {value.kind === 'isolated' ? (
          <>
            Worktree
            {value.baseBranch && <span className="font-mono">· {value.baseBranch}</span>}
          </>
        ) : (
          'Local'
        )}
      </ChipTrigger>
      <PopoverContent align="start" className="w-72">
        <PopoverHeading>Checkout</PopoverHeading>
        <div className="flex flex-col gap-0.5 px-1.5 pb-2">
          <ChoiceRow
            icon={<Monitor aria-hidden="true" className="size-3.5 text-muted-foreground" />}
            name="Local"
            description="Your working copy, edited in place. git is the undo."
            chosen={!isolated}
            onClick={() => {
              onChange({ kind: 'local' })
              setOpen(false)
            }}
          />
          <ChoiceRow
            icon={<FolderTree aria-hidden="true" className="size-3.5 text-muted-foreground" />}
            name="Isolated"
            description="A linked worktree of its own, cut from the base branch below. Your copy never moves."
            chosen={isolated}
            onClick={() => {
              const kept = value.kind === 'isolated' ? value.baseBranch : ''
              onChange({ kind: 'isolated', baseBranch: kept === '' ? defaultBase(branches) : kept })
            }}
          />
          {branches === 'unreadable' && (
            <p role="alert" className="px-2 py-1.5 text-2xs text-muted-foreground">
              This Project’s branches could not be read, so there is no base to cut a worktree from.
              Local still works.
            </p>
          )}
          {value.kind === 'isolated' && (
            <label className="flex items-center gap-2 px-2 py-1.5 text-2xs text-muted-foreground">
              Base branch
              <select
                aria-label="Base branch"
                value={value.baseBranch}
                className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 font-mono text-xs"
                onChange={(event) => onChange({ kind: 'isolated', baseBranch: event.target.value })}
              >
                {value.baseBranch !== '' && !listed(branches).includes(value.baseBranch) && (
                  <option value={value.baseBranch}>{value.baseBranch}</option>
                )}
                {listed(branches).map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
