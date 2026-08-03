import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowUp,
  ChevronRight,
  FileDiff,
  FileText,
  LoaderCircle,
  ShieldQuestion,
  Square,
  Terminal,
  TriangleAlert
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
  type HarnessUsage,
  type PermissionMode,
  type RunSnapshot,
  type SessionSummary,
  type SuggestedResponse
} from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import {
  applicableEffort,
  effectiveChoice,
  HarnessNote,
  ModelPicker,
  useModelCatalog,
  type ModelChoice
} from '@renderer/components/ModelPicker'
import { DiffCounts, DiffView, ExitCode } from '@renderer/components/Diff'
import { PermissionModePicker } from '@renderer/components/PermissionModePicker'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@renderer/components/ui/message-scroller'
import {
  ChosenSkillNote,
  offeredSkill,
  SkillSuggestions,
  skillsMatching,
  useSkillCatalog
} from '@renderer/components/Skills'
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

export function Conversation({
  session,
  onOpenFile
}: {
  session: SessionSummary
  /** Opens the Files panel focused on one file — the app's one diff surface. */
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  const sessionId = session.id
  const [phase, setPhase] = useState<Phase>({ state: 'loading' })
  const [runs, setRuns] = useState<RunSnapshot[]>([])
  const [live, setLive] = useState<LiveRun | null>(null)
  const [draft, setDraft] = useState('')
  // No Skill by default. Most messages are not asking for a methodology, and
  // one applied because it happened to be selected is one nobody chose.
  const [skill, setSkill] = useState<string | null>(null)
  // One choice, not three: the model carries the Harness that reaches it.
  const { models, readiness } = useModelCatalog()
  const [chosen, setChosen] = useState<ModelChoice | null>(null)
  // Ask by default: a Run edits the Project in place, and being asked first is
  // the posture somebody would choose if they were choosing deliberately.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask')
  const [deciding, setDeciding] = useState(false)
  // Read once per second only while a Run works, so the divider and the
  // activity block can say how long it has been at it.
  const [clock, setClock] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const snapshot = phase.state === 'ready' ? phase.snapshot : null
  const activeRunId = snapshot?.activeRunId ?? null
  const pendingApproval = useMemo(
    () =>
      snapshot?.entries.find(
        (entry): entry is Extract<ConversationEntry, { kind: 'approval' }> =>
          entry.kind === 'approval' && entry.id === snapshot.pendingApprovalId
      ) ?? null,
    [snapshot]
  )

  // The Harness comes from the model, and the first group is one that can
  // actually run a Session: offering one the app has just said it cannot use
  // is how a person ends up watching nothing happen.
  // A Harness that stops being usable stops being a group, and the choice
  // falls back to one that can still run a message. A Run already sent keeps
  // what it recorded.
  const choice = effectiveChoice(models, chosen)
  const chosenHarness = choice?.harness ?? null
  const [catalog, setCatalog] = useSkillCatalog({
    projectRoot: session.projectRoot,
    harness: chosenHarness
  })

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
  }, [refresh])

  // While a Run is in flight the durable snapshot is what settles partial
  // messages, so it is re-read until the Run reaches a boundary.
  useEffect(() => {
    if (!activeRunId) return
    const timer = window.setInterval(() => void refresh(), 750)
    return () => window.clearInterval(timer)
  }, [activeRunId, refresh])

  useEffect(() => {
    if (!activeRunId) return
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [activeRunId])

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

  const chosenSkill = offeredSkill(catalog, skill)
  const matchingSkills = skillsMatching(catalog, draft)

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
          remember
        })
        setPhase({ state: 'ready', snapshot: next })
      } catch {
        setError('That request could not be answered. The Run may have already ended.')
        await refresh()
      } finally {
        setDeciding(false)
      }
    },
    [sessionId, refresh]
  )

  const stop = useCallback(() => {
    if (!activeRunId) return
    void window.shell.stopRun({ runId: activeRunId, sessionId }).then(
      () => refresh(),
      () => setError('The Run could not be stopped.')
    )
  }, [activeRunId, sessionId, refresh])

  // The card's own shortcuts, exactly as it states them: ⏎ allow · esc deny.
  // ⌘. stops the Run whether or not anything is being asked. Typing surfaces
  // keep their keys — the composer is disabled while a Run works anyway.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey && event.key === '.') {
        if (!activeRunId) return
        event.preventDefault()
        stop()
        return
      }
      if (!pendingApproval || deciding || event.metaKey || event.altKey || event.ctrlKey) return
      const target = event.target
      // A focused control already answers Enter itself; answering here too
      // would decide the same request twice, or a different thing entirely.
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLButtonElement && event.key === 'Enter')
      ) {
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void decide(pendingApproval, 'allow')
      } else if (event.key === 'Escape') {
        event.preventDefault()
        void decide(pendingApproval, 'deny')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pendingApproval, deciding, decide, activeRunId, stop])

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
  const items = groupEntries(entries)
  // Whether the Harness behind the chosen model can run a Session at all.
  const canDevelop = readiness?.harnesses.find((entry) => entry.harness === chosenHarness)
    ?.capabilities.developSession
  const blocked = readiness !== null && canDevelop?.available !== true
  const resumable = phase.snapshot.recovery?.resumableSubmissionId ?? null
  const resumableText = entries.find(
    (entry) => entry.kind === 'message' && entry.submissionId === resumable
  )

  /** One row of the transcript, measured and anchored by the scroller. */
  const row = (key: string, children: React.ReactNode, anchor = false): React.JSX.Element => (
    <MessageScrollerItem key={key} messageId={key} scrollAnchor={anchor}>
      {children}
    </MessageScrollerItem>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The reader's place is the scroller's to keep (mock 1a). A new turn
          anchors near the top with a peek of what came before it, the reply
          streams into the room below, and nothing moves once the reader has
          scrolled away — including when a Run streams for minutes. */}
      <MessageScrollerProvider
        autoScroll
        defaultScrollPosition="last-anchor"
        scrollPreviousItemPeek={56}
      >
        <MessageScroller className="min-h-0 flex-1">
          {activeRunId && (
            <div className="absolute end-4 top-3 z-10">
              <Button size="sm" variant="secondary" onClick={stop}>
                <Square aria-hidden="true" className="size-3" /> Stop
              </Button>
            </div>
          )}
          {/* The viewport is the scroll region a keyboard can reach; the
              content inside it is the transcript itself, and it is the
              transcript that is the live log. */}
          <MessageScrollerViewport aria-label="Conversation">
            <MessageScrollerContent
              aria-label="Conversation history"
              aria-busy={activeRunId !== null}
              className="mx-auto w-full max-w-3xl gap-5 px-10 pt-8 pb-6"
            >
              {items.map((item) => {
                if (item.type === 'user') {
                  // The user's message starts the turn, so it is what the
                  // viewport anchors on.
                  return row(item.entry.id, <UserBubble entry={item.entry} />, true)
                }
                if (item.type === 'assistant') {
                  return row(
                    item.entry.id,
                    <AgentText
                      text={item.entry.text}
                      partial={item.entry.completeness === 'partial'}
                    />
                  )
                }
                if (item.type === 'note') {
                  return row(
                    item.entry.id,
                    <p className="font-mono text-2xs text-muted-foreground">{item.entry.summary}</p>
                  )
                }
                return row(
                  item.runId,
                  <RunSection
                    group={item}
                    run={runs.find((run) => run.id === item.runId) ?? null}
                    active={item.runId === activeRunId}
                    waiting={pendingApproval?.runId === item.runId}
                    clock={clock}
                    live={liveForActiveRun?.runId === item.runId ? liveForActiveRun : null}
                    onOpenFile={onOpenFile}
                  />
                )
              })}
              {activeRunId &&
                !pendingApproval &&
                !liveForActiveRun?.messages.some((message) => message.text) &&
                row(
                  'waiting',
                  <p className="text-xs text-muted-foreground">
                    Waiting for the Harness to answer…
                  </p>
                )}

              {catalog?.projectTrusted &&
                catalog.available.some((entry) => entry.source === 'project') &&
                row(
                  'skills-trusted',
                  <p className="text-xs text-muted-foreground">
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

              {catalog &&
                catalog.untrusted.length > 0 &&
                row(
                  'skills-untrusted',
                  <div
                    role="alert"
                    aria-label="Project Skills"
                    className="rounded-md border border-border bg-muted/50 p-3"
                  >
                    <p className="text-xs">
                      This Project brings {catalog.untrusted.length === 1 ? 'a Skill' : 'Skills'} of
                      its own. A Skill is instructions for an agent that can edit files and run
                      commands, and these arrived with the repository — so they are not offered
                      until you say so.
                    </p>
                    <ul className="mt-2 flex flex-col gap-1">
                      {catalog.untrusted.map((entry) => (
                        <li key={entry.name} className="text-xs">
                          <span className="font-medium">{entry.name}</span>
                          {entry.description && (
                            <span className="text-muted-foreground"> — {entry.description}</span>
                          )}
                          <span className="block font-mono text-2xs break-all text-muted-foreground select-text">
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
                    <p className="mt-1 text-xs text-muted-foreground">
                      Read them first — they are files in the repository. You can withdraw this at
                      any time.
                    </p>
                  </div>
                )}

              {pendingApproval &&
                row(
                  'approval',
                  <div
                    role="alert"
                    aria-label="Approval request"
                    className="rounded-lg border border-status-blocked-border bg-status-blocked-surface"
                  >
                    <p className="flex items-center gap-2 px-3.5 pt-3 text-xs">
                      <TriangleAlert
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-status-blocked"
                      />
                      <span className="font-semibold">Approval Request</span>
                      <span className="text-muted-foreground">Run is waiting</span>
                    </p>
                    <p className="mx-3.5 mt-2 rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs break-all select-text">
                      {pendingApproval.summary}
                    </p>
                    {pendingApproval.detail && (
                      <details className="mx-3.5 mt-1">
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          What it sent
                        </summary>
                        <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-border bg-surface p-2 font-mono text-xs whitespace-pre-wrap select-text">
                          {pendingApproval.detail}
                        </pre>
                      </details>
                    )}
                    <div className="flex flex-wrap items-center gap-2 px-3.5 py-3">
                      <Button
                        size="sm"
                        disabled={deciding}
                        onClick={() => void decide(pendingApproval, 'allow')}
                      >
                        Allow
                      </Button>
                      {pendingApproval.proposedRule && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={deciding}
                          onClick={() => void decide(pendingApproval, 'allow', true)}
                        >
                          Always allow for {projectName(session.projectRoot)}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={deciding}
                        onClick={() => void decide(pendingApproval, 'deny')}
                      >
                        Deny
                      </Button>
                      <span className="ml-auto font-mono text-2xs text-muted-foreground">
                        ⏎ allow · esc deny
                      </span>
                    </div>
                    {pendingApproval.proposedRule && (
                      // Shown before it is accepted, and never paraphrased. Once a rule
                      // is stored the Harness answers with it before this app is asked
                      // anything, so this line is the last chance to read it.
                      <p className="border-t border-status-blocked-border px-3.5 py-2 text-2xs break-all text-muted-foreground">
                        Always allow stores exactly{' '}
                        <span className="font-mono select-text">
                          {ruleText(pendingApproval.proposedRule)}
                        </span>{' '}
                        — only in {session.projectRoot}, revocable at any time.
                      </p>
                    )}
                  </div>
                )}

              {phase.snapshot.recovery &&
                row(
                  'recovery',
                  <div role="alert" className="rounded-md border border-border bg-muted/50 p-3">
                    <p className="text-xs text-foreground">
                      {RECOVERY_GUIDANCE[phase.snapshot.recovery.category]}
                    </p>
                    <p className="mt-1 text-xs break-words text-muted-foreground">
                      What happened: {phase.snapshot.recovery.summary}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
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
              {row('usage', <UsagePanel usage={phase.snapshot.usage} />)}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>

        {/* Everything the person answers with rides below the transcript, as
            the mock draws it: the composer is the floor of the surface, not a
            row of the conversation. */}
        <div className="mx-auto w-full max-w-3xl shrink-0 px-10 pb-4">
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
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (draft.trim()) void send(draft.trim(), 'composer')
            }}
          >
            <label className="sr-only" htmlFor="conversation-composer">
              Your message
            </label>
            {matchingSkills !== null && (
              <SkillSuggestions matching={matchingSkills} onChoose={chooseSkill} />
            )}
            {/* One card, as the mock draws it: the field and everything the
              next message is configured with, in the same box. The Skill is
              asked for with `/` in the message rather than with a control. */}
            <div className="rounded-xl border border-border bg-surface focus-within:ring-2 focus-within:ring-ring">
              <textarea
                id="conversation-composer"
                rows={3}
                value={draft}
                disabled={activeRunId !== null}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  // Mid-composition Enter belongs to the input method.
                  if (event.nativeEvent.isComposing) return
                  if (event.shiftKey || event.altKey) return
                  event.preventDefault()
                  if (draft.trim()) void send(draft.trim(), 'composer')
                }}
                placeholder="Reply, or / for a Skill…"
                className="w-full resize-none bg-transparent px-3 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
              />
              <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
                <PermissionModePicker
                  value={permissionMode}
                  onChange={setPermissionMode}
                  projectRoot={session.projectRoot}
                  disabled={activeRunId !== null}
                />
                <span className="ml-auto">
                  <ModelPicker
                    catalog={models}
                    readiness={readiness}
                    choice={choice}
                    onChange={setChosen}
                    disabled={activeRunId !== null}
                  />
                </span>
                <Button
                  type="submit"
                  size="icon"
                  aria-label="Send"
                  className="rounded-full disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
                  disabled={busy || blocked || activeRunId !== null || !draft.trim()}
                >
                  <ArrowUp aria-hidden="true" className="size-3.5" />
                </Button>
              </div>
            </div>
            {chosenSkill && <ChosenSkillNote name={chosenSkill} onClear={() => setSkill(null)} />}
            <HarnessNote catalog={models} choice={choice} />
            {blocked && canDevelop && (
              <div role="status" className="rounded-md border border-border bg-muted/50 p-2">
                <p className="text-xs text-foreground">{canDevelop.summary}</p>
                {canDevelop.command && (
                  <code className="mt-1 block font-mono text-xs break-all select-text">
                    {canDevelop.command}
                  </code>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  This app never installs or updates a Harness for you.
                </p>
              </div>
            )}
          </form>

          {error && (
            <p role="alert" className="pt-2 text-xs text-destructive">
              {error}
            </p>
          )}

          <Attribution />
        </div>
      </MessageScrollerProvider>
    </div>
  )
}

/** How many diff lines the live preview shows of the file being written. */
const PREVIEW_LINES = 6

/**
 * The running indicator — the product's one use of its brand colour, so every
 * step in flight spins the same way.
 */
function Spinner(): React.JSX.Element {
  return (
    <LoaderCircle
      aria-hidden="true"
      className="size-3 shrink-0 animate-spin text-status-running motion-reduce:animate-none"
    />
  )
}

/**
 * One activity block per Run (mock 2d). While the Run works it streams the
 * current step and a live preview of the last file written; the moment it
 * finishes it collapses to one line, so the Conversation is quiet at rest.
 * The chevron re-expands it any time to the chronological step list — steps
 * only, no captured output. Clicking an edited file opens the Files panel on
 * it, the app's one diff surface.
 */
function RunActivityBlock({
  steps,
  active,
  elapsed,
  live,
  onOpenFile
}: {
  steps: StepEntry[]
  active: boolean
  elapsed: number | null
  live: LiveRun | null
  onOpenFile: (path: string) => void
}): React.JSX.Element | null {
  const [choice, setChoice] = useState<boolean | null>(null)
  // Open while it works, collapsed once it finishes — unless the person chose.
  const expanded = choice ?? active

  // What streamed but is not durable yet. A command or change becomes durable
  // within the refresh interval; until then the live copy stands in for it.
  const liveCommands = (live?.commands ?? []).filter(
    (command) =>
      !steps.some(
        (step) => step.kind === 'command' && step.id === `command:${live?.runId}:${command.id}`
      )
  )
  const liveChanges = (live?.changes ?? []).slice(
    steps.filter((step) => step.kind === 'file-change').length
  )

  const changes = steps.flatMap((step) => (step.kind === 'file-change' ? [step] : []))
  const reads = steps.filter((step) => step.kind === 'read').length
  const edited = new Set([
    ...changes.map((step) => step.path),
    ...liveChanges.map((change) => change.path)
  ])
  const commandCount = steps.filter((step) => step.kind === 'command').length + liveCommands.length
  const totals = [...changes, ...liveChanges.map((change) => countDiffLines(change.hunks))].reduce(
    (sum, change) => ({
      added: sum.added + change.added,
      removed: sum.removed + change.removed
    }),
    { added: 0, removed: 0 }
  )
  if (!active && steps.length === 0) return null

  const summary =
    [
      reads > 0 && `Read ${String(reads)} file${reads === 1 ? '' : 's'}`,
      edited.size > 0 && `Edited ${String(edited.size)} file${edited.size === 1 ? '' : 's'}`,
      commandCount > 0 && `Ran ${String(commandCount)} command${commandCount === 1 ? '' : 's'}`
    ]
      .filter(Boolean)
      .join(' · ') || 'Worked'

  // The step in flight, for the collapsed running line.
  const runningCommand =
    liveCommands.find((command) => command.running) ??
    steps.flatMap((step) => (step.kind === 'command' && step.running ? [step] : [])).at(-1)
  const lastWrite = liveChanges.at(-1) ?? changes.at(-1)
  const current = runningCommand
    ? runningCommand.command
    : lastWrite
      ? `Wrote ${lastWrite.path}`
      : 'Working…'

  // The live preview: the tail of the last diff the Harness reported.
  const previewHunk = active ? (lastWrite?.hunks.at(-1) ?? null) : null

  return (
    <li>
      <div className="overflow-hidden rounded-lg border border-border" aria-label="Run activity">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setChoice(!expanded)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/40"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
              expanded && 'rotate-90'
            )}
          />
          {active && !expanded && <Spinner />}
          <span className="min-w-0 flex-1 truncate">
            {active ? (expanded ? 'Working…' : current) : summary}
          </span>
          {active && elapsed !== null ? (
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">
              {formatDuration(elapsed)}
            </span>
          ) : (
            (totals.added > 0 || totals.removed > 0) && (
              <span className="shrink-0 font-mono text-2xs">
                <DiffCounts added={totals.added} removed={totals.removed} />
              </span>
            )
          )}
        </button>
        {expanded && (steps.length > 0 || liveCommands.length > 0 || liveChanges.length > 0) && (
          <ol className="border-t border-border py-1" aria-label="Run steps">
            {steps.map((step) => (
              <StepRow key={step.id} step={step} onOpenFile={onOpenFile} />
            ))}
            {liveCommands.map((command) => (
              <li
                key={command.id}
                className="flex items-center gap-2 px-3 py-1 font-mono text-xs text-muted-foreground"
              >
                {command.running ? (
                  <Spinner />
                ) : (
                  <Terminal aria-hidden="true" className="size-3 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate select-text">{command.command}</span>
              </li>
            ))}
            {liveChanges.map((change) => {
              const counted = countDiffLines(change.hunks)
              return (
                <li
                  key={change.id}
                  className="flex items-center gap-2 px-3 py-1 font-mono text-xs text-muted-foreground"
                >
                  <FileDiff aria-hidden="true" className="size-3 shrink-0" />
                  <span className="min-w-0 flex-1 truncate select-text">{change.path}</span>
                  <span className="shrink-0">
                    <DiffCounts added={counted.added} removed={counted.removed} />
                  </span>
                </li>
              )
            })}
          </ol>
        )}
        {expanded && previewHunk && (
          <div className="border-t border-border">
            <DiffView
              hunks={[{ ...previewHunk, lines: previewHunk.lines.slice(-PREVIEW_LINES) }]}
            />
          </div>
        )}
        {expanded && active && (
          <p className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-2xs text-muted-foreground">
            Streaming as the agent works — collapses when the Run finishes.
            <span className="ml-auto shrink-0 font-mono">⌘. stop</span>
          </p>
        )}
      </div>
    </li>
  )
}

/** One chronological step of a Run: a read, an edit, or a command. */
function StepRow({
  step,
  onOpenFile
}: {
  step: StepEntry
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  if (step.kind === 'read') {
    return (
      <li className="flex items-center gap-2 px-3 py-1 font-mono text-xs text-muted-foreground">
        <FileText aria-hidden="true" className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate select-text">Read {step.path}</span>
        {step.durationMs !== null && (
          <span className="shrink-0 text-2xs">{formatDuration(step.durationMs)}</span>
        )}
      </li>
    )
  }
  if (step.kind === 'command') {
    return (
      <li className="flex items-center gap-2 px-3 py-1 font-mono text-xs text-muted-foreground">
        {step.running ? <Spinner /> : <Terminal aria-hidden="true" className="size-3 shrink-0" />}
        <span className="min-w-0 flex-1 truncate select-text">{step.command}</span>
        {!step.running && step.exitCode !== null ? (
          <span className="shrink-0">
            <ExitCode code={step.exitCode} />
          </span>
        ) : (
          !step.running && step.failed && <span className="shrink-0 text-destructive">failed</span>
        )}
        {!step.running && step.durationMs !== null && (
          <span className="shrink-0 text-2xs">{formatDuration(step.durationMs)}</span>
        )}
      </li>
    )
  }
  // An edit. The row is a way into the Files panel, the one diff surface.
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpenFile(step.path)}
        className="flex w-full items-center gap-2 px-3 py-1 text-left font-mono text-xs text-muted-foreground hover:bg-muted/40"
      >
        <FileDiff aria-hidden="true" className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate select-text">{step.path}</span>
        <span className="shrink-0">
          <DiffCounts added={step.added} removed={step.removed} />
        </span>
      </button>
    </li>
  )
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
        <p className="text-xs text-muted-foreground">
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

type MessageEntry = Extract<ConversationEntry, { kind: 'message' }>
type BoundaryEntry = Extract<ConversationEntry, { kind: 'boundary' }>
type ApprovalEntry = Extract<ConversationEntry, { kind: 'approval' }>
/** What a Run did, in the order it did it: reads, edits, commands. */
type StepEntry = Extract<ConversationEntry, { kind: 'command' | 'file-change' | 'read' }>

interface RunGroup {
  type: 'run'
  runId: string
  started: BoundaryEntry | null
  ended: BoundaryEntry | null
  messages: MessageEntry[]
  steps: StepEntry[]
  approvals: ApprovalEntry[]
}

type ConversationItem =
  | { type: 'user'; entry: MessageEntry }
  | { type: 'assistant'; entry: MessageEntry }
  | { type: 'note'; entry: BoundaryEntry }
  | RunGroup

/**
 * The flat durable journal folded into what the surface shows: user messages
 * on their own, and one group per Run holding its prose, its steps and its
 * approvals. The order of the groups is the order the Runs happened in.
 */
function groupEntries(entries: ConversationEntry[]): ConversationItem[] {
  const items: ConversationItem[] = []
  const groups = new Map<string, RunGroup>()
  const groupFor = (runId: string): RunGroup => {
    const known = groups.get(runId)
    if (known) return known
    const created: RunGroup = {
      type: 'run',
      runId,
      started: null,
      ended: null,
      messages: [],
      steps: [],
      approvals: []
    }
    groups.set(runId, created)
    items.push(created)
    return created
  }
  for (const entry of entries) {
    switch (entry.kind) {
      case 'message':
        if (entry.role === 'user') items.push({ type: 'user', entry })
        else if (entry.runId !== null) groupFor(entry.runId).messages.push(entry)
        else items.push({ type: 'assistant', entry })
        break
      case 'boundary':
        if (entry.boundary === 'run-started') groupFor(entry.runId).started = entry
        else if (entry.boundary === 'configuration') items.push({ type: 'note', entry })
        else groupFor(entry.runId).ended = entry
        break
      case 'command':
      case 'file-change':
      case 'read':
        groupFor(entry.runId).steps.push(entry)
        break
      case 'approval':
        groupFor(entry.runId).approvals.push(entry)
        break
      case 'usage':
      case 'thread':
        break
    }
  }
  return items
}

/** The Run's Permission Mode, in the product's own words. */
const MODE_LABEL: Record<PermissionMode, string> = { ask: 'Ask', auto: 'Full access' }

/** The Project as a person names it: the folder, not the whole path. */
function projectName(projectRoot: string): string {
  return projectRoot.split('/').filter(Boolean).at(-1) ?? projectRoot
}

/** `8.2s`, `22s`, `3m 05s` — the precision worth reading at each scale. */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1_000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${String(Math.round(seconds))}s`
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes)}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`
}

function formatClock(at: string): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function UserBubble({ entry }: { entry: MessageEntry }): React.JSX.Element {
  return (
    <div className="flex justify-end">
      <p className="max-w-2xl rounded-lg bg-accent px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap select-text">
        {entry.text}
      </p>
    </div>
  )
}

/**
 * Assistant prose, flat like a document: no avatar, no header. Backtick spans
 * render as the same mono chips the rest of the product uses for paths and
 * symbols, because that is what they are.
 */
function AgentText({ text, partial }: { text: string; partial: boolean }): React.JSX.Element {
  const parts = text.split('`')
  const balanced = parts.length % 2 === 1
  return (
    <div>
      <div className="text-sm leading-relaxed whitespace-pre-wrap select-text">
        {balanced && parts.length > 1
          ? parts.map((part, index) =>
              index % 2 === 1 && part && !part.includes('\n') ? (
                // A chip is identified by nothing but where it sits in the text.
                // eslint-disable-next-line @eslint-react/no-array-index-key
                <code key={index} className="rounded-sm bg-accent px-1 font-mono text-xs">
                  {part}
                </code>
              ) : (
                // eslint-disable-next-line @eslint-react/no-array-index-key
                <span key={index}>{index % 2 === 1 ? `\`${part}\`` : part}</span>
              )
            )
          : text}
      </div>
      {partial && (
        <p className="mt-1 text-xs text-muted-foreground">
          Partial — the Run ended before this message finished.
        </p>
      )}
    </div>
  )
}

/**
 * One Run of the Conversation: its quiet mono divider, its prose, its
 * activity block, and the approvals it asked for. A stack of rows rather than
 * a box — the Conversation stays a single flat document.
 */
function RunSection({
  group,
  run,
  active,
  waiting,
  clock,
  live,
  onOpenFile
}: {
  group: RunGroup
  run: RunSnapshot | null
  active: boolean
  waiting: boolean
  clock: number
  live: LiveRun | null
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  const startedAt = group.started?.at ?? run?.acceptedAt ?? null
  const resolved = group.approvals.filter((entry) => entry.decision !== null)
  return (
    <div className="flex flex-col gap-4">
      <RunDivider
        group={group}
        run={run}
        active={active}
        waiting={waiting}
        clock={clock}
        startedAt={startedAt}
      />
      {group.messages.map((message) => (
        <AgentText
          key={message.id}
          text={message.text}
          partial={message.completeness === 'partial'}
        />
      ))}
      {(live?.messages ?? [])
        .filter((message) => message.text)
        .map((message) => (
          <AgentText key={message.id} text={message.text} partial={false} />
        ))}
      <RunActivityBlock
        steps={group.steps}
        active={active}
        elapsed={active && startedAt !== null ? clock - Date.parse(startedAt) : null}
        live={live}
        onOpenFile={onOpenFile}
      />
      {resolved.map((entry) => (
        <ApprovalRow key={entry.id} entry={entry} />
      ))}
      {/* The sanitized activity log surfaces only when a Run ended badly —
          that is exactly when the detail matters, and it belongs to the Run
          that produced it rather than to the bottom of the screen. */}
      {run && FAILED_STATUSES.has(run.status) && <ActivityPanel run={run} defaultOpen />}
    </div>
  )
}

/**
 * The Run boundary as a rule of the page: `Run · model · mode`, a hairline,
 * and on the right what became of it — running, waited on, or how long it
 * worked. Mono and muted, so history reads as history.
 */
function RunDivider({
  group,
  run,
  active,
  waiting,
  clock,
  startedAt
}: {
  group: RunGroup
  run: RunSnapshot | null
  active: boolean
  waiting: boolean
  clock: number
  startedAt: string | null
}): React.JSX.Element {
  const model = run?.configuration.model ?? group.started?.model ?? null
  const mode = run ? MODE_LABEL[run.configuration.permissionMode] : null
  const label = ['Run', model, mode].filter(Boolean).join(' · ')
  const ended = group.ended
  let outcome: React.ReactNode = null
  if (active && !waiting) {
    outcome = (
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-status-running" />
        Running{startedAt !== null && ` · ${formatDuration(clock - Date.parse(startedAt))}`}
      </span>
    )
  } else if (active && waiting) {
    outcome = startedAt !== null ? formatClock(startedAt) : null
  } else if (ended?.boundary === 'run-completed' && startedAt !== null) {
    outcome = `Worked for ${formatDuration(Date.parse(ended.at) - Date.parse(startedAt))}`
  } else if (ended?.boundary === 'run-stopped') {
    outcome = 'Stopped'
  } else if (ended?.boundary === 'run-failed') {
    outcome = 'Failed'
  } else if (startedAt !== null) {
    outcome = formatClock(startedAt)
  }
  return (
    <li
      aria-label={label}
      className="flex items-center gap-2.5 font-mono text-2xs text-muted-foreground"
    >
      <span className="shrink-0">{label}</span>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
      {outcome !== null && <span className="shrink-0">{outcome}</span>}
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
    <section aria-label="Harness-reported usage">
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
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
      <p className="mt-1 text-xs text-muted-foreground">
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
      <summary className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
        <ChevronRight
          aria-hidden="true"
          className="size-3 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        Activity — {run.status.replace('-', ' ')}
      </summary>
      {/* What this Run was actually asked for, pinned when it was accepted.
          A Run keeps what it was given, whatever is chosen after it. */}
      <p className="mt-2 text-xs text-muted-foreground">
        {run.configuration.harness === 'claude' ? 'Claude Code' : 'Codex'} ·{' '}
        <span className="font-mono">{run.configuration.model}</span>
        {run.configuration.effort !== null && ` · thinking ${run.configuration.effort}`}
        {run.configuration.skill && ` · ${run.configuration.skill.name} Skill`}
      </p>
      <ol className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto text-xs">
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
    <footer className="pt-2 text-2xs text-muted-foreground">
      {SKILL_ATTRIBUTION.notice}{' '}
      <Button
        size="sm"
        variant="ghost"
        className="h-auto px-1 text-2xs underline"
        onClick={() => open(SKILL_ATTRIBUTION.website)}
      >
        {SKILL_ATTRIBUTION.author}’s website
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-auto px-1 text-2xs underline"
        onClick={() => open(SKILL_ATTRIBUTION.repository)}
      >
        skills repository ({SKILL_ATTRIBUTION.licence})
      </Button>
    </footer>
  )
}
