import { useEffect, useId, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import type { ProjectView, SessionSummary } from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'

interface ComposerProps {
  /** Pre-selects a Project, as the button on a Project row does. */
  boundProjectRoot?: string
  onStarted: (session: SessionSummary) => void
}

/**
 * The launch surface. The person types, accepts or changes the Project, and
 * sends; the Session is created by that send and never before it.
 *
 * The Project is stated plainly rather than tucked into a subtle control: a
 * Session edits its Project's checkout in place (ADR 0004), so sending to the
 * wrong one means real edits in the wrong repository.
 */
export function Composer({ boundProjectRoot, onStarted }: ComposerProps): React.JSX.Element {
  const [message, setMessage] = useState('')
  const [projects, setProjects] = useState<ProjectView[]>([])
  const [projectRoot, setProjectRoot] = useState(boundProjectRoot ?? '')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messageId = useId()
  const projectId = useId()
  const messageRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let disposed = false
    void window.shell
      .listProjects()
      .then((listed) => {
        if (disposed) return
        setProjects(listed)
        setProjectRoot((current) => {
          if (current && listed.some((project) => project.root === current)) return current
          return listed.find((project) => project.available)?.root ?? listed[0]?.root ?? ''
        })
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [boundProjectRoot])

  useEffect(() => {
    messageRef.current?.focus()
  }, [])

  const selected = projects.find((project) => project.root === projectRoot)
  const canSend = message.trim().length > 0 && selected !== undefined && !sending

  async function send(): Promise<void> {
    if (!canSend) return
    setSending(true)
    setError(null)
    try {
      onStarted(await window.shell.startSession({ projectRoot, message: message.trim() }))
    } catch {
      setError('That Session could not be started.')
    } finally {
      setSending(false)
    }
  }

  return (
    <form
      aria-label="New chat"
      className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-3 p-8"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <div>
        <h2 className="text-lg font-semibold">What are we working on?</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Sending starts a Session in the Project below and edits it in place.
        </p>
      </div>

      <div className="rounded-md border border-border bg-surface focus-within:ring-2 focus-within:ring-ring">
        <Label htmlFor={messageId} className="sr-only">
          Message
        </Label>
        <textarea
          id={messageId}
          ref={messageRef}
          rows={5}
          value={message}
          placeholder="Describe the change you want"
          className="w-full resize-none bg-transparent p-3 text-sm outline-none"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; a newline needs a modifier, as everywhere else.
            if (event.key === 'Enter' && !event.shiftKey && (event.metaKey || !event.altKey)) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <div className="flex items-center gap-2 border-t border-border p-2">
          <Label htmlFor={projectId} className="text-[11px] text-muted-foreground">
            Project
          </Label>
          <select
            id={projectId}
            value={projectRoot}
            disabled={projects.length === 0}
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs"
            onChange={(event) => setProjectRoot(event.target.value)}
          >
            {projects.length === 0 && <option value="">No Projects yet</option>}
            {projects.map((project) => (
              <option key={project.root} value={project.root} disabled={!project.available}>
                {project.name}
                {project.available ? '' : ' — unavailable'}
              </option>
            ))}
          </select>
          <Button type="submit" size="sm" className="h-7" disabled={!canSend}>
            <Send aria-hidden="true" className="size-3.5" /> Send
          </Button>
        </div>
      </div>

      {/* The exact directory that will be edited, never abbreviated. */}
      {selected && (
        <p className="font-mono text-[11px] break-all text-muted-foreground select-text">
          {selected.root}
        </p>
      )}

      {projects.length === 0 && (
        <p role="status" className="text-[11px] text-muted-foreground">
          Add a Project first — a Session works inside one.
        </p>
      )}

      {error && (
        <p role="status" className="text-[11px] text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}
