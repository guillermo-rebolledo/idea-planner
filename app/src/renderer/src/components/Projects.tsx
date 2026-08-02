import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, FolderGit2, FolderPlus, X } from 'lucide-react'
import type { ChooseProjectResult, ProjectView } from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

type ProjectList =
  { state: 'loading' } | { state: 'ready'; projects: ProjectView[] } | { state: 'failed' }

/** A folder the app declined, with the exact path the person offered it. */
type Refusal = Extract<ChooseProjectResult, { status: 'refused' }>

/** A folder inside a Project whose root git puts somewhere else. */
type RootConfirmation = Extract<ChooseProjectResult, { status: 'confirm-root' }>

/**
 * The Projects section of the sidebar. A Project is a local git repository the
 * person added; git decides whether a folder qualifies and what its root is
 * (ADR 0005), so this surface only ever offers folders and reports answers.
 */
export function Projects(): React.JSX.Element {
  const [list, setList] = useState<ProjectList>({ state: 'loading' })
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [confirmation, setConfirmation] = useState<RootConfirmation | null>(null)
  const [busy, setBusy] = useState(false)
  const [announcement, setAnnouncement] = useState('')

  const refresh = useCallback(async () => {
    try {
      setList({ state: 'ready', projects: await window.shell.listProjects() })
    } catch {
      setList({ state: 'failed' })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const adopt = useCallback(
    async (result: ChooseProjectResult) => {
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
      setAnnouncement(`Added “${result.project.name}”.`)
      await refresh()
    },
    [refresh]
  )

  async function confirmProject(root: string): Promise<void> {
    setBusy(true)
    try {
      await adopt(await window.shell.confirmProject(root))
    } catch {
      setAnnouncement('That Project could not be added.')
    } finally {
      setBusy(false)
    }
  }

  async function addProject(): Promise<void> {
    setBusy(true)
    try {
      await adopt(await window.shell.chooseProject())
    } catch {
      setAnnouncement('That folder could not be added.')
    } finally {
      setBusy(false)
    }
  }

  // Runs only because the person accepted the offer for this exact folder.
  async function startTrackingWithGit(path: string): Promise<void> {
    setBusy(true)
    try {
      await adopt(await window.shell.initializeProject(path))
    } catch {
      setAnnouncement('git could not set that folder up.')
    } finally {
      setBusy(false)
    }
  }

  async function removeProject(project: ProjectView): Promise<void> {
    try {
      await window.shell.removeProject(project.root)
      setAnnouncement(`Removed “${project.name}”. Nothing on disk was touched.`)
    } catch {
      setAnnouncement(`Could not remove “${project.name}”.`)
    }
    await refresh()
  }

  return (
    <section aria-label="Projects" className="flex flex-col gap-1 border-b border-border p-2">
      <div className="flex items-center gap-1.5 px-1">
        <h2 className="text-[10px] font-semibold tracking-wide uppercase">Projects</h2>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6"
          disabled={busy}
          onClick={() => void addProject()}
        >
          <FolderPlus aria-hidden="true" className="size-3.5" />
          Add Project
        </Button>
      </div>

      <ProjectListContent
        list={list}
        onRetry={() => void refresh()}
        onRemove={(project) => void removeProject(project)}
      />

      {refusal && (
        <RefusalNotice
          refusal={refusal}
          busy={busy}
          onDismiss={() => setRefusal(null)}
          onInitialize={(path) => void startTrackingWithGit(path)}
        />
      )}

      {confirmation && (
        <RootConfirmationNotice
          confirmation={confirmation}
          busy={busy}
          onDismiss={() => setConfirmation(null)}
          onConfirm={(root) => void confirmProject(root)}
        />
      )}

      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
    </section>
  )
}

function ProjectListContent({
  list,
  onRetry,
  onRemove
}: {
  list: ProjectList
  onRetry: () => void
  onRemove: (project: ProjectView) => void
}): React.JSX.Element {
  if (list.state === 'loading') {
    return <p className="px-1 py-1 text-[11px] text-muted-foreground">Reading your Projects…</p>
  }

  if (list.state === 'failed') {
    return (
      <div role="alert" className="flex flex-col items-start gap-1 px-1 py-1">
        <p className="text-[11px] text-muted-foreground">Your Projects could not be read.</p>
        <Button variant="secondary" size="sm" className="h-6" onClick={onRetry}>
          Try again
        </Button>
      </div>
    )
  }

  if (list.projects.length === 0) {
    return (
      <p className="px-1 py-1 text-[11px] text-muted-foreground">
        No Projects yet. Add the folder you work in.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-px">
      {list.projects.map((project) => (
        <ProjectRow key={project.root} project={project} onRemove={onRemove} />
      ))}
    </ul>
  )
}

function ProjectRow({
  project,
  onRemove
}: {
  project: ProjectView
  onRemove: (project: ProjectView) => void
}): React.JSX.Element {
  return (
    <li className="group relative">
      <div
        className={cn(
          'flex w-full items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-left',
          project.available ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        <FolderGit2 aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs">{project.name}</span>
          {/* The exact identity of the Project, never abbreviated away. */}
          <span className="block truncate font-mono text-[10px] text-muted-foreground select-text">
            {project.root}
          </span>
        </span>
        {!project.available && (
          <span className="flex shrink-0 items-center gap-1 rounded-sm bg-notice px-1 text-[10px] font-medium text-notice-foreground">
            <AlertTriangle aria-hidden="true" className="size-2.5" />
            Unavailable
          </span>
        )}
      </div>
      <button
        type="button"
        aria-label={`Remove “${project.name}” from the app`}
        title={`Remove “${project.name}” from the app`}
        onClick={() => onRemove(project)}
        className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-border hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </li>
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
      className="mt-1 rounded-md border border-notice-border bg-notice p-2 text-[11px] text-notice-foreground"
    >
      <p>That folder is inside a Project:</p>
      <p className="mt-1 font-mono break-all select-text">{confirmation.chosen}</p>
      <p className="mt-1">The Project itself begins here, and this is what would be added:</p>
      <p className="mt-1 font-mono break-all select-text">{confirmation.root}</p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" className="h-6" disabled={busy} onClick={onDismiss}>
          Cancel
        </Button>
        <Button
          variant="secondary"
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
      className="mt-1 rounded-md border border-notice-border bg-notice p-2 text-[11px] text-notice-foreground"
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
          <div className="mt-2 flex gap-2">
            <Button size="sm" className="h-6" disabled={busy} onClick={onDismiss}>
              Cancel
            </Button>
            <Button
              variant="secondary"
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
