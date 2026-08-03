import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Bot,
  ChevronRight,
  FileDiff,
  Send,
  ShieldQuestion,
  Square,
  Terminal,
  User
} from 'lucide-react'
import {
  countDiffLines,
  HARNESS_DEFAULT_MODEL,
  SKILL_ATTRIBUTION,
  ruleText,
  type ApprovalDecision,
  type ConversationEntry,
  type ConversationRecovery,
  type DiffHunk,
  type ConversationSnapshot,
  type ModelCatalog,
  type HarnessUsage,
  type PermissionMode,
  type ReadinessSnapshot,
  type RunSnapshot,
  type SessionSummary,
  type SkillCatalog,
  type StandingApprovalKind,
  type SuggestedResponse
} from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import {
  applicableEffort,
  effectiveChoice,
  ModelPicker,
  type ModelChoice
} from '@renderer/components/ModelPicker'
import { ChangedFiles } from '@renderer/components/ChangedFiles'
import { DiffView } from '@renderer/components/Diff'
import { cn } from '@renderer/lib/utils'

/**
 * The Session's permanent Conversation: the primary surface for developing it.
 * Streamed assistant text arrives on the push channel and is reconciled
 * against the durable snapshot, so what is on screen never outlives what was
 * saved. Suggested Responses submit directly; typed answers wait for Send.
 */

type Phase =
  { state: 'loading' } | { state: 'failed' } | { state: 'ready'; snapshot: ConversationSnapshot }

/** Assistant text for the Run in flight, ahead of the durable projection. */
interface LiveRun {
  runId: string
  /** One entry per Harness message, in the order the Harness opened them. */
  messages: { id: string; text: string }[]
  /** Files changed so far in this Run, shown while it is still working. */
  changes: { id: string; path: string; hunks: DiffHunk[] }[]
  /** Commands, by the Harness's id, so a running one becomes a finished one. */
  commands: { id: string; command: string; output: string; failed: boolean; running: boolean }[]
  suggestedResponses: SuggestedResponse[]
}

const RECOVERY_GUIDANCE: Record<ConversationRecovery['category'], string> = {
  authentication:
    'The Harness is no longer signed in. Sign in with its own CLI, then send your message again.',
  'rate-limit':
    'The Harness is rate limiting this account. Nothing was lost — send your message again in a moment.',
  'context-exhausted':
    'The Run ran out of Harness context. Start a shorter message rather than resending this one.',
  'process-crash': 'The Harness process ended unexpectedly. Your message is safe to send again.',
  stopped: 'You stopped this Run. Everything up to that point is kept.',
  'uncertain-submission':
    'The Run ended before the Harness answered, so its outcome is unknown. Your message is kept and safe to send again.',
  'protocol-unsupported':
    'The Harness reported its work in a format this app does not understand, so nothing usable came back. Updating the Harness — or this app — is what fixes it.',
  'policy-violation':
    'The Run was stopped because it exceeded a Run limit. Review the activity below.',
  'supervision-failed':
    'Harness cleanup could not be verified. Quit the app and check Activity Monitor before starting another Run.'
}

export function Conversation({ session }: { session: SessionSummary }): React.JSX.Element {
  const sessionId = session.id
  const [phase, setPhase] = useState<Phase>({ state: 'loading' })
  const [runs, setRuns] = useState<RunSnapshot[]>([])
  const [readiness, setReadiness] = useState<ReadinessSnapshot | null>(null)
  const [live, setLive] = useState<LiveRun | null>(null)
  const [draft, setDraft] = useState('')
  // No Skill by default. Most messages are not asking for a methodology, and
  // one applied because it happened to be selected is one nobody chose.
  const [skill, setSkill] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null)
  // One choice, not three: the model carries the Harness that reaches it.
  const [models, setModels] = useState<ModelCatalog | null>(null)
  const [chosen, setChosen] = useState<ModelChoice | null>(null)
  // Ask by default: a Run edits the Project in place, and being asked first is
  // the posture somebody would choose if they were choosing deliberately.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask')
  const [denyMessage, setDenyMessage] = useState('')
  const [deciding, setDeciding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const snapshot = phase.state === 'ready' ? phase.snapshot : null
  const activeRunId = snapshot?.activeRunId ?? null

  // The Harness comes from the model, and the first group is one that can
  // actually run a Session: offering one the app has just said it cannot use
  // is how a person ends up watching nothing happen.
  // A Harness that stops being usable stops being a group, and the choice
  // falls back to one that can still run a message. A Run already sent keeps
  // what it recorded.
  const choice = effectiveChoice(models, chosen)
  const chosenHarness = choice?.harness ?? null

  const refresh = useCallback(async () => {
    try {
      const next = await window.shell.getConversation(sessionId)
      setPhase({ state: 'ready', snapshot: next })
      if (next.activeRunId === null) setLive(null)
    } catch {
      setPhase((current) => (current.state === 'ready' ? current : { state: 'failed' }))
    }
    await window.shell.listRuns(sessionId).then(setRuns, () => undefined)
  }, [sessionId])

  const readHarnesses = useCallback(() => {
    void window.shell.getReadiness().then(setReadiness, () => undefined)
    void window.shell.listModels().then(setModels, () => undefined)
  }, [])

  useEffect(() => {
    void refresh()
    readHarnesses()
  }, [refresh, readHarnesses])

  // A Harness is repaired, or installed, or removed somewhere else entirely —
  // in its own dialog, or in a terminal. Coming back to this window is when
  // that becomes worth knowing, so the groups are read again then rather than
  // staying as they were when the Session was opened.
  useEffect(() => {
    window.addEventListener('focus', readHarnesses)
    return () => window.removeEventListener('focus', readHarnesses)
  }, [readHarnesses])

  // Skills are installed and removed by the person, in their own directories,
  // so what is available is read rather than remembered.
  useEffect(() => {
    if (!chosenHarness) return
    void window.shell
      .listSkills({ projectRoot: session.projectRoot, harness: chosenHarness })
      .then(setCatalog, () => undefined)
  }, [chosenHarness, session.projectRoot])

  // While a Run is in flight the durable snapshot is what settles partial
  // messages, so it is re-read until the Run reaches a boundary.
  useEffect(() => {
    if (!activeRunId) return
    const timer = window.setInterval(() => void refresh(), 750)
    return () => window.clearInterval(timer)
  }, [activeRunId, refresh])

  useEffect(
    () =>
      window.shell.onConversationEvent((streamed) => {
        if (streamed.sessionId !== sessionId) return
        const event = streamed.event
        if (event.type === 'failed') {
          setError(event.summary)
          return
        }
        // An approval is durable the moment it is asked for, and the Run is
        // blocked until it is answered — so it is read back rather than kept
        // as a second copy of the same fact on this side.
        if (event.type === 'approval-request' || event.type === 'approval-resolved') {
          void refresh()
          return
        }
        setLive((current) => {
          const base: LiveRun =
            current?.runId === streamed.runId
              ? current
              : {
                  runId: streamed.runId,
                  messages: [],
                  changes: [],
                  commands: [],
                  suggestedResponses: []
                }
          if (event.type === 'choices') return { ...base, suggestedResponses: event.options }
          // A change is already on disk when it arrives, so it is shown as it
          // happens rather than waiting for the Run to finish.
          if (event.type === 'file-change') {
            return {
              ...base,
              changes: [
                ...base.changes,
                {
                  id: `${streamed.runId}:${base.changes.length + 1}`,
                  path: event.path,
                  hunks: event.hunks
                }
              ]
            }
          }
          // A command appears the moment it starts and is replaced in place
          // when it finishes: the Harness sends no partial output, so this is
          // as live as it gets.
          if (event.type === 'command') {
            const known = base.commands.some((entry) => entry.id === event.id)
            return {
              ...base,
              commands: known
                ? base.commands.map((entry) => (entry.id === event.id ? { ...event } : entry))
                : [...base.commands, { ...event }]
            }
          }
          if (event.type !== 'assistant-message') return base
          // Each event carries the whole message so far, so a later one for
          // the same Harness item replaces the earlier one.
          const known = base.messages.some((message) => message.id === event.id)
          return {
            ...base,
            messages: known
              ? base.messages.map((message) =>
                  message.id === event.id ? { ...message, text: event.text } : message
                )
              : [...base.messages, { id: event.id, text: event.text }]
          }
        })
      }),
    [sessionId, refresh]
  )

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [snapshot?.entries.length, live?.messages, live?.changes, live?.commands])

  // Derived rather than corrected: a Skill the catalog stops offering — the
  // Project's trust withdrawn, the directory deleted — is one this message no
  // longer asks for, without a round of state chasing the catalog.
  const chosenSkill =
    skill && catalog?.available.some((entry) => entry.name === skill) ? skill : null

  // `/` at the start of an empty message asks what methodologies there are.
  // Anywhere else it is just a slash, because most messages contain paths.
  const slashQuery = /^\/(\S*)$/.exec(draft)?.[1] ?? null
  const matchingSkills = (catalog?.available ?? []).filter((entry) =>
    entry.name.includes(slashQuery ?? '')
  )

  /** Takes the Skill for this message, and the `/` back out of the message. */
  const chooseSkill = useCallback((name: string) => {
    setSkill(name)
    setDraft('')
  }, [])

  const send = useCallback(
    async (text: string, source: 'composer' | 'suggested-response', submissionId?: string) => {
      if (!chosenHarness) return
      setBusy(true)
      setError(null)
      try {
        const next = await window.shell.developSession({
          sessionId,
          submissionId: submissionId ?? crypto.randomUUID(),
          text,
          source,
          ...(chosenSkill ? { skill: chosenSkill } : {}),
          harness: chosenHarness,
          model: choice?.model ?? HARNESS_DEFAULT_MODEL,
          // Only what the chosen model can be asked for.
          effort: applicableEffort(models, choice),
          permissionMode: permissionMode
        })
        setPhase({ state: 'ready', snapshot: next })
        // Per message, not per Session: real work switches methodology inside
        // one thread of context, and a Skill that outlives the message it was
        // chosen for is one nobody chose for the next one.
        if (source === 'composer' && !submissionId) {
          setDraft('')
          setSkill(null)
        }
        await window.shell.listRuns(sessionId).then(setRuns, () => undefined)
      } catch {
        setError(
          'The Run could not start. Check that the Harness is ready and that supervision has recovered.'
        )
        // The message was accepted durably before the Run was attempted, so
        // re-read the Conversation rather than leaving it looking lost.
        await refresh()
      } finally {
        setBusy(false)
      }
    },
    [sessionId, chosenHarness, chosenSkill, choice, models, permissionMode, refresh]
  )

  /**
   * The person's answer to what the agent asked for. The Run is blocked until
   * this lands, so the snapshot it returns is what unblocks the surface.
   */
  const decide = useCallback(
    async (
      approval: Extract<ConversationEntry, { kind: 'approval' }>,
      decision: 'allow' | 'deny',
      remember = false
    ) => {
      setDeciding(true)
      setError(null)
      try {
        const next = await window.shell.resolveApproval({
          sessionId,
          runId: approval.runId,
          approvalId: approval.requestId,
          decision,
          message: denyMessage.trim(),
          remember
        })
        setPhase({ state: 'ready', snapshot: next })
        setDenyMessage('')
      } catch {
        setError('That request could not be answered. The Run may have already ended.')
        await refresh()
      } finally {
        setDeciding(false)
      }
    },
    [sessionId, denyMessage, refresh]
  )

  if (phase.state === 'loading') {
    return (
      <section className="mt-4 rounded-md border border-border bg-surface p-3" aria-busy="true">
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          Reading this Session’s Conversation…
        </p>
      </section>
    )
  }

  if (phase.state === 'failed') {
    return (
      <section className="mt-4 rounded-md border border-border bg-surface p-3">
        <p role="alert" className="text-xs text-destructive">
          This Session’s Conversation could not be read. Nothing in your Project was changed.
        </p>
        <Button className="mt-2" size="sm" variant="secondary" onClick={() => void refresh()}>
          Try again
        </Button>
      </section>
    )
  }

  const entries = phase.snapshot.entries
  const started = entries.length > 0
  const liveForActiveRun = live?.runId === activeRunId ? live : null
  const latestAssistant = [...entries]
    .reverse()
    .find((entry) => entry.kind === 'message' && entry.role === 'assistant')
  const suggested = liveForActiveRun?.suggestedResponses.length
    ? liveForActiveRun.suggestedResponses
    : activeRunId === null && latestAssistant?.kind === 'message'
      ? latestAssistant.suggestedResponses
      : []
  const plainOptions =
    activeRunId === null && latestAssistant?.kind === 'message' && latestAssistant.plainOptions
  const pendingApproval = entries.find(
    (entry): entry is Extract<ConversationEntry, { kind: 'approval' }> =>
      entry.kind === 'approval' && entry.id === phase.snapshot.pendingApprovalId
  )
  const activeRun = runs.find((run) => run.id === activeRunId) ?? runs[0]
  // Whether the Harness behind the chosen model can run a Session at all.
  const canDevelop = readiness?.harnesses.find((entry) => entry.harness === chosenHarness)
    ?.capabilities.developSession
  const blocked = readiness !== null && canDevelop?.available !== true
  const resumable = phase.snapshot.recovery?.resumableSubmissionId ?? null
  const resumableText = entries.find(
    (entry) => entry.kind === 'message' && entry.submissionId === resumable
  )

  return (
    <>
      {/* Above the log on purpose: the state of the work is what a person
          coming back to this Session is looking for. */}
      <ChangedFiles
        files={phase.snapshot.changedFiles}
        entries={entries.filter((entry) => entry.kind === 'file-change')}
      />
      <section
        className="mt-4 flex flex-col rounded-md border border-border bg-surface"
        aria-labelledby="conversation-heading"
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <div>
            <h3 id="conversation-heading" className="text-sm font-medium">
              Conversation
            </h3>
            <p className="text-xs text-muted-foreground">
              One permanent history for this Session. The work itself lives in your Project, under
              git.
            </p>
          </div>
          {activeRunId && (
            <Button
              className="ml-auto"
              size="sm"
              variant="secondary"
              onClick={() =>
                void window.shell.stopRun({ runId: activeRunId, sessionId }).then(
                  () => refresh(),
                  () => setError('The Run could not be stopped.')
                )
              }
            >
              <Square aria-hidden="true" className="size-3" /> Stop
            </Button>
          )}
        </header>

        <ol
          className="flex max-h-96 flex-col gap-3 overflow-y-auto p-3"
          aria-label="Conversation history"
          aria-live="polite"
          aria-busy={activeRunId !== null}
        >
          {!started && (
            <li className="text-xs text-muted-foreground">
              Nothing has been developed yet. Send your first message — and if you have Skills
              installed, type / to work to one.
            </li>
          )}
          {entries.map((entry) => (
            <EntryRow key={entry.id} entry={entry} />
          ))}
          {liveForActiveRun?.messages
            .filter((message) => message.text)
            .map((message) => (
              <li key={message.id} className="flex gap-2">
                <Bot
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-muted-foreground">Assistant</p>
                  <p className="text-sm whitespace-pre-wrap select-text">{message.text}</p>
                </div>
              </li>
            ))}
          {liveForActiveRun?.commands
            .filter(
              (entry) =>
                !entries.some(
                  (durable) =>
                    durable.kind === 'command' &&
                    durable.id === `command:${liveForActiveRun.runId}:${entry.id}`
                )
            )
            .map((entry) => (
              <CommandRow
                key={entry.id}
                command={entry.command}
                output={entry.output}
                failed={entry.failed}
                running={entry.running}
              />
            ))}
          {liveForActiveRun?.changes
            .slice(
              entries.filter(
                (entry) => entry.kind === 'file-change' && entry.runId === liveForActiveRun.runId
              ).length
            )
            .map((change) => (
              <FileChangeRow key={change.id} path={change.path} hunks={change.hunks} />
            ))}
          {activeRunId &&
            !pendingApproval &&
            !liveForActiveRun?.messages.some((message) => message.text) && (
              <li className="text-xs text-muted-foreground">Waiting for the Harness to answer…</li>
            )}
          <div ref={endRef} />
        </ol>

        {catalog?.projectTrusted &&
          catalog.available.some((entry) => entry.source === 'project') && (
            <p className="mx-3 mb-3 text-[11px] text-muted-foreground">
              This Project’s own Skills are offered because you trusted them.{' '}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() =>
                  void window.shell
                    .trustProjectSkills({
                      root: session.projectRoot,
                      harness: chosenHarness ?? 'claude',
                      trusted: false
                    })
                    .then(setCatalog, () => setError('That could not be withdrawn.'))
                }
              >
                Stop trusting them
              </button>
            </p>
          )}

        {catalog && catalog.untrusted.length > 0 && (
          <div
            role="alert"
            aria-label="Project Skills"
            className="mx-3 mb-3 rounded-md border border-border bg-muted/50 p-3"
          >
            <p className="text-xs">
              This Project brings {catalog.untrusted.length === 1 ? 'a Skill' : 'Skills'} of its
              own. A Skill is instructions for an agent that can edit files and run commands, and
              these arrived with the repository — so they are not offered until you say so.
            </p>
            <ul className="mt-2 flex flex-col gap-1">
              {catalog.untrusted.map((entry) => (
                <li key={entry.name} className="text-xs">
                  <span className="font-medium">{entry.name}</span>
                  {entry.description && (
                    <span className="text-muted-foreground"> — {entry.description}</span>
                  )}
                  <span className="block font-mono text-[10px] break-all text-muted-foreground select-text">
                    {entry.path}
                  </span>
                </li>
              ))}
            </ul>
            <Button
              className="mt-2"
              size="sm"
              variant="secondary"
              onClick={() =>
                void window.shell
                  .trustProjectSkills({
                    root: session.projectRoot,
                    harness: chosenHarness ?? 'claude',
                    trusted: true
                  })
                  .then(setCatalog, () => setError('Those Skills could not be trusted.'))
              }
            >
              Trust this Project’s Skills
            </Button>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Read them first — they are files in the repository. You can withdraw this at any time.
            </p>
          </div>
        )}

        {pendingApproval && (
          <div
            role="alert"
            aria-label="Approval request"
            className="mx-3 mb-3 rounded-md border border-border bg-muted/50 p-3"
          >
            <p className="flex items-center gap-2 text-xs font-medium">
              <ShieldQuestion aria-hidden="true" className="size-3.5 shrink-0" />
              The agent is asking before it uses {pendingApproval.tool}. This Run is blocked until
              you answer.
            </p>
            <p className="mt-2 font-mono text-xs break-all select-text">
              {pendingApproval.summary}
            </p>
            {pendingApproval.detail && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[11px] text-muted-foreground">
                  What it sent
                </summary>
                <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-border bg-surface p-2 font-mono text-[11px] whitespace-pre-wrap select-text">
                  {pendingApproval.detail}
                </pre>
              </details>
            )}
            <label className="sr-only" htmlFor="approval-message">
              What to tell the agent if you decline
            </label>
            <input
              id="approval-message"
              value={denyMessage}
              disabled={deciding}
              onChange={(event) => setDenyMessage(event.target.value)}
              placeholder="If you decline, what should it do instead? (optional)"
              className="mt-2 h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={deciding}
                onClick={() => void decide(pendingApproval, 'allow')}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={deciding}
                onClick={() => void decide(pendingApproval, 'deny')}
              >
                Decline
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Declining is not a stop: the agent is told why and carries on without it.
            </p>
            {pendingApproval.proposedRule && (
              <div className="mt-2 border-t border-border pt-2">
                <p className="text-[11px] text-muted-foreground">
                  {STANDING_EXPLANATION[pendingApproval.proposedRule.kind]}. The agent stops asking,
                  so this is the exact rule that gets stored:
                </p>
                {/* Shown before it is accepted, and never paraphrased. Once a rule
                  is stored the Harness answers with it before this app is asked
                  anything, so this line is the last chance to read it. */}
                <p className="mt-1 font-mono text-[11px] break-all select-text">
                  {ruleText(pendingApproval.proposedRule)}
                </p>
                <Button
                  className="mt-2"
                  size="sm"
                  variant="secondary"
                  disabled={deciding}
                  onClick={() => void decide(pendingApproval, 'allow', true)}
                >
                  Always allow this
                </Button>
                <p className="mt-1 text-[11px] break-all text-muted-foreground">
                  {/* Named in full, because which Project this applies to is the
                    whole scope of what is being granted. */}
                  Only in {session.projectRoot}, and you can take it back at any time.
                </p>
              </div>
            )}
          </div>
        )}

        {phase.snapshot.recovery && (
          <div role="alert" className="mx-3 mb-3 rounded-md border border-border bg-muted/50 p-3">
            <p className="text-xs text-foreground">
              {RECOVERY_GUIDANCE[phase.snapshot.recovery.category]}
            </p>
            <p className="mt-1 text-xs break-words text-muted-foreground">
              What happened: {phase.snapshot.recovery.summary}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              The full sanitized activity for this Run is below.
            </p>
            {resumable && resumableText?.kind === 'message' && (
              <Button
                className="mt-2"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void send(
                    resumableText.text,
                    resumableText.source === 'suggested-response'
                      ? 'suggested-response'
                      : 'composer',
                    resumable
                  )
                }
              >
                Send that message again
              </Button>
            )}
          </div>
        )}

        {suggested.length > 0 && (
          <div className="border-t border-border p-3">
            <p className="text-xs text-muted-foreground">
              Suggested Responses send straight away. You can always write your own instead.
            </p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {suggested.map((option) => (
                <li key={option.id}>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy || blocked || activeRunId !== null}
                    onClick={() => void send(option.value, 'suggested-response')}
                  >
                    {option.label}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {plainOptions && suggested.length === 0 && (
          <p className="border-t border-border px-3 pt-3 text-xs text-muted-foreground">
            The assistant listed options in prose rather than as structured choices, so write your
            answer below.
          </p>
        )}

        <form
          className="flex flex-col gap-2 border-t border-border p-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (draft.trim()) void send(draft.trim(), 'composer')
          }}
        >
          <label className="sr-only" htmlFor="conversation-composer">
            Your message
          </label>
          {slashQuery !== null && (
            <ul
              aria-label="Skills"
              className="max-h-40 overflow-y-auto rounded-md border border-border bg-surface"
            >
              {matchingSkills.length === 0 && (
                <li className="px-2 py-1.5 text-xs text-muted-foreground">
                  No installed Skill matches. Keep typing your message — a Skill is optional.
                </li>
              )}
              {matchingSkills.map((entry) => (
                <li key={`${entry.source}:${entry.name}`}>
                  <button
                    type="button"
                    className="flex w-full flex-col items-start px-2 py-1.5 text-left hover:bg-muted/60"
                    onClick={() => chooseSkill(entry.name)}
                  >
                    <span className="text-xs font-medium">
                      {entry.name}
                      {entry.source === 'project' && (
                        <span className="ml-1 font-normal text-muted-foreground">this Project</span>
                      )}
                    </span>
                    {entry.description && (
                      <span className="text-[11px] text-muted-foreground">{entry.description}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea
            id="conversation-composer"
            value={draft}
            disabled={activeRunId !== null}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={started ? 'Write your answer…' : 'What should we develop or decide?'}
            className="min-h-20 rounded-md border border-border bg-background p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
          {chosenSkill && (
            <p className="text-[11px] text-muted-foreground">
              This message asks for the{' '}
              <span className="font-medium text-foreground">{chosenSkill}</span> Skill.{' '}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => setSkill(null)}
              >
                Send without it
              </button>
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Field label="Skill">
              <select
                aria-label="Skill"
                value={chosenSkill ?? ''}
                disabled={(catalog?.available.length ?? 0) === 0}
                onChange={(event) => setSkill(event.target.value || null)}
                className="h-8 max-w-44 rounded-md border border-border bg-background px-2 text-xs"
              >
                <option value="">{catalog?.available.length ? 'None' : 'None installed'}</option>
                {catalog?.available.map((entry) => (
                  <option key={`${entry.source}:${entry.name}`} value={entry.name}>
                    {entry.name}
                    {entry.source === 'project' ? ' (this Project)' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Model">
              <ModelPicker
                catalog={models}
                choice={choice}
                onChange={setChosen}
                disabled={activeRunId !== null}
              />
            </Field>
            <Field label="Permission">
              <select
                aria-label="Permission Mode"
                value={permissionMode}
                onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
              >
                <option value="ask">Ask</option>
                <option value="auto">Full access</option>
              </select>
            </Field>
            <Button
              className="ml-auto"
              size="sm"
              type="submit"
              disabled={busy || blocked || activeRunId !== null || !draft.trim()}
            >
              <Send aria-hidden="true" className="size-3.5" />
              {busy ? 'Sending…' : started ? 'Send' : 'Start developing'}
            </Button>
          </div>
          {blocked && canDevelop && (
            <div role="status" className="rounded-md border border-border bg-muted/50 p-2">
              <p className="text-xs text-foreground">{canDevelop.summary}</p>
              {canDevelop.command && (
                <code className="mt-1 block font-mono text-[11px] break-all select-text">
                  {canDevelop.command}
                </code>
              )}
              <p className="mt-1 text-[11px] text-muted-foreground">
                This app never installs or updates a Harness for you.
              </p>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            {permissionMode === 'ask'
              ? 'In Ask, the agent stops for your approval before it edits or runs anything.'
              : 'In Full access, the agent edits and runs without asking. The Harness applies its own permissions for this Run.'}
          </p>
          {/* The mapping onto each Harness is lossy, and ADR 0003 says the
            differences are stated rather than discovered. */}
          {chosenHarness === 'codex' && (
            <p className="text-[11px] text-muted-foreground">
              Codex differs from Claude Code here: in Ask it edits inside this Project without
              asking and stops for commands, it proposes its own “always allow” rule rather than
              being given one, and a Skill reaches it as instructions for the Run rather than
              natively.
            </p>
          )}
        </form>

        {error && (
          <p role="alert" className="px-3 pb-3 text-xs text-destructive">
            {error}
          </p>
        )}

        <UsagePanel usage={phase.snapshot.usage} />

        {activeRun && (
          <ActivityPanel
            run={activeRun}
            // A Run that ended badly is exactly when the detail matters, so it
            // does not stay hidden behind a disclosure.
            defaultOpen={FAILED_STATUSES.has(activeRun.status)}
          />
        )}

        <Attribution />
      </section>
    </>
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
      {label}
      {children}
    </span>
  )
}

/** How many lines of output are shown before it is worth collapsing. */
const OUTPUT_PREVIEW_LINES = 12

/**
 * A command the Run ran, and what it printed. A compact terminal block: the
 * output is usually the answer the person was waiting for, so it sits inline
 * rather than behind a disclosure — until it is long enough that leaving it
 * open would bury the Conversation around it.
 */
function CommandRow({
  command,
  output,
  failed,
  running
}: {
  command: string
  output: string
  failed: boolean
  running: boolean
}): React.JSX.Element {
  const lines = output ? output.split('\n') : []
  const long = lines.length > OUTPUT_PREVIEW_LINES
  const [expanded, setExpanded] = useState(false)
  const shown = expanded || !long ? lines : lines.slice(-OUTPUT_PREVIEW_LINES)

  return (
    <li className="flex gap-2">
      <Terminal aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 font-mono text-xs">
          <span className="text-muted-foreground">$</span>
          <span className="break-all select-text">{command}</span>
          {running && <span className="text-[11px] text-muted-foreground">running…</span>}
          {failed && <span className="text-[11px] text-destructive">failed</span>}
        </p>
        {lines.length === 0 ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {running ? 'Waiting for it to finish.' : 'No output.'}
          </p>
        ) : (
          <>
            {long && (
              <button
                type="button"
                aria-expanded={expanded}
                className="mt-1 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => setExpanded((current) => !current)}
              >
                {expanded ? 'Show less' : `Show all ${String(lines.length)} lines`}
              </button>
            )}
            <pre className="mt-1 max-h-96 overflow-auto rounded-md border border-border bg-surface p-2 font-mono text-[11px] whitespace-pre-wrap select-text">
              {shown.join('\n')}
            </pre>
          </>
        )}
      </div>
    </li>
  )
}

/**
 * A file the Run changed, shown as it happened. The change is already on disk
 * — edits land in the Checkout in place (ADR 0004) — so this is a record, not
 * an offer: there is nothing here to accept or reject, and git is the undo.
 */
function FileChangeRow({
  path,
  hunks,
  counted
}: {
  path: string
  hunks: DiffHunk[]
  /**
   * What the whole change did, when it is known. A stored diff is shortened,
   * so counting the lines on screen would report less than happened; a change
   * still streaming has every line it has produced so far.
   */
  counted?: { added: number; removed: number }
}): React.JSX.Element {
  const { added, removed } = counted ?? countDiffLines(hunks)
  return (
    <li className="flex gap-2">
      <FileDiff aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="font-mono break-all select-text">{path}</span>
          <span className="text-[11px] text-muted-foreground">
            <span className="text-positive">+{added}</span>{' '}
            <span className="text-destructive">−{removed}</span>
          </span>
        </p>
        <DiffView hunks={hunks} />
      </div>
    </li>
  )
}

/** What granting the offered rule would actually mean, in plain words. */
const STANDING_EXPLANATION: Record<StandingApprovalKind, string> = {
  command: 'You can always allow commands like this one',
  edit: 'You can always allow file changes anywhere in this Project'
}

/** What the agent asked for, and what the person decided about it. */
const APPROVAL_OUTCOME: Record<ApprovalDecision, string> = {
  allowed: 'You approved this',
  denied: 'You declined this',
  abandoned: 'Unanswered — the Run ended first'
}

function ApprovalRow({
  entry
}: {
  entry: Extract<ConversationEntry, { kind: 'approval' }>
}): React.JSX.Element {
  return (
    <li className="flex gap-2">
      <ShieldQuestion
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs">
          <span className="text-muted-foreground">{entry.tool}</span>{' '}
          <span className="font-mono break-all select-text">{entry.summary}</span>
        </p>
        <p className="text-[11px] text-muted-foreground">
          {entry.decision === null ? 'Waiting for your answer' : APPROVAL_OUTCOME[entry.decision]}
          {entry.decision === 'denied' && entry.message ? ` — “${entry.message}”` : ''}
          {entry.remembered && entry.proposedRule
            ? ` — and always allow ${ruleText(entry.proposedRule)}`
            : ''}
        </p>
      </div>
    </li>
  )
}

function EntryRow({ entry }: { entry: ConversationEntry }): React.JSX.Element | null {
  if (entry.kind === 'usage' || entry.kind === 'thread') return null
  if (entry.kind === 'command')
    return (
      <CommandRow
        command={entry.command}
        output={entry.output}
        failed={entry.failed}
        running={entry.running}
      />
    )
  if (entry.kind === 'file-change')
    return (
      <FileChangeRow
        path={entry.path}
        hunks={entry.hunks}
        counted={{ added: entry.added, removed: entry.removed }}
      />
    )
  if (entry.kind === 'approval') return <ApprovalRow entry={entry} />
  if (entry.kind === 'boundary') {
    return (
      <li className="text-[11px] text-muted-foreground">
        <span className="rounded border border-border px-1.5 py-0.5">{entry.summary}</span>
      </li>
    )
  }
  const Icon = entry.role === 'user' ? User : Bot
  return (
    <li className="flex gap-2">
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">
          {entry.role === 'user' ? 'You' : 'Assistant'}
          {entry.completeness === 'partial' && (
            <span className="ml-1 font-normal">
              · partial, the Run ended before this message finished
            </span>
          )}
        </p>
        <p className="text-sm whitespace-pre-wrap select-text">{entry.text}</p>
      </div>
    </li>
  )
}

function UsagePanel({
  usage
}: {
  usage: { run: HarnessUsage | null; session: HarnessUsage }
}): React.JSX.Element | null {
  if (usage.session.totalTokens === 0) return null
  const contextWindow = usage.run?.contextWindow ?? usage.session.contextWindow
  const used = usage.run?.contextUsed ?? null
  return (
    <section className="border-t border-border px-3 py-2" aria-label="Harness-reported usage">
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex gap-1">
          <dt>This Run</dt>
          <dd className="text-foreground">
            {(usage.run?.totalTokens ?? 0).toLocaleString()} tokens
          </dd>
        </span>
        <span className="flex gap-1">
          <dt>This Session</dt>
          <dd className="text-foreground">{usage.session.totalTokens.toLocaleString()} tokens</dd>
        </span>
        {contextWindow !== null && used !== null && (
          <span className="flex gap-1">
            <dt>Context</dt>
            <dd className="text-foreground">
              {used.toLocaleString()} of {contextWindow.toLocaleString()}
            </dd>
          </span>
        )}
      </dl>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Reported by the Harness and informational only. It is not a quota, allowance, or cost.
      </p>
    </section>
  )
}

const FAILED_STATUSES = new Set<RunSnapshot['status']>([
  'failed',
  'policy-violation',
  'supervision-failed'
])

function ActivityPanel({
  run,
  defaultOpen
}: {
  run: RunSnapshot
  defaultOpen: boolean
}): React.JSX.Element {
  return (
    <details open={defaultOpen} className="group border-t border-border px-3 py-2">
      <summary className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
        <ChevronRight
          aria-hidden="true"
          className="size-3 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        Activity — {run.status.replace('-', ' ')}
      </summary>
      {/* What this Run was actually asked for, pinned when it was accepted.
          A Run keeps what it was given, whatever is chosen after it. */}
      <p className="mt-2 text-[11px] text-muted-foreground">
        {run.configuration.harness === 'claude' ? 'Claude Code' : 'Codex'} ·{' '}
        <span className="font-mono">{run.configuration.model}</span>
        {run.configuration.effort !== null && ` · thinking ${run.configuration.effort}`}
        {run.configuration.skill && ` · ${run.configuration.skill.name} Skill`}
      </p>
      <ol className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto text-[11px]">
        {run.activity.slice(-40).map((activity) => (
          <li
            key={activity.id}
            className={cn(
              'flex gap-2',
              activity.kind === 'blocked' || activity.kind === 'error'
                ? 'text-destructive'
                : 'text-muted-foreground'
            )}
          >
            <span className="w-16 shrink-0 capitalize">{activity.kind}</span>
            <span className="min-w-0 break-words">{activity.summary}</span>
          </li>
        ))}
      </ol>
    </details>
  )
}

function Attribution(): React.JSX.Element {
  const open = (url: string): void => {
    void window.shell.openExternalLink(url).catch(() => undefined)
  }
  return (
    <footer className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
      {SKILL_ATTRIBUTION.notice}{' '}
      <Button
        size="sm"
        variant="ghost"
        className="h-auto px-1 text-[11px] underline"
        onClick={() => open(SKILL_ATTRIBUTION.website)}
      >
        {SKILL_ATTRIBUTION.author}’s website
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-auto px-1 text-[11px] underline"
        onClick={() => open(SKILL_ATTRIBUTION.repository)}
      >
        skills repository ({SKILL_ATTRIBUTION.licence})
      </Button>
    </footer>
  )
}
