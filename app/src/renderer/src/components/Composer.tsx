import { useEffect, useId, useRef, useState } from 'react'
import { FolderGit2, Send } from 'lucide-react'
import type { CheckoutRequest, ProjectView, SessionSummary } from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { CheckoutPicker } from '@renderer/components/CheckoutPicker'
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
  // What the person chose for this message, per Project — switching Projects
  // keeps each one's choice. Where nothing was chosen, the default below is
  // the kind that Project's most recent Session used.
  const [chosenCheckout, setChosenCheckout] = useState<Record<string, CheckoutRequest>>({})
  const [lastIsolated, setLastIsolated] = useState<Record<string, boolean>>({})
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messageId = useId()
  const projectId = useId()
  const messageRef = useRef<HTMLTextAreaElement>(null)
  // Guards the send itself rather than the rendered state, so two keystrokes
  // in one batch cannot both start a Session.
  const sendingRef = useRef(false)
  const disposedRef = useRef(false)

  useEffect(() => {
    disposedRef.current = false
    void Promise.all([window.shell.listProjects(), window.shell.listSessions()])
      .then(([listed, sessions]) => {
        if (disposedRef.current) return
        setProjects(listed)
        // Sessions are newest first, so the first seen per Project is its
        // most recent — and its Checkout kind is that Project's default.
        const byProject: Record<string, boolean> = {}
        for (const session of sessions) {
          byProject[session.projectRoot] ??= session.checkout.kind === 'worktree'
        }
        setLastIsolated(byProject)
        setProjectRoot((current) => {
          if (current && listed.some((project) => project.root === current)) return current
          const available = (root: string | undefined): string | undefined =>
            listed.find((project) => project.root === root && project.available)?.root
          // Where the last Session went is where the next one probably goes.
          // Sessions are newest first, so the most recent one is the answer.
          const lastUsed = sessions.map((session) => session.projectRoot).find(available)
          return lastUsed ?? listed.find((project) => project.available)?.root ?? ''
        })
      })
      .catch(() => undefined)
    return () => {
      disposedRef.current = true
    }
  }, [])

  useEffect(() => {
    messageRef.current?.focus()
  }, [])

  // Derived rather than corrected: the choice for this Project when one was
  // made, otherwise the kind its most recent Session used.
  const checkout: CheckoutRequest =
    chosenCheckout[projectRoot] ??
    (lastIsolated[projectRoot] ? { kind: 'isolated', baseBranch: '' } : { kind: 'local' })

  const selected = projects.find((project) => project.root === projectRoot)
  const canSend =
    message.trim().length > 0 &&
    selected !== undefined &&
    !sending &&
    // An isolated ask needs its base settled before there is anything to cut.
    (checkout.kind !== 'isolated' || checkout.baseBranch !== '')

  async function send(): Promise<void> {
    if (!canSend || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setError(null)
    try {
      onStarted(await window.shell.startSession({ projectRoot, message: message.trim(), checkout }))
    } catch {
      if (!disposedRef.current) setError('That Session could not be started.')
    } finally {
      sendingRef.current = false
      // A successful send unmounts this surface; only a failure comes back.
      if (!disposedRef.current) setSending(false)
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
        <h2 className="text-lg font-medium">What are we working on?</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Sending starts a Session in the Project below and edits it in place.
        </p>
      </div>

      <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 p-3">
        <Label htmlFor={projectId} className="text-xs font-medium">
          Working in
        </Label>
        <div className="flex items-center gap-2">
          <FolderGit2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <select
            id={projectId}
            value={projectRoot}
            disabled={projects.length === 0}
            className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm font-medium"
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
        </div>
        {/* The exact directory that will be edited, never abbreviated. */}
        {selected && (
          <p className="font-mono text-xs break-all text-muted-foreground select-text">
            {selected.root}
          </p>
        )}
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
          onChange={(event) => {
            setMessage(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            // Mid-composition Enter belongs to the input method, not to us.
            if (event.nativeEvent.isComposing) return
            // Shift or Alt makes a newline; Enter alone, or with Cmd, sends.
            if (event.shiftKey || event.altKey) return
            event.preventDefault()
            void send()
          }}
        />
        <div className="flex items-center gap-1 border-t border-border p-2">
          {/* The Checkout is fixed at creation, so this chip exists only here:
              once the Session is started it freezes into the title bar. */}
          <CheckoutPicker
            projectRoot={projectRoot}
            value={checkout}
            onChange={(next) =>
              setChosenCheckout((current) => ({ ...current, [projectRoot]: next }))
            }
            disabled={sending}
          />
          <Button type="submit" size="sm" className="ml-auto h-7" disabled={!canSend}>
            <Send aria-hidden="true" className="size-3.5" /> Send
          </Button>
        </div>
      </div>

      {projects.length === 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          Add a Project first — a Session works inside one.
        </p>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}
