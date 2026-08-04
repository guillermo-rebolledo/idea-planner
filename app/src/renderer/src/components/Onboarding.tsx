import { useCallback, useState } from 'react'
import { FolderGit2, FolderPlus, Info } from 'lucide-react'
import type { ChooseProjectResult, ProjectView } from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

interface OnboardingProps {
  onComplete: (projects: ProjectView[]) => void
}

const COULD_NOT_ADD = 'That folder could not be added.'

/** A folder the app declined, with the exact path the person offered it. */
type Refusal = Extract<ChooseProjectResult, { status: 'refused' }>

/** A folder inside a Project whose root git puts somewhere else. */
type RootConfirmation = Extract<ChooseProjectResult, { status: 'confirm-root' }>

/**
 * First launch, once there is a Harness to work with (mockup 1d): the app
 * needs somewhere to work, and a Project is handed over rather than created —
 * dropped onto the window, or picked from the dialog. Nothing is written into
 * a Project by adding it. Readiness is not asked about here — the launch gate
 * has already settled it, and asking twice would imply it was optional.
 *
 * The git requirement is said up front, not discovered on refusal: git is the
 * only undo for the agent's edits, so it is the one condition worth reading
 * before choosing a folder.
 */
export function Onboarding({ onComplete }: OnboardingProps): React.JSX.Element {
  // Everything added this visit, oldest first — the card shows the latest,
  // but leaving hands the app all of them, because all of them were added.
  const [added, setAdded] = useState<ProjectView[]>([])
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [confirmation, setConfirmation] = useState<RootConfirmation | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draggingOver, setDraggingOver] = useState(false)
  const latest = added.at(-1)

  const adopt = useCallback((result: ChooseProjectResult) => {
    if (result.status === 'cancelled') return
    setRefusal(null)
    setConfirmation(null)
    setFailure(null)
    if (result.status === 'refused') setRefusal(result)
    else if (result.status === 'confirm-root') setConfirmation(result)
    else
      setAdded((current) => [
        ...current.filter((project) => project.root !== result.project.root),
        result.project
      ])
  }, [])

  /** Offers a folder, or answers one of the app's follow-up questions. */
  async function offer(work: () => Promise<ChooseProjectResult>, problem: string): Promise<void> {
    setBusy(true)
    try {
      adopt(await work())
    } catch {
      setFailure(problem)
    } finally {
      setBusy(false)
    }
  }

  function onDrop(event: React.DragEvent): void {
    event.preventDefault()
    setDraggingOver(false)
    if (busy) return
    const file = event.dataTransfer.files[0]
    if (!file) return
    void offer(() => {
      const path = window.shell.pathForFile(file)
      return window.shell.offerProject(path)
    }, COULD_NOT_ADD)
  }

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag-region h-11 shrink-0" aria-hidden="true" />
      <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8">
        <section
          className="flex w-full max-w-lg -translate-y-[4vh] flex-col items-center gap-4"
          aria-labelledby="onboarding-title"
        >
          <div className="flex flex-col items-center gap-3">
            <div
              aria-hidden="true"
              className="flex size-12 items-center justify-center rounded-lg border border-border shadow-sm"
            >
              <FolderPlus className="size-5" />
            </div>

            <div className="text-center">
              <h1 id="onboarding-title" className="text-lg font-semibold tracking-tight">
                Add your first Project
              </h1>
              <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
                A Project is a local git repository. Sessions, approvals and history all belong to
                it — and never leave this Mac.
              </p>
            </div>
          </div>

          <div className="mt-2 flex w-full flex-col items-center gap-2">
            <div
              onDragOver={(event) => {
                event.preventDefault()
                setDraggingOver(true)
              }}
              onDragLeave={(event) => {
                // Leaving a child of the zone is not leaving the zone.
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  setDraggingOver(false)
              }}
              onDrop={onDrop}
              className={cn(
                'flex w-full flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-8',
                draggingOver ? 'border-ring bg-accent' : 'border-border'
              )}
            >
              <p className="text-sm font-medium">Drop a folder here</p>
              <p className="font-mono text-xs text-muted-foreground">~/dev/your-project</p>
              <Button
                className="mt-1.5"
                disabled={busy}
                onClick={() => void offer(() => window.shell.chooseProject(), COULD_NOT_ADD)}
              >
                Choose a folder…
              </Button>
            </div>

            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Info aria-hidden="true" className="size-3 shrink-0" />
              Must be a git repository — git is the only undo for the agent&rsquo;s edits.
            </p>
          </div>

          {refusal && (
            <RefusalNotice
              refusal={refusal}
              busy={busy}
              onDismiss={() => setRefusal(null)}
              onInitialize={(path) =>
                void offer(() => window.shell.initializeProject(path), 'git could not set it up.')
              }
            />
          )}

          {confirmation && (
            <RootConfirmationNotice
              confirmation={confirmation}
              busy={busy}
              onDismiss={() => setConfirmation(null)}
              onConfirm={(root) =>
                void offer(
                  () => window.shell.confirmProject(root),
                  'That Project could not be added.'
                )
              }
            />
          )}

          {failure && (
            <p className="text-xs text-destructive" role="status">
              {failure}
            </p>
          )}

          {latest && (
            <div
              className="flex w-full items-center gap-2 rounded-md border border-border bg-surface px-3 py-2"
              role="status"
            >
              <FolderGit2 aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{latest.name}</span>
                <span className="block truncate font-mono text-2xs text-muted-foreground select-text">
                  {latest.root}
                </span>
              </span>
              <Button onClick={() => onComplete(added)}>Continue</Button>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

/**
 * The folder the person chose sits inside a Project that begins somewhere
 * else. Adding it without saying so would add something they did not pick, so
 * both paths are named and the root is confirmed before anything is stored.
 */
function RootConfirmationNotice({
  confirmation,
  busy,
  onDismiss,
  onConfirm
}: {
  confirmation: RootConfirmation
  busy: boolean
  onDismiss: () => void
  onConfirm: (root: string) => void
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="w-full rounded-md border border-notice-border bg-notice p-2.5 text-xs text-notice-foreground"
    >
      <p>That folder is inside a Project:</p>
      <p className="mt-1 font-mono break-all select-text">{confirmation.chosen}</p>
      <p className="mt-1">The Project itself begins here, and this is what would be added:</p>
      <p className="mt-1 font-mono break-all select-text">{confirmation.root}</p>
      {/* One grammar everywhere: the filled button is the go-ahead, Cancel is
          quiet — exactly as the app menu's twin of this decision draws it. */}
      <div className="mt-2 flex gap-2">
        <Button variant="secondary" size="sm" className="h-6" disabled={busy} onClick={onDismiss}>
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-6"
          disabled={busy}
          onClick={() => onConfirm(confirmation.root)}
        >
          Add this Project
        </Button>
      </div>
    </div>
  )
}

/**
 * Why a folder was refused, and what can be done about it. A missing git is
 * never offered `git init`: the offer would fail for the same reason.
 */
function RefusalNotice({
  refusal,
  busy,
  onDismiss,
  onInitialize
}: {
  refusal: Refusal
  busy: boolean
  onDismiss: () => void
  onInitialize: (path: string) => void
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="w-full rounded-md border border-notice-border bg-notice p-2.5 text-xs text-notice-foreground"
    >
      {refusal.reason === 'not-a-repository' ? (
        <>
          <p>
            This folder is not under git yet, and a Project has to be — every safety guarantee here
            comes from git:
          </p>
          <p className="mt-1 font-mono break-all select-text">{refusal.path}</p>
          <p className="mt-1">
            Setting it up runs <span className="font-mono">git init</span> there and changes nothing
            else. It is the only Git command this app ever runs for you.
          </p>
          {/* The filled button is the go-ahead here too, matching the app
              menu's version of the same decision. */}
          <div className="mt-2 flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              className="h-6"
              disabled={busy}
              onClick={onDismiss}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-6"
              disabled={busy}
              onClick={() => onInitialize(refusal.path)}
            >
              Set up git here
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>git could not be found on this machine, so this folder could not be added:</p>
          <p className="mt-1 font-mono break-all select-text">{refusal.path}</p>
          <p className="mt-1">Install git, then add the folder again.</p>
          <div className="mt-2">
            <Button size="sm" className="h-6" onClick={onDismiss}>
              Close
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
