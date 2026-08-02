import { useEffect, useId, useState } from 'react'
import type { ProjectView, ReadinessSnapshot, SessionSummary } from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'

interface CaptureFormProps {
  onStarted: (session: SessionSummary) => void
  onCancel: () => void
  onShowReadiness: () => void
}

/**
 * Starting a Session. A Session belongs to a Project, so the Project is chosen
 * here and nothing is written into it. Ticket 05b replaces this form with the
 * composer on the Project row.
 */
export function CaptureForm({
  onStarted,
  onCancel,
  onShowReadiness
}: CaptureFormProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [projects, setProjects] = useState<ProjectView[]>([])
  const [projectRoot, setProjectRoot] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  const projectId = useId()
  // The same readiness the person saw in onboarding and Settings, restated
  // immediately before any Run could be started from this Session.
  const [readiness, setReadiness] = useState<ReadinessSnapshot | null>(null)

  useEffect(() => {
    let disposed = false
    const adopt = (snapshot: ReadinessSnapshot): void => {
      if (!disposed) setReadiness(snapshot)
    }
    // Show the last known snapshot immediately, then re-probe so the answer
    // reflects the machine as it is now, not as it was at launch.
    window.shell.getReadiness().then(adopt, () => undefined)
    window.shell.refreshReadiness().then(adopt, () => undefined)
    window.shell.listProjects().then(
      (known) => {
        if (disposed) return
        setProjects(known)
        setProjectRoot((current) => current || (known[0]?.root ?? ''))
      },
      () => undefined
    )
    return () => {
      disposed = true
    }
  }, [])

  const readyHarnesses = readiness?.harnesses.filter((harness) => harness.available) ?? []

  async function save(): Promise<void> {
    if (!projectRoot || !title.trim()) return
    setSaving(true)
    setError(null)
    try {
      onStarted(await window.shell.startSession({ projectRoot, title: title.trim() }))
    } catch {
      setError('The Session could not be started. Nothing was changed — try again.')
      setSaving(false)
    }
  }

  return (
    // The Escape shortcut is bound on the form so it works from any field.
    // Focus always lives on an inner control, so nothing here is a substitute
    // for an interactive element.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <form
      className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6"
      aria-label="New Session"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) onCancel()
      }}
    >
      <h2 className="text-base font-semibold">New Session</h2>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={projectId}>Project</Label>
        <select
          id={projectId}
          value={projectRoot}
          onChange={(event) => setProjectRoot(event.target.value)}
          disabled={saving}
          className="h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {projects.map((project) => (
            <option key={project.root} value={project.root}>
              {project.name}
            </option>
          ))}
        </select>
        {/* The exact directory the Session works in, never abbreviated away. */}
        {projectRoot && (
          <p className="font-mono text-xs break-all text-muted-foreground select-text">
            {projectRoot}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={titleId}>What are you working on?</Label>
        <Input
          id={titleId}
          // The person opened this view deliberately, so the first field takes
          // focus rather than making them reach for it.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Fix the failing build"
          disabled={saving}
        />
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={saving || !projectRoot || !title.trim()}>
          {saving ? 'Starting…' : 'Start Session'}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <p className="ml-auto text-xs text-muted-foreground">
          Nothing is written into your Project.
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        {readiness === null
          ? 'Checking Harness readiness…'
          : readyHarnesses.length > 0
            ? `Ready Harnesses: ${readyHarnesses.map((harness) => harness.displayName).join(', ')}.`
            : 'No Harness is ready, so this Session cannot start a Run yet.'}{' '}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={onShowReadiness}
        >
          Harness readiness…
        </button>
      </p>
    </form>
  )
}
