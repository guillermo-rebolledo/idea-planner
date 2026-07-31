import { useId, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { IdeaKind, IdeaSummary } from '@shared/contract'
import { suggestIdeaTitle } from '@shared/title'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Textarea } from '@renderer/components/ui/textarea'
import { IDEA_KIND_META } from '@renderer/components/idea-kind'
import { cn } from '@renderer/lib/utils'

interface CaptureFormProps {
  onSaved: (idea: IdeaSummary) => void
  onCancel: () => void
}

/**
 * New Idea capture. Save for later persists locally without any AI or
 * provider readiness. The title is a deterministic local suggestion until the
 * person edits it themselves.
 */
export function CaptureForm({ onSaved, onCancel }: CaptureFormProps): React.JSX.Element {
  const [kind, setKind] = useState<IdeaKind>('software')
  const [notes, setNotes] = useState('')
  const [title, setTitle] = useState('')
  const [titleEdited, setTitleEdited] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  const notesId = useId()

  function handleNotesChange(value: string): void {
    setNotes(value)
    if (!titleEdited) setTitle(value.trim() ? suggestIdeaTitle(value) : '')
  }

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      onSaved(await window.ideaShell.captureIdea({ kind, title, notes }))
    } catch {
      setError('The Idea could not be saved. Nothing was lost — try again.')
      setSaving(false)
    }
  }

  return (
    <form
      className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6"
      aria-label="New Idea"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) onCancel()
      }}
    >
      <h2 className="text-base font-semibold">New Idea</h2>

      <div
        className="flex items-start gap-2 rounded-md border border-notice-border bg-notice px-3 py-2 text-notice-foreground"
        role="note"
      >
        <ShieldAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <p className="text-xs leading-relaxed">
          Don&rsquo;t include passwords, API keys, or other secrets. Ideas are saved as plain
          Markdown files on your Mac.
        </p>
      </div>

      <fieldset>
        <legend className="text-xs font-medium text-muted-foreground">Kind of Idea</legend>
        <div className="mt-1.5 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Kind of Idea">
          {(Object.keys(IDEA_KIND_META) as IdeaKind[]).map((value) => (
            <label
              key={value}
              className={cn(
                'cursor-pointer rounded-md border px-3 py-2 transition-colors',
                kind === value ? 'border-ring bg-accent' : 'border-border bg-surface hover:bg-accent'
              )}
            >
              <input
                type="radio"
                name="idea-kind"
                value={value}
                checked={kind === value}
                onChange={() => setKind(value)}
                className="sr-only"
              />
              <span className="block font-medium">{IDEA_KIND_META[value].label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {IDEA_KIND_META[value].hint}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={notesId}>What&rsquo;s the idea?</Label>
        <Textarea
          id={notesId}
          rows={6}
          autoFocus
          value={notes}
          onChange={(event) => handleNotesChange(event.target.value)}
          placeholder="Capture the rough thought. You can develop it with AI later — or never."
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
          placeholder="Untitled Idea"
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
        <p className="ml-auto text-xs text-muted-foreground">Saves locally. No AI runs.</p>
      </div>
    </form>
  )
}
