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
  HARNESS_DEFAULT_MODEL,
  SKILL_ATTRIBUTION,
  ruleText,
  type ApprovalDecision,
  type ConversationEntry,
  type ConversationRecovery,
  type DiffHunk,
  type ConversationSnapshot,
  type HarnessId,
  type HarnessUsage,
  type PermissionMode,
  type ReadinessSnapshot,
  type RunSnapshot,
  type SessionSummary,
  type StandingApprovalKind,
  type SuggestedResponse
} from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
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

const EFFORT_OPTIONS = ['low', 'medium', 'high']

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
  const [harness, setHarness] = useState<HarnessId | null>(null)
  const [skill, setSkill] = useState('grilling')
  const [model, setModel] = useState(HARNESS_DEFAULT_MODEL)
  const [effort, setEffort] = useState('medium')
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

  const harnesses = readiness?.harnesses ?? []
  // Defaults to a Harness that can actually run a Session rather than to a
  // fixed name: offering one the app has just said it cannot use is how a
  // person ends up watching nothing happen.
  const selected =
    harnesses.find((entry) => entry.harness === harness) ??
    harnesses.find((entry) => entry.capabilities.developSession.available) ??
    harnesses[0]
  const chosenHarness = selected?.harness ?? null
  // Ask is served natively per Harness. Codex's transport can carry it — the
  // app-server protocol has a full approval round-trip — but nothing answers
  // it here yet, so offering it would start Runs that stall on their first
  // request (`docs/harness-permission-mapping.md`).
  const askable = chosenHarness === 'claude'
  const effectiveMode: PermissionMode = askable ? permissionMode : 'auto'

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

  useEffect(() => {
    void refresh()
    void window.shell.getReadiness().then(setReadiness, () => undefined)
  }, [refresh])

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
          skill,
          harness: chosenHarness,
          model,
          effort,
          permissionMode: effectiveMode
        })
        setPhase({ state: 'ready', snapshot: next })
        if (source === 'composer' && !submissionId) setDraft('')
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
    [sessionId, chosenHarness, skill, model, effort, effectiveMode, refresh]
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
  const canDevelop = selected?.capabilities.developSession
  const blocked = readiness !== null && canDevelop?.available !== true
  const resumable = phase.snapshot.recovery?.resumableSubmissionId ?? null
  const resumableText = entries.find(
    (entry) => entry.kind === 'message' && entry.submissionId === resumable
  )

  return (
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
            Nothing has been developed yet. Choose a Skill below and send your first message.
          </li>
        )}
        {entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} />
        ))}
        {liveForActiveRun?.messages
          .filter((message) => message.text)
          .map((message) => (
            <li key={message.id} className="flex gap-2">
              <Bot aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
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

      {pendingApproval && (
        <div
          role="alert"
          aria-label="Approval request"
          className="mx-3 mb-3 rounded-md border border-border bg-muted/50 p-3"
        >
          <p className="flex items-center gap-2 text-xs font-medium">
            <ShieldQuestion aria-hidden="true" className="size-3.5 shrink-0" />
            The agent is asking before it uses {pendingApproval.tool}. This Run is blocked until you
            answer.
          </p>
          <p className="mt-2 font-mono text-xs break-all select-text">{pendingApproval.summary}</p>
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
                  resumableText.source === 'suggested-response' ? 'suggested-response' : 'composer',
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
        <textarea
          id="conversation-composer"
          value={draft}
          disabled={activeRunId !== null}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={started ? 'Write your answer…' : 'What should we develop or decide?'}
          className="min-h-20 rounded-md border border-border bg-background p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Field label="Skill">
            <select
              aria-label="Skill"
              value={skill}
              onChange={(event) => setSkill(event.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            >
              <option value="grilling">Grill Me</option>
              <option value="wayfinder">Wayfinder</option>
            </select>
          </Field>
          <Field label="Harness">
            <select
              aria-label="Harness"
              value={selected?.harness ?? ''}
              onChange={(event) => setHarness(event.target.value as HarnessId)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            >
              {harnesses.length === 0 && <option value="">No Harness available</option>}
              {harnesses.map((entry) => (
                <option key={entry.harness} value={entry.harness}>
                  {entry.displayName}
                  {entry.capabilities.developSession.available ? '' : ' — unavailable'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model">
            <input
              aria-label="Model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={HARNESS_DEFAULT_MODEL}
              title={`Leave as “${HARNESS_DEFAULT_MODEL}” to use the Harness’s configured model.`}
              className="h-8 w-36 rounded-md border border-border bg-background px-2 text-xs"
            />
          </Field>
          <Field label="Effort">
            <select
              aria-label="Effort"
              value={effort}
              onChange={(event) => setEffort(event.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs capitalize"
            >
              {EFFORT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Permission">
            <select
              aria-label="Permission Mode"
              value={effectiveMode}
              onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            >
              <option value="ask" disabled={!askable}>
                {askable ? 'Ask' : 'Ask — not on this Harness yet'}
              </option>
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
          {effectiveMode === 'ask'
            ? 'In Ask, the agent stops for your approval before it edits or runs anything.'
            : 'In Full access, the agent edits and runs without asking. The Harness applies its own permissions for this Run.'}
        </p>
        {/* The mapping onto each Harness is lossy, and ADR 0003 says the
            differences are stated rather than discovered. */}
        {chosenHarness === 'codex' && (
          <p className="text-[11px] text-muted-foreground">
            Codex differs from Claude Code here: Ask is not answerable yet, so a Run uses Full
            access, and a Skill reaches it as instructions for the Run rather than natively.
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
function FileChangeRow({ path, hunks }: { path: string; hunks: DiffHunk[] }): React.JSX.Element {
  const added = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.startsWith('+')).length,
    0
  )
  const removed = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.startsWith('-')).length,
    0
  )
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
        <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-surface p-2 font-mono text-[11px] select-text">
          {hunks.map((hunk, index) => (
            // A hunk is identified by where it starts and how far it runs.
            <div key={`${hunk.oldStart}:${hunk.newStart}:${hunk.lines.length}`}>
              {index > 0 && <div className="text-muted-foreground">⋯</div>}
              {hunk.lines.map((line, lineIndex) => (
                <div
                  // A diff line has no identity beyond its position.
                  // eslint-disable-next-line @eslint-react/no-array-index-key
                  key={lineIndex}
                  className={
                    line.startsWith('+')
                      ? 'text-positive'
                      : line.startsWith('-')
                        ? 'text-destructive'
                        : 'text-muted-foreground'
                  }
                >
                  {line}
                </div>
              ))}
            </div>
          ))}
        </pre>
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
  if (entry.kind === 'file-change') return <FileChangeRow path={entry.path} hunks={entry.hunks} />
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
