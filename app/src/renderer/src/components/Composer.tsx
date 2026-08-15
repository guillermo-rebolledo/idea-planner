import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowUp, Check, FolderGit2 } from 'lucide-react'
import {
  defaultCheckout,
  resolveCheckout,
  shortCommit,
  type Checkout,
  type CheckoutRequest,
  type ProjectView,
  type PermissionMode,
  type RunRequest,
  type SessionSummary,
  type StartedSessionResult,
  type WorktreeBootstrapProvenance,
  type WorktreeBootstrapResult
} from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { CheckoutPicker } from '@renderer/components/CheckoutPicker'
import { Label } from '@renderer/components/ui/label'
import {
  applicableEffort,
  effectiveChoice,
  ModelPicker,
  useModelCatalog,
  type ModelChoice
} from '@renderer/components/ModelPicker'
import { LatestAnswer } from '@renderer/lib/latest-answer'
import { ConversationMailboxRefresh } from '@renderer/lib/mailbox-refresh'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@renderer/components/ui/menu'
import { PermissionModePicker } from '@renderer/components/PermissionModePicker'
import {
  focusSkillSuggestion,
  focusTextareaAtEnd,
  SkillAwareTextarea,
  SkillSuggestions,
  skillInDraft,
  skillsMatching,
  useSkillCatalog
} from '@renderer/components/Skills'
import { completeSkillQuery } from '@shared/skill'
import { cn, moment } from '@renderer/lib/utils'

interface ComposerProps {
  /** Pre-selects a Project, as the button on a Project row does. */
  boundProjectRoot?: string
  onStarted: (started: StartedSessionResult) => void
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
  // The Checkout kind the person picked, per Project. Absent means the app's
  // own proposal still stands; present means it never will again, because a
  // default that moves under a choice already made is the failure this whole
  // rule is trying to avoid. Switching Projects keeps each one's choice.
  const [chosenKind, setChosenKind] = useState<Record<string, CheckoutRequest['kind']>>({})
  // The base branch the person named, per Project. It outranks anything the
  // picker goes on to observe: a base somebody chose is not a guess to revise.
  const [chosenBase, setChosenBase] = useState<Record<string, string>>({})
  // What the picker's last look at Git found to cut a worktree from — a
  // branch, or null for nothing to cut from. An observation and nothing more,
  // so a Project that had no branch when it was asked is not stuck with the
  // answer once it has one.
  const [observedBase, setObservedBase] = useState<Record<string, string | null>>({})
  // What each Project's most recent Session used — the standing fallback,
  // which is what the default was before it had anything else to go on.
  const [lastUsed, setLastUsed] = useState<Record<string, Checkout['kind']>>({})
  // The Projects a Run is working in the Local Checkout of right now, this
  // window's Sessions and everybody else's alike. Observed, never stored.
  const [localRunProjects, setLocalRunProjects] = useState<string[]>([])
  // One choice, not three: the model carries the Harness that reaches it.
  const { models, readiness } = useModelCatalog()
  const [chosen, setChosen] = useState<ModelChoice | null>(null)
  // Ask by default: the first Run edits the Project in place, and being asked
  // first is the posture somebody would choose if they were choosing.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingBootstrap, setPendingBootstrap] = useState<{
    token: string
    result: WorktreeBootstrapResult
  } | null>(null)
  const messageId = useId()
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const skillSuggestionsRef = useRef<HTMLUListElement>(null)
  // Guards the send itself rather than the rendered state, so two keystrokes
  // in one batch cannot both start a Session.
  const sendingRef = useRef(false)
  const disposedRef = useRef(false)
  // Orders the answers about what is running, so an older one arriving later
  // is dropped rather than believed.
  const [localRunAnswers] = useState(() => new LatestAnswer())

  useEffect(() => {
    disposedRef.current = false
    void Promise.all([window.shell.listProjects(), window.shell.listSessions()])
      .then(([listed, listedSessions]) => {
        if (disposedRef.current) return
        setProjects(listed)
        setSessions(listedSessions)
        // Sessions are newest first, so the first seen per Project is its
        // most recent — and what it used is that Project's fallback.
        const recent: Record<string, Checkout['kind']> = {}
        for (const session of listedSessions) recent[session.projectRoot] ??= session.checkout.kind
        setLastUsed(recent)
        setProjectRoot((current) => {
          if (current && listed.some((project) => project.root === current)) return current
          const available = (root: string | undefined): string | undefined =>
            listed.find((project) => project.root === root && project.available)?.root
          // Where the last Session went is where the next one probably goes.
          // Sessions are newest first, so the most recent one is the answer.
          const lastProject = listedSessions.map((session) => session.projectRoot).find(available)
          if (lastProject) return lastProject
          // A lone Project is not a guess. Beyond that, nothing here can say
          // which repository is about to be edited, so nothing is chosen: the
          // headline renders a required picker instead (mockup 1c).
          const usable = listed.filter((project) => project.available)
          return usable.length === 1 ? (usable[0]?.root ?? '') : ''
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

  // Two of these can be in flight at once — a Run boundary and a focus can
  // land together — and the one that answers last is not necessarily the one
  // asked last, so answers are ordered by when they were asked. An ask that
  // fails just never wins: the newest answer anybody got stays, rather than
  // being thrown away because a later question went unanswered.
  const observeLocalRuns = useCallback(() => {
    const ticket = localRunAnswers.ask()
    void window.shell.listProjectsWithActiveLocalRuns().then(
      (roots) => {
        if (!disposedRef.current && localRunAnswers.wins(ticket)) setLocalRunProjects(roots)
      },
      () => undefined
    )
  }, [localRunAnswers])

  // Asked once for what is already running, then again on every Run boundary
  // — the same lifecycle invalidation the inbox watches, which is what says a
  // Run started or ended no matter which Session it belongs to. A default
  // decided from state observed at this moment has to keep being observed, or
  // it is a default that outlives its reason.
  //
  // Coming back to the window asks again too, as the inbox does: a Run started
  // somewhere this window hears nothing from is still a Run in that Checkout.
  useEffect(() => {
    observeLocalRuns()
    const refresh = new ConversationMailboxRefresh(observeLocalRuns)
    const stop = window.shell.onConversationEvent((streamed) => {
      refresh.handle(streamed)
    })
    window.addEventListener('focus', observeLocalRuns)
    return () => {
      refresh.dispose()
      stop()
      window.removeEventListener('focus', observeLocalRuns)
    }
  }, [observeLocalRuns])

  // What this Project's Checkout would be if nobody said, and what it is once
  // the person's pick and the last look at Git are weighed against it.
  const { checkout, reason } = resolveCheckout({
    proposed: defaultCheckout({
      localRunActive: localRunProjects.includes(projectRoot),
      lastUsed: lastUsed[projectRoot] ?? null
    }),
    chosenKind: chosenKind[projectRoot],
    base: chosenBase[projectRoot] ?? observedBase[projectRoot]
  })

  // A Harness that stops being usable stops being offered, and the choice
  // falls back to one that can still answer a message.
  const choice = effectiveChoice(models, chosen)
  const [catalog] = useSkillCatalog({ projectRoot, harness: choice?.harness ?? null })
  const chosenSkill = skillInDraft(catalog, message)
  const matchingSkills = skillsMatching(catalog, message)

  const selected = projects.find((project) => project.root === projectRoot)
  const canSend =
    message.trim().length > 0 &&
    selected !== undefined &&
    !sending &&
    // An isolated ask needs its base settled before there is anything to cut.
    (checkout.kind !== 'isolated' || checkout.baseBranch !== '')

  /** The person's own pick for this Project, which outranks the proposal. */
  function chooseCheckout(next: CheckoutRequest): void {
    setChosenKind((current) => ({ ...current, [projectRoot]: next.kind }))
    // Only a base they actually named. Clicking Isolated before the branches
    // have loaded names none, and recording that would be recording nothing
    // over the observation that is about to arrive.
    if (next.kind === 'isolated' && next.baseBranch !== '') {
      setChosenBase((current) => ({ ...current, [projectRoot]: next.baseBranch }))
    }
  }

  /** What the picker saw when it last asked Git; never a decision. */
  const noteObservedBase = useCallback(
    (base: string | null) => {
      setObservedBase((current) =>
        current[projectRoot] === base ? current : { ...current, [projectRoot]: base }
      )
    },
    [projectRoot]
  )

  /** Completes the visible Skill token and leaves the prompt ready after it. */
  function chooseSkill(name: string): void {
    setMessage((current) => completeSkillQuery(current, name))
    focusTextareaAtEnd(messageRef)
  }

  // The most recent Sessions in the Project being sent to. Continuing one is
  // usually better than starting a second Session about the same work — and
  // they are the only suggestions offered, because they are the only ones the
  // app actually knows anything about (mockup 1c).
  const continuable = useMemo(
    () =>
      sessions
        .filter((session) => session.projectRoot === projectRoot && !session.archivedAt)
        .slice(0, RECENTS_OFFERED),
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
      const result = await window.shell.startSession({
        projectRoot,
        message: message.trim(),
        checkout,
        ...(run ? { run } : {})
      })
      if (result.status === 'blocked') {
        setError(`The isolated Checkout is blocked by Checkout State: ${result.state}.`)
        return
      }
      if (result.status === 'refused') {
        setError(
          result.reason === 'git-unavailable'
            ? 'Git is unavailable, so the isolated Checkout could not be created.'
            : 'That Project is no longer a Git repository.'
        )
        return
      }
      if (result.status === 'failed') {
        setError(result.message)
        return
      }
      if (result.status === 'bootstrap-incomplete') {
        setPendingBootstrap({ token: result.token, result: result.result })
        return
      }
      onStarted(result)
    } catch {
      if (!disposedRef.current) setError('That Session could not be started.')
    } finally {
      sendingRef.current = false
      // A successful send unmounts this surface; only a failure comes back.
      if (!disposedRef.current) setSending(false)
    }
  }

  async function resolveBootstrap(decision: 'retry' | 'continue'): Promise<void> {
    if (!pendingBootstrap || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setError(null)
    try {
      const result = await window.shell.resumeWorktreeBootstrap({
        token: pendingBootstrap.token,
        decision
      })
      if (result.status === 'bootstrap-incomplete') {
        setPendingBootstrap({ token: result.token, result: result.result })
        return
      }
      if (result.status === 'started') {
        setPendingBootstrap(null)
        onStarted(result)
        return
      }
      setError('That isolated Checkout could not be resumed.')
    } catch {
      if (!disposedRef.current) setError('That isolated Checkout could not be resumed.')
    } finally {
      sendingRef.current = false
      if (!disposedRef.current) setSending(false)
    }
  }

  return (
    <form
      aria-label="New chat"
      className="mx-auto flex w-full max-w-3xl flex-1 -translate-y-[4vh] flex-col justify-center gap-4 p-8"
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
          <SkillSuggestions
            matching={matchingSkills}
            onChoose={chooseSkill}
            listRef={skillSuggestionsRef}
          />
        )}
        <div className="rounded-xl border border-border bg-surface focus-within:ring-2 focus-within:ring-ring">
          <Label htmlFor={messageId} className="sr-only">
            Message
          </Label>
          <SkillAwareTextarea
            id={messageId}
            textareaRef={messageRef}
            rows={4}
            value={message}
            skill={chosenSkill}
            placeholder="Describe the work, or / for a Skill…"
            onChange={(event) => {
              setMessage(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (
                matchingSkills?.length &&
                (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
                !event.nativeEvent.isComposing &&
                !event.shiftKey &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey
              ) {
                event.preventDefault()
                focusSkillSuggestion(
                  skillSuggestionsRef,
                  event.key === 'ArrowDown' ? 'first' : 'last'
                )
                return
              }
              if (
                matchingSkills?.[0] &&
                (event.key === 'Enter' || event.key === 'Tab') &&
                !event.nativeEvent.isComposing &&
                !event.shiftKey &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey
              ) {
                event.preventDefault()
                chooseSkill(matchingSkills[0].name)
                return
              }
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
              reason={reason}
              onChange={chooseCheckout}
              onBaseObserved={noteObservedBase}
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
      </div>

      {/* Only the work already under way — no filler the app pretends to
          have thought of. Nothing to continue means no chips at all. */}
      {continuable.length > 0 && (
        <ul aria-label="Recent Sessions" className="mt-2 flex flex-wrap justify-center gap-2">
          {continuable.map((session) => (
            <li key={session.id}>
              <Starter onClick={() => onOpenSession(session)}>Continue “{session.title}”</Starter>
            </li>
          ))}
        </ul>
      )}

      {projects.length === 0 && (
        <p role="status" className="text-center text-xs text-muted-foreground">
          Add a Project first — a Session works inside one.
        </p>
      )}

      {pendingBootstrap && (
        <section
          aria-labelledby="worktree-bootstrap-heading"
          className="bg-card mx-auto w-full max-w-xl rounded-lg border border-border p-4 text-sm"
        >
          <h2 id="worktree-bootstrap-heading" className="font-medium">
            Some local files and directories could not be carried
          </h2>
          {/* Where the state came from, stated and left there. Whether it
              suits the branch this Checkout was cut from is a question about
              lockfiles, and nothing here has read one. */}
          <p className="mt-1 text-xs text-muted-foreground">
            {bootstrapOrigin(pendingBootstrap.result.provenance)}
          </p>
          {pendingBootstrap.result.copied.length > 0 && (
            <div className="mt-3">
              <h3 className="text-xs font-medium text-muted-foreground">Carried</h3>
              <ul className="mt-1 list-inside list-disc">
                {pendingBootstrap.result.copied.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-3">
            <h3 className="text-xs font-medium text-muted-foreground">Skipped</h3>
            <ul className="mt-1 list-inside list-disc">
              {pendingBootstrap.result.skipped.map((entry) => (
                <li key={`${entry.path}:${entry.reason}`}>
                  {entry.path} — {bootstrapReason(entry.reason)}
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={sending}
              onClick={() => void resolveBootstrap('continue')}
            >
              Continue without them
            </Button>
            <Button type="button" disabled={sending} onClick={() => void resolveBootstrap('retry')}>
              Retry copying
            </Button>
          </div>
        </section>
      )}

      {error && (
        <p role="alert" className="text-center text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}

function bootstrapReason(reason: WorktreeBootstrapResult['skipped'][number]['reason']): string {
  return reason.replaceAll('-', ' ')
}

/** The one sentence of fact: where this Checkout was bootstrapped from. */
function bootstrapOrigin(provenance: WorktreeBootstrapProvenance | null): string {
  if (provenance === null) return 'Where this was carried from was not recorded.'
  const from = provenance.branch ?? 'a detached HEAD'
  return `Carried from ${from} at ${shortCommit(provenance.commit)}, ${moment(provenance.at)}.`
}

/** How many recent Sessions are worth a chip before they are just a list. */
const RECENTS_OFFERED = 3

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
 *
 * When nothing could be inferred from context, the same control is a
 * required picker: the sentence asks for a choice rather than presuming one,
 * because presuming means real edits in a repository nobody named.
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
        title={selected?.root ?? (projects.length > 0 ? 'Choose a Project' : 'No Projects yet')}
        disabled={disabled || projects.length === 0}
        className={cn(
          'rounded-sm font-medium underline decoration-muted-foreground decoration-dashed underline-offset-[6px] hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          selected === undefined && 'text-muted-foreground'
        )}
      >
        {selected ? selected.name : projects.length > 0 ? 'one of your Projects' : 'no Project yet'}
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
