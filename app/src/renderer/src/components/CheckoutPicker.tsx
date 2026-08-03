import { useEffect, useState } from 'react'
import { Check, FolderTree, Monitor } from 'lucide-react'
import type { BranchList, CheckoutRequest } from '@shared/contract'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@renderer/lib/utils'

/**
 * The Checkout chip for a Session that does not exist yet. A Checkout is
 * fixed at creation, so this is the one moment there is anything to choose:
 * Local — the Project's working copy, edited in place (ADR 0004) — or an
 * isolated checkout, a linked worktree cut from a chosen base branch. Once
 * the Session exists the choice freezes into the title-bar cluster.
 */
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
  const [branches, setBranches] = useState<BranchList | null>(null)

  // Observed when the popover opens — branches move in any terminal at any
  // time — and also when an isolated default arrives with no base yet, so the
  // chip can settle onto a real branch without being clicked.
  const unsettled = value.kind === 'isolated' && value.baseBranch === ''
  useEffect(() => {
    if ((!open && !unsettled) || !projectRoot) return
    void window.shell.listBranches(projectRoot).then(setBranches, () => setBranches(null))
  }, [open, unsettled, projectRoot])

  // Isolated was chosen before the branches had loaded: settle the base onto
  // the branch the working copy is on as soon as it is known. A Project with
  // no branch at all has nothing to cut from, so the chip falls back to Local
  // rather than leaving Send disabled with nothing to say.
  useEffect(() => {
    if (value.kind !== 'isolated' || value.baseBranch !== '' || !branches) return
    const settled = branches.current ?? branches.branches[0]
    onChange(settled ? { kind: 'isolated', baseBranch: settled } : { kind: 'local' })
  }, [value, branches, onChange])

  const isolated = value.kind === 'isolated'
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* A chip in the composer's row: quiet text, no outline, no glyph —
          the row is read as a sentence about this message, not as a toolbar. */}
      <PopoverTrigger
        aria-label="Checkout"
        disabled={(disabled ?? false) || !projectRoot}
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {value.kind === 'isolated' ? (
          <>
            Worktree
            {value.baseBranch && <span className="font-mono">· {value.baseBranch}</span>}
          </>
        ) : (
          'Local'
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <p className="px-3 pt-2.5 pb-1 font-mono text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
          Checkout
        </p>
        <div className="flex flex-col gap-0.5 px-1.5 pb-2">
          <button
            type="button"
            className={cn(
              'rounded-md px-2 py-1.5 text-left hover:bg-muted/60',
              !isolated && 'bg-accent'
            )}
            onClick={() => {
              onChange({ kind: 'local' })
              setOpen(false)
            }}
          >
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <Monitor aria-hidden="true" className="size-3 shrink-0" />
              Local
              {!isolated && <Check aria-hidden="true" className="ml-auto size-3" />}
            </span>
            <span className="mt-0.5 block text-2xs leading-relaxed text-muted-foreground">
              Your working copy, edited in place. git is the undo.
            </span>
          </button>
          <button
            type="button"
            className={cn(
              'rounded-md px-2 py-1.5 text-left hover:bg-muted/60',
              isolated && 'bg-accent'
            )}
            onClick={() => {
              const kept = value.kind === 'isolated' ? value.baseBranch : ''
              const fallback = branches?.current ?? branches?.branches[0] ?? ''
              onChange({ kind: 'isolated', baseBranch: kept === '' ? fallback : kept })
            }}
          >
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <FolderTree aria-hidden="true" className="size-3 shrink-0" />
              Isolated
              {isolated && <Check aria-hidden="true" className="ml-auto size-3" />}
            </span>
            <span className="mt-0.5 block text-2xs leading-relaxed text-muted-foreground">
              A linked worktree of its own, cut from the base branch below. Your copy never moves.
            </span>
          </button>
          {value.kind === 'isolated' && (
            <label className="flex items-center gap-2 px-2 py-1.5 text-2xs text-muted-foreground">
              Base branch
              <select
                aria-label="Base branch"
                value={value.baseBranch}
                className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 font-mono text-xs"
                onChange={(event) => onChange({ kind: 'isolated', baseBranch: event.target.value })}
              >
                {value.baseBranch !== '' && !branches?.branches.includes(value.baseBranch) && (
                  <option value={value.baseBranch}>{value.baseBranch}</option>
                )}
                {(branches?.branches ?? []).map((branch) => (
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
