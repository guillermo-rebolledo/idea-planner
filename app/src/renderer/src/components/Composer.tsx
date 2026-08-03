import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowUp, Check, FolderGit2 } from 'lucide-react'
import {
  type CheckoutRequest,
  type ProjectView,
  type PermissionMode,
  type RunRequest,
  type SessionSummary,
  type StartSessionResult
} from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { CheckoutPicker } from '@renderer/components/CheckoutPicker'
import { Label } from '@renderer/components/ui/label'
import {
  applicableEffort,
  effectiveChoice,
  HarnessNote,
  ModelPicker,
  useModelCatalog,
  type ModelChoice
} from '@renderer/components/ModelPicker'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@renderer/components/ui/menu'
import { PermissionModePicker } from '@renderer/components/PermissionModePicker'
import {
  ChosenSkillNote,
  offeredSkill,
  SkillSuggestions,
  skillsMatching,
  useSkillCatalog
} from '@renderer/components/Skills'
import { cn } from '@renderer/lib/utils'

interface ComposerProps {
  /** Pre-selects a Project, as the button on a Project row does. */
  boundProjectRoot?: string
  onStarted: (started: StartSessionResult) => void
  /** Opens a Session that already exists, as the “Continue” starter does. */
  onOpenSession: (session: SessionSummary) => void
}

/**
 * The launch surface (mockup 1c). One question, one field, one row of chips:
 * the person types, accepts or changes the Project and how the message is
 * answered, and sends. The Session is created by that send and never before
 * it — and the same send starts its first Run, because somebody who has just
 * described the work is not asking for it to be written down.
 *
 * The Project is named in the question itself rather than labelled beside it.
 * A Session edits its Project's checkout in place (ADR 0004), so sending to
 * the wrong one means real edits in the wrong repository: the name is in the
 * sentence nobody can send without reading, and the exact root is one hover
 * or focus away on the control that changes it.
 */
export function Composer({
  boundProjectRoot,
  onStarted,
  onOpenSession
}: ComposerProps): React.JSX.Element {
  const [message, setMessage] = useState('')
  const [projects, setProjects] = useState<ProjectView[]>([])
  const [projectRoot, setProjectRoot] = useState(boundProjectRoot ?? '')
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  // What the person chose for this message, per Project — switching Projects
  // keeps each one's choice. Where nothing was chosen, the default below is
  // the kind that Project's most recent Session used.
  const [chosenCheckout, setChosenCheckout] = useState<Record<string, CheckoutRequest>>({})
  const [lastIsolated, setLastIsolated] = useState<Record<string, boolean>>({})
  // One choice, not three: the model carries the Harness that reaches it.
  const { models, readiness } = useModelCatalog()
  const [chosen, setChosen] = useState<ModelChoice | null>(null)
  // Ask by default: the first Run edits the Project in place, and being asked
  // first is the posture somebody would choose if they were choosing.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask')
  // No Skill by default. Most messages are not asking for a methodology, and
  // one applied because it happened to be selected is one nobody chose.
  const [skill, setSkill] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messageId = useId()
  const messageRef = useRef<HTMLTextAreaElement>(null)
  // Guards the send itself rather than the rendered state, so two keystrokes
  // in one batch cannot both start a Session.
  const sendingRef = useRef(false)
  const disposedRef = useRef(false)

  useEffect(() => {
    disposedRef.current = false
    void Promise.all([window.shell.listProjects(), window.shell.listSessions()])
      .then(([listed, listedSessions]) => {
        if (disposedRef.current) return
        setProjects(listed)
        setSessions(listedSessions)
        // Sessions are newest first, so the first seen per Project is its
        // most recent — and its Checkout kind is that Project's default.
        const byProject: Record<string, boolean> = {}
        for (const session of listedSessions) {
          byProject[session.projectRoot] ??= session.checkout.kind === 'worktree'
        }
        setLastIsolated(byProject)
        setProjectRoot((current) => {
          if (current && listed.some((project) => project.root === current)) return current
          const available = (root: string | undefined): string | undefined =>
            listed.find((project) => project.root === root && project.available)?.root
          // Where the last Session went is where the next one probably goes.
          // Sessions are newest first, so the most recent one is the answer.
          const lastUsed = listedSessions.map((session) => session.projectRoot).find(available)
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

  // A Harness that stops being usable stops being offered, and the choice
  // falls back to one that can still answer a message.
  const choice = effectiveChoice(models, chosen)
  const [catalog] = useSkillCatalog({ projectRoot, harness: choice?.harness ?? null })
  const chosenSkill = offeredSkill(catalog, skill)
  const matchingSkills = skillsMatching(catalog, message)

  const selected = projects.find((project) => project.root === projectRoot)
  const canSend =
    message.trim().length > 0 &&
    selected !== undefined &&
    !sending &&
    // An isolated ask needs its base settled before there is anything to cut.
    (checkout.kind !== 'isolated' || checkout.baseBranch !== '')

  /** Takes the Skill for this message, and the `/` back out of the message. */
  const chooseSkill = useCallback((name: string) => {
    setSkill(name)
    setMessage('')
    messageRef.current?.focus()
  }, [])

  // The most recent Session in the Project being sent to. Continuing one is
  // usually better than starting a second Session about the same work.
  const continuable = useMemo(
    () => sessions.find((session) => session.projectRoot === projectRoot && !session.archivedAt),
    [sessions, projectRoot]
  )

  async function send(): Promise<void> {
    if (!canSend || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setError(null)
    // Absent when no Harness can answer: the Session is still created and
    // keeps its message, and the Conversation is where it is tried again.
    const run: RunRequest | undefined = choice
      ? {
          harness: choice.harness,
          model: choice.model,
          // Only what the chosen model can be asked for.
          effort: applicableEffort(models, choice),
          permissionMode,
          ...(chosenSkill ? { skill: chosenSkill } : {})
        }
      : undefined
    try {
      onStarted(
        await window.shell.startSession({
          projectRoot,
          message: message.trim(),
          checkout,
          ...(run ? { run } : {})
        })
      )
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
      className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-5 p-8"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <h2 className="text-center text-xl font-medium tracking-tight text-balance">
        What should we build in{' '}
        <ProjectChoice
          projects={projects}
          selected={selected}
          onChange={setProjectRoot}
          disabled={sending}
        />
        ?
      </h2>

      <div className="flex flex-col gap-2">
        {matchingSkills !== null && (
          <SkillSuggestions matching={matchingSkills} onChoose={chooseSkill} />
        )}
        <div className="rounded-xl border border-border bg-surface focus-within:ring-2 focus-within:ring-ring">
          <Label htmlFor={messageId} className="sr-only">
            Message
          </Label>
          <textarea
            id={messageId}
            ref={messageRef}
            rows={4}
            value={message}
            placeholder="Describe the work, or / for a Skill…"
            className="w-full resize-none bg-transparent px-3 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground"
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
          {/* The mock's chip row: quiet chips, no labels. Everything the Run
              is configured with is chosen here, because sending starts it. */}
          <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
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
            <PermissionModePicker
              value={permissionMode}
              onChange={setPermissionMode}
              projectRoot={projectRoot}
              disabled={sending}
            />
            <span className="ml-auto">
              <ModelPicker
                catalog={models}
                readiness={readiness}
                choice={choice}
                onChange={setChosen}
                disabled={sending}
              />
            </span>
            {/* Send is the one filled thing on the screen. With nothing to
                send it goes muted rather than half-transparent: an empty
                composer is not a disabled control, it is an unasked question. */}
            <Button
              type="submit"
              size="icon"
              aria-label="Send"
              className="rounded-full disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
              disabled={!canSend}
            >
              <ArrowUp aria-hidden="true" className="size-3.5" />
            </Button>
          </div>
        </div>
        {chosenSkill && <ChosenSkillNote name={chosenSkill} onClear={() => setSkill(null)} />}
        <HarnessNote catalog={models} choice={choice} />
      </div>

      {/* Starters, not suggestions the app pretends to have thought of: two
          openings that fit any Project, and the work already under way. */}
      <ul className="flex flex-wrap justify-center gap-2">
        {STARTERS.map((starter) => (
          <li key={starter}>
            <Starter
              onClick={() => {
                setMessage(starter)
                messageRef.current?.focus()
              }}
            >
              {starter}
            </Starter>
          </li>
        ))}
        {continuable && (
          <li>
            <Starter onClick={() => onOpenSession(continuable)}>
              Continue “{continuable.title}”
            </Starter>
          </li>
        )}
      </ul>

      {projects.length === 0 && (
        <p role="status" className="text-center text-xs text-muted-foreground">
          Add a Project first — a Session works inside one.
        </p>
      )}

      {error && (
        <p role="alert" className="text-center text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}

/** Openings that are true of any Project, so neither one is a guess. */
const STARTERS = ['Fix a failing test', 'Explain this codebase']

function Starter({
  onClick,
  children
}: {
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="max-w-64 truncate rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  )
}

/**
 * The Project, inside the question. Dashed underneath because it is the one
 * word in the sentence that can be changed; the exact root travels with it,
 * on the control itself and again on every option, because "weather-app" is
 * a folder name and a Mac can hold several.
 */
function ProjectChoice({
  projects,
  selected,
  onChange,
  disabled
}: {
  projects: ProjectView[]
  selected: ProjectView | undefined
  onChange: (root: string) => void
  disabled: boolean
}): React.JSX.Element {
  return (
    <Menu>
      <MenuTrigger
        title={selected?.root ?? 'No Projects yet'}
        disabled={disabled || projects.length === 0}
        className="rounded-sm font-medium underline decoration-muted-foreground decoration-dashed underline-offset-[6px] hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {selected?.name ?? 'no Project yet'}
        {/* Spoken, not shown: the folder name is what a person recognises,
            and the root is what tells two folders of that name apart — so a
            screen reader hears both without the sentence carrying a path. */}
        <span className="sr-only">
          {selected ? ` Project — ${selected.root}. Change Project` : ' Project'}
        </span>
      </MenuTrigger>
      <MenuContent align="center" className="max-w-96">
        {projects.map((project) => (
          <MenuItem
            key={project.root}
            disabled={!project.available}
            onClick={() => onChange(project.root)}
            className={cn('flex-col items-start gap-0.5', !project.available && 'opacity-60')}
          >
            <span className="flex w-full items-center gap-2">
              <FolderGit2 aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
              {project.name}
              {!project.available && <span className="text-muted-foreground">— unavailable</span>}
              {project.root === selected?.root && (
                <Check aria-hidden="true" className="ml-auto size-3.5" />
              )}
            </span>
            {/* The exact directory that will be edited, never abbreviated. */}
            <span className="w-full font-mono text-2xs break-all text-muted-foreground">
              {project.root}
            </span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}
