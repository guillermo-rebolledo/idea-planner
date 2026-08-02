import { useCallback, useState } from 'react'
import type { ProjectView, ReadinessSnapshot } from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { Projects } from '@renderer/components/Projects'
import { ReadinessPanel } from '@renderer/components/Readiness'

interface OnboardingProps {
  onComplete: (projects: ProjectView[]) => void
}

/**
 * First launch. Step one adds the first Project — the app has nowhere to work
 * until there is one, and nothing is written into it by adding it. Step two
 * checks Harness readiness and is entirely optional: readiness is repaired by
 * the person, never by the app, and can be checked again later in Settings.
 */
export function Onboarding({ onComplete }: OnboardingProps): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectView[]>([])
  const [step, setStep] = useState<'project' | 'readiness'>('project')
  const [readiness, setReadiness] = useState<ReadinessSnapshot | null>(null)

  const adoptProjects = useCallback((next: ProjectView[]) => setProjects(next), [])

  if (step === 'readiness') {
    return (
      <div className="flex h-full flex-col">
        <header className="app-drag-region h-11 shrink-0" aria-hidden="true" />
        <main className="flex min-h-0 flex-1 justify-center overflow-y-auto p-8">
          <section className="w-full max-w-xl" aria-labelledby="readiness-title">
            <h1 id="readiness-title" className="text-lg font-semibold">
              Check Harness readiness
            </h1>
            <p className="mt-2 leading-relaxed text-muted-foreground">
              This step is optional. You can add and organize Projects and Sessions without any
              Harness, and check readiness again later in Settings.
            </p>
            <div className="mt-6">
              <ReadinessPanel onSnapshot={setReadiness} />
            </div>
            <div className="mt-6 flex justify-end">
              <Button onClick={() => onComplete(projects)}>
                {readiness?.harnesses.some((harness) => harness.available)
                  ? 'Continue'
                  : 'Continue without a Harness'}
              </Button>
            </div>
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag-region h-11 shrink-0" aria-hidden="true" />
      <main className="flex flex-1 items-center justify-center p-8">
        <section className="w-full max-w-md" aria-labelledby="onboarding-title">
          <h1 id="onboarding-title" className="text-lg font-semibold">
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
            <Button disabled={projects.length === 0} onClick={() => setStep('readiness')}>
              Continue
            </Button>
          </div>
        </section>
      </main>
    </div>
  )
}
