import { useState } from 'react'
import { FolderPlus } from 'lucide-react'
import type { ProjectView } from '@shared/contract'
import { AddProjectDialog } from '@renderer/components/AddProjectDialog'
import { Button } from '@renderer/components/ui/button'

interface OnboardingProps {
  onComplete: (projects: ProjectView[]) => void
}

/** The empty workspace remains useful after dismissing first-run Add Project. */
export function Onboarding({ onComplete }: OnboardingProps): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(true)

  return (
    <div className="relative flex h-full bg-background">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface p-2">
        <div className="app-drag-region h-9 shrink-0" />
        <div className="flex items-center px-2 py-1 text-2xs tracking-wide text-muted-foreground uppercase">
          Projects
          <button
            type="button"
            aria-label="New Project"
            onClick={() => setDialogOpen(true)}
            className="ml-auto grid size-6 place-items-center rounded-md hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FolderPlus aria-hidden="true" className="size-3.5" />
          </button>
        </div>
        <div className="mt-auto border-t border-border px-2 py-3 text-xs text-muted-foreground">
          Argos
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="app-drag-region h-11 shrink-0 border-b border-border" />
        <div className="grid min-h-0 flex-1 place-items-center px-6 pb-16 text-center">
          <div className="max-w-sm">
            <div className="mx-auto grid size-12 place-items-center rounded-xl border border-border bg-surface shadow-sm">
              <FolderPlus aria-hidden="true" className="size-5 text-muted-foreground" />
            </div>
            <h1 className="mt-4 text-lg font-semibold tracking-tight">Add your first Project</h1>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Open a local folder or clone a repository to start working with an agent.
            </p>
            <Button className="mt-5" onClick={() => setDialogOpen(true)}>
              <FolderPlus aria-hidden="true" className="size-3.5" />
              Add Project
            </Button>
          </div>
        </div>
      </main>

      {dialogOpen && (
        <AddProjectDialog
          onAdded={(project) => onComplete([project])}
          onDismiss={() => setDialogOpen(false)}
        />
      )}
    </div>
  )
}
