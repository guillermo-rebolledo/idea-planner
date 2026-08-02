import { useEffect, useId, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { SessionSummary, ReadinessSnapshot } from '@shared/contract'
import { suggestSessionTitle } from '@shared/title'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Textarea } from '@renderer/components/ui/textarea'

interface CaptureFormProps {
  onSaved: (session: SessionSummary) => void
  onCancel: () => void
  onShowReadiness: () => void
}

/**
 * New Session capture. Save for later persists locally without any Harness
 * readiness. The title is a deterministic local suggestion until the person
 * edits it themselves.
 */
export function CaptureForm({
  onSaved,
  onCancel,
  onShowReadiness
}: CaptureFormProps): React.JSX.Element {
  const [notes, setNotes] = useState('')
  const [title, setTitle] = useState('')
  const [titleEdited, setTitleEdited] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  const notesId = useId()
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
    return () => {
      disposed = true
    }
  }, [])

  const readyHarnesses = readiness?.harnesses.filter((harness) => harness.available) ?? []

  function handleNotesChange(value: string): void {
    setNotes(value)
    if (!titleEdited) setTitle(value.trim() ? suggestSessionTitle(value) : '')
  }

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      onSaved(await window.shell.captureSession({ title, notes }))
    } catch {
      setError('The Session could not be saved. Nothing was lost — try again.')
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

      <div
        className="flex items-start gap-2 rounded-md border border-notice-border bg-notice px-3 py-2 text-notice-foreground"
        role="note"
      >
        <ShieldAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <p className="text-xs leading-relaxed">
          Don&rsquo;t include passwords, API keys, or other secrets. Sessions are saved as plain
          Markdown files on your Mac.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={notesId}>What&rsquo;s this Session about?</Label>
        <Textarea
          id={notesId}
          rows={6}
          // Capture-first: this view exists only because the person chose to
          // start a Session, so the notes field takes focus deliberately.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={notes}
          onChange={(event) => handleNotesChange(event.target.value)}
          placeholder="Capture the rough thought. You can develop it with a Harness later — or never."
          disabled={saving}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={titleId}>Title</Label>
        <Input
          id={titleId}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value)
            setTitleEdited(true)
          }}
          placeholder="Untitled Session"
          disabled={saving}
          aria-description="Suggested automatically from your notes. Edit it freely."
        />
        {!titleEdited && title && (
          <p className="text-xs text-muted-foreground">Suggested from your notes — edit freely.</p>
        )}
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save for later'}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <p className="ml-auto text-xs text-muted-foreground">Saves locally. No Run starts.</p>
      </div>

      <p className="text-xs text-muted-foreground">
        {readiness === null
          ? 'Checking Harness readiness…'
          : readyHarnesses.length > 0
            ? `Ready Harnesses: ${readyHarnesses.map((harness) => harness.displayName).join(', ')}.`
            : 'No Harness is ready — this Session saves in capture-only mode.'}{' '}
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
