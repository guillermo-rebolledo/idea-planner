import { useCallback, useState } from 'react'
import type { ProjectView } from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { Projects } from '@renderer/components/Projects'

interface OnboardingProps {
  onComplete: (projects: ProjectView[]) => void
}

/**
 * First launch, once there is a Harness to work with: the app needs somewhere
 * to work, and nothing is written into a Project by adding it. Readiness is
 * not asked about here — the launch gate has already settled it, and asking
 * twice would imply it was optional.
 */
export function Onboarding({ onComplete }: OnboardingProps): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectView[]>([])

  const adoptProjects = useCallback((next: ProjectView[]) => setProjects(next), [])

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag-region h-11 shrink-0" aria-hidden="true" />
      <main className="flex flex-1 items-center justify-center p-8">
        <section className="w-full max-w-md" aria-labelledby="onboarding-title">
          <h1 id="onboarding-title" className="text-lg font-medium">
            Add your first Project
          </h1>
          <p className="mt-2 leading-relaxed text-muted-foreground">
            A Project is a folder on your Mac under git. Your work stays in it, exactly where it is
            — adding it reads nothing and changes nothing.
          </p>

          <div className="mt-6 rounded-md border border-border bg-surface">
            <Projects onProjectsChanged={adoptProjects} />
          </div>

          <div className="mt-6 flex justify-end">
            <Button disabled={projects.length === 0} onClick={() => onComplete(projects)}>
              Continue
            </Button>
          </div>
        </section>
      </main>
    </div>
  )
}
