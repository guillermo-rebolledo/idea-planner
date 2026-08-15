import { useEffect, useState } from 'react'
import { Check, FolderTree, Monitor } from 'lucide-react'
import type { BranchList, CheckoutDefaultReason, CheckoutRequest } from '@shared/contract'
import { ChipTrigger, PopoverHeading } from '@renderer/components/ui/chip-popover'
import { ChoiceRow } from '@renderer/components/ui/choice'
import { Popover, PopoverContent } from '@renderer/components/ui/popover'

/**
 * The Checkout chip for a Session that does not exist yet. A Checkout is
 * fixed at creation, so this is the one moment there is anything to choose:
 * Local — the Project's working copy, edited in place (ADR 0004) — or an
 * isolated checkout, a linked worktree cut from a chosen base branch. Once
 * the Session exists the choice freezes into the title-bar cluster.
 *
 * What it opens on is proposed rather than decided (ADR 0010), and when that
 * proposal came from something observed it says so in one line. Both options
 * stay live either way: this picker offers, and never refuses.
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

/**
 * Why this Checkout is the one being offered, in one line — said only while
 * the offer is still the app's and not the person's. It is an explanation and
 * never a warning: overriding it back to Local is allowed, and being told off
 * for taking an offer up is how a default starts reading as a rule.
 */
const REASON: Record<CheckoutDefaultReason, string> = {
  'local-run-active':
    'A Session is already working in this Project’s working copy, so this one gets a Checkout of its own.'
}

export function CheckoutPicker({
  projectRoot,
  value,
  reason,
  onChange,
  onSettle,
  disabled
}: {
  projectRoot: string
  value: CheckoutRequest
  /** Set while `value` is still the app's own proposal. Null once chosen. */
  reason?: CheckoutDefaultReason | null
  /** The person picked this. */
  onChange: (checkout: CheckoutRequest) => void
  /**
   * The app settled what the value left open — the base branch an isolated ask
   * arrived without, or Local for a Project with no branch to cut from. Kept
   * apart from `onChange` because settling a base is not somebody choosing,
   * and a default frozen by the app's own bookkeeping would never lift.
   */
  onSettle: (checkout: CheckoutRequest) => void
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
    onSettle(settled ? { kind: 'isolated', baseBranch: settled } : { kind: 'local' })
  }, [value, branches, onSettle])

  const isolated = value.kind === 'isolated'
  const explained = reason ? REASON[reason] : null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ChipTrigger
        aria-label="Checkout"
        // The reason travels on the chip as well as inside the popover: a
        // person who never opens this one still gets a Session somewhere they
        // did not ask for, and a Checkout nobody can see a reason for reads as
        // a bug rather than as a decision.
        {...(explained ? { title: explained } : {})}
        disabled={(disabled ?? false) || !projectRoot}
      >
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
          {explained && (
            <p className="px-2 pt-0.5 pb-1.5 text-2xs text-muted-foreground">{explained}</p>
          )}
          <div role="radiogroup" aria-label="Checkout" className="flex flex-col gap-0.5">
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
                onChange({
                  kind: 'isolated',
                  baseBranch: kept === '' ? defaultBase(branches) : kept
                })
              }}
            />
          </div>
          {branches === 'unreadable' && (
            <p role="alert" className="px-2 py-1.5 text-2xs text-muted-foreground">
              This Project’s branches could not be read, so there is no base to cut a worktree from.
              Local still works.
            </p>
          )}
          {value.kind === 'isolated' && (
            <div className="mt-0.5 border-t border-border pt-1">
              <p className="px-2 py-1 text-2xs text-muted-foreground">Base branch</p>
              {/* The same rows as the choices above rather than a native
                  select: one popover, one look. A base already chosen but no
                  longer listed stays offered — it is what would be cut from. */}
              <ul aria-label="Base branch" className="max-h-40 overflow-y-auto">
                {[
                  ...(value.baseBranch !== '' && !listed(branches).includes(value.baseBranch)
                    ? [value.baseBranch]
                    : []),
                  ...listed(branches)
                ].map((branch) => (
                  <li key={branch}>
                    <button
                      type="button"
                      aria-pressed={branch === value.baseBranch}
                      onClick={() => onChange({ kind: 'isolated', baseBranch: branch })}
                      className="flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1 text-left font-mono text-xs outline-none hover:bg-accent focus-visible:bg-accent"
                    >
                      <span className="min-w-0 flex-1 truncate">{branch}</span>
                      {branch === value.baseBranch && (
                        <Check aria-hidden="true" className="size-3.5 shrink-0" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
