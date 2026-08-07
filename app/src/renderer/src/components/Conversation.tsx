import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ThinkingOrb } from 'thinking-orbs'
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileDiff,
  FileText,
  LoaderCircle,
  Paperclip,
  Pause,
  Pencil,
  Play,
  ShieldQuestion,
  Square,
  Terminal,
  TriangleAlert,
  X
} from 'lucide-react'
import {
  DEFAULT_EFFORT,
  HARNESS_DEFAULT_MODEL,
  assistantMessageId,
  isActiveQueuedSubmission,
  projectDisplayName,
  ruleText,
  type ApprovalDecision,
  type ConversationEntry,
  type ConversationRecovery,
  type PermissionMode,
  type QueueOutcome,
  type ReviewAttachment,
  type RunSnapshot,
  type SessionSummary,
  type SkillCatalog
} from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import {
  applicableEffort,
  effectiveChoice,
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
import { displayCommand } from '@shared/command'
import { TurnRail, type TurnStep, type TurnSummary } from '@renderer/components/TurnRail'
import {
  ToolResult,
  ToolResultOutput,
  type ToolResultStatus
} from '@renderer/components/ui/tool-result'
import {
  ChosenSkillNote,
  offeredSkill,
  SkillSuggestions,
  skillsMatching,
  useSkillCatalog
} from '@renderer/components/Skills'
import type { LiveRun } from '@renderer/lib/selected-conversation-read-model'
import type { SelectedConversation } from '@renderer/lib/useSelectedConversation'
import { cn } from '@renderer/lib/utils'

/**
 * The Session's permanent Conversation: the primary surface for developing it.
 * Streamed assistant text arrives on the push channel and is reconciled
 * against the durable snapshot, so what is on screen never outlives what was
 * saved. Suggested Responses submit directly; typed answers wait for Send.
 */

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

const HARNESS_LABEL = { claude: 'Claude Code', codex: 'Codex' } as const

const NO_CONVERSATION_ENTRIES: ConversationEntry[] = []

const QUEUE_ANNOUNCEMENT: Partial<Record<QueueOutcome['type'], string>> = {
  enqueued: 'Queued Submission added',
  edited: 'Queued Submission edited; queue paused',
  'moved-earlier': 'Moved earlier',
  'moved-later': 'Moved later',
  cancelled: 'Queued Submission cancelled',
  paused: 'Queue paused',
  resumed: 'Queue resumed',
  prioritized: 'Queued Submission prioritized'
}

function durableQueueAnnouncement(outcome: QueueOutcome | null): string {
  return outcome ? (QUEUE_ANNOUNCEMENT[outcome.type] ?? '') : ''
}

/**
 * Recovery is a choice for the latest unresolved turn, not permanent history.
 * A newer message or Run means the person already continued, even if an older
 * snapshot projection still carries the recovery value.
 */
function currentRecovery(
  entries: ConversationEntry[],
  recovery: ConversationRecovery | null
): { recovery: ConversationRecovery; key: string } | null {
  if (recovery === null) return null

  let boundaryIndex = -1
  let boundaryId = ''
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (
      entry?.kind === 'boundary' &&
      entry.recovery?.category === recovery.category &&
      entry.recovery.summary === recovery.summary &&
      entry.recovery.resumableSubmissionId === recovery.resumableSubmissionId
    ) {
      boundaryIndex = index
      boundaryId = entry.id
      break
    }
  }
  if (boundaryIndex === -1) return { recovery, key: JSON.stringify(recovery) }

  const continued = entries
    .slice(boundaryIndex + 1)
    .some(
      (entry) =>
        entry.kind === 'message' || (entry.kind === 'boundary' && entry.boundary === 'run-started')
    )
  if (continued) return null

  return { recovery, key: boundaryId }
}

function skillChangeCount(catalog: SkillCatalog): number {
  return (
    catalog.changes.added.length + catalog.changes.removed.length + catalog.changes.changed.length
  )
}

function projectSkillErrorText(reason: NonNullable<SkillCatalog['projectTrustError']>): string {
  switch (reason) {
    case 'unreadable':
      return 'not readable'
    case 'unsupported':
      return 'using a symlink or unsupported file type'
    case 'cyclic':
      return 'cyclic'
    case 'over-limit':
      return 'over the file or byte safety limit'
  }
}

export function Conversation({
  session,
  conversation,
  onOpenFile
}: {
  session: SessionSummary
  conversation: SelectedConversation
  /** Opens the Files panel focused on one file — the app's one diff surface. */
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  const sessionId = session.id
  const { phase, runs, live, failureSummary, refresh, adopt: adoptSnapshot } = conversation
  const [draft, setDraft] = useState('')
  const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null)
  const [queuedEdit, setQueuedEdit] = useState('')
  const [queueAnnouncement, setQueueAnnouncement] = useState('')
  const [reviewAttachments, setReviewAttachments] = useState<ReviewAttachment[]>([])
  const reviewAttachmentInputRef = useRef<HTMLInputElement>(null)
  // No Skill by default. Most messages are not asking for a methodology, and
  // one applied because it happened to be selected is one nobody chose.
  const [skill, setSkill] = useState<string | null>(null)
  // One choice, not three: the model carries the Harness that reaches it.
  const { models, readiness } = useModelCatalog()
  const [chosen, setChosen] = useState<ModelChoice | null>(null)
  // The launch screen and this composer are two component lifetimes. Seed the
  // latter from the durable Run so the model chosen for the first message is
  // also what the next message offers. A choice made here outranks refreshes.
  const choiceTouchedRef = useRef(false)
  // Ask by default: a Run edits the Project in place, and being asked first is
  // the posture somebody would choose if they were choosing deliberately.
  // Seeded from the Session's latest Run once its record loads, so the mode
  // chosen at launch travels here instead of silently resetting — a person
  // who sent in Full access must not find the chip claiming Ask.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask')
  // A mode the person picked on this surface outranks any seeding.
  const modeTouchedRef = useRef(false)
  const [deciding, setDeciding] = useState(false)
  // A standing rule is more consequential than answering this one request.
  // The first click reveals the exact commitment in context; the second stores
  // it. Changing requests always withdraws an unfinished confirmation.
  const [standingApprovalConfirmId, setStandingApprovalConfirmId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [optimisticMessage, setOptimisticMessage] = useState<MessageEntry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dismissedRecoveryKey, setDismissedRecoveryKey] = useState<string | null>(null)

  const snapshot = phase.state === 'ready' ? phase.snapshot : null
  const activeRunId = snapshot?.activeRunId ?? null
  const hasQueuedSubmissions = snapshot?.queue.items.some(isActiveQueuedSubmission) ?? false
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
    harness: chosenHarness,
    // A queued Skill losing trust pauses at the launch gate. Re-read here so
    // the explicit trust decision appears with that paused queue.
    refreshWhenQueuePaused: snapshot?.queue.paused
  })

  // Runs arrive newest first. A mode picked here outranks later refreshes;
  // until then the most recent durable Run seeds the next one.
  useEffect(() => {
    const latest = runs[0]
    if (!modeTouchedRef.current && latest) {
      setPermissionMode(latest.configuration.permissionMode)
    }
  }, [runs])

  useEffect(() => {
    const latest = runs[0]
    if (!choiceTouchedRef.current && latest) {
      setChosen({
        harness: latest.configuration.harness,
        model: latest.configuration.model,
        effort: latest.configuration.effort ?? DEFAULT_EFFORT
      })
    }
  }, [runs])

  const chosenSkill = offeredSkill(catalog, skill)
  const matchingSkills = skillsMatching(catalog, draft)

  /** Takes the Skill for this message, and the `/` back out of the message. */
  const chooseSkill = useCallback((name: string) => {
    setSkill(name)
    setDraft('')
  }, [])

  const send = useCallback(
    async (
      text: string,
      source: 'composer' | 'suggested-response',
      submissionId?: string,
      // A queued message carries the Skill chosen when it was parked, not
      // whatever is selected by the time the Run finishes. `undefined` means
      // "the composer's current pick"; `null` means "queued with no Skill".
      queuedSkill?: string | null
    ) => {
      if (!chosenHarness) return
      const messageSkill = queuedSkill === undefined ? chosenSkill : queuedSkill
      const resolvedSubmissionId = submissionId ?? crypto.randomUUID()
      const ownsComposer = source === 'composer' && !submissionId && queuedSkill === undefined
      setOptimisticMessage({
        kind: 'message',
        id: `user:${resolvedSubmissionId}`,
        at: new Date().toISOString(),
        runId: null,
        role: 'user',
        text,
        completeness: 'complete',
        source,
        submissionId: resolvedSubmissionId,
        suggestedResponses: [],
        plainOptions: false
      })
      if (ownsComposer) {
        // Clear at the click, not after launch. The field stays available for
        // the person's next thought while this send settles; no later callback
        // may erase whatever they type in the meantime.
        setDraft((current) => (current.trim() === text ? '' : current))
        setSkill((current) => (current === chosenSkill ? null : current))
      }
      setBusy(true)
      setError(null)
      try {
        const next = await window.shell.developSession({
          sessionId,
          submissionId: resolvedSubmissionId,
          text,
          source,
          ...(messageSkill ? { skill: messageSkill } : {}),
          harness: chosenHarness,
          model: choice?.model ?? HARNESS_DEFAULT_MODEL,
          // Only what the chosen model can be asked for.
          effort: applicableEffort(models, choice),
          permissionMode: permissionMode
        })
        adoptSnapshot(next)
        setOptimisticMessage(null)
      } catch {
        // The message was accepted durably before the Run was attempted, so
        // re-read before deciding whether the optimistic copy was accepted.
        const durable = await refresh()
        const accepted =
          durable?.entries.some((entry) => entry.id === `user:${resolvedSubmissionId}`) ?? false
        setOptimisticMessage((current) =>
          current?.submissionId === resolvedSubmissionId ? null : current
        )
        if (accepted) {
          setError(
            'The Run could not start. Your message is saved; check that the Harness is ready and that supervision has recovered.'
          )
        } else {
          setError('Your message could not be sent. It has been restored to the composer.')
          if (ownsComposer) {
            setDraft((current) => (current ? current : text))
            setSkill((current) => current ?? messageSkill)
          }
        }
      } finally {
        setBusy(false)
      }
    },
    [sessionId, chosenHarness, chosenSkill, choice, models, permissionMode, refresh, adoptSnapshot]
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
        adoptSnapshot(next)
      } catch {
        setError('That request could not be answered. The Run may have already ended.')
        await refresh()
      } finally {
        setDeciding(false)
      }
    },
    [sessionId, refresh, adoptSnapshot]
  )

  const stop = useCallback(() => {
    if (!activeRunId) return
    void window.shell.stopRun({ runId: activeRunId, sessionId }).then(
      () => refresh(),
      () => setError('The Run could not be stopped.')
    )
  }, [activeRunId, sessionId, refresh])

  // The card takes focus the moment a request arrives, so ⏎ and esc are
  // already speaking to it — and only to it. Allowing is the app's
  // highest-stakes act, and a reflexive Enter with focus somewhere else must
  // not grant a command nobody read. But a person mid-word in the composer
  // keeps their keyboard: pulling focus out of a text field would turn the
  // very next Enter — a newline one keystroke ago — into a grant. The card's
  // alert role announces it either way; whoever is typing comes to it when
  // they are ready.
  const approvalCardRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const pendingApprovalId = pendingApproval?.id ?? null
  useEffect(() => {
    if (pendingApprovalId === null) return
    const active = document.activeElement
    const typing =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable)
    if (!typing) approvalCardRef.current?.focus()
  }, [pendingApprovalId])

  // The card's one shortcut, exactly as it states it: ⏎ allows, and only
  // while the person is on the card. Escape is the universal "not now" — it
  // steps off the card, withdrawing the key, and never answers the request:
  // a refusal is an instruction the agent carries on with, and a reflex
  // pressed to close a popover must not quietly steer the Run. Deny stays on
  // its button, where it has to be read to be pressed. ⌘. stops the Run
  // whether or not anything is being asked.
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
      // Only while the person is on the card. Clicking away withdraws the
      // key; the buttons remain, and the card can be refocused.
      if (!approvalCardRef.current?.contains(document.activeElement)) return
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void decide(pendingApproval, 'allow')
      } else if (event.key === 'Escape') {
        event.preventDefault()
        ;(document.activeElement as HTMLElement | null)?.blur()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pendingApproval, deciding, decide, activeRunId, stop])

  const durableEntries = snapshot?.entries ?? NO_CONVERSATION_ENTRIES
  const optimisticMessageId = optimisticMessage?.id ?? null
  const optimisticVisible =
    optimisticMessageId !== null &&
    !durableEntries.some((entry) => entry.id === optimisticMessageId)
  const visibleEntries = useMemo(
    () =>
      optimisticVisible && optimisticMessage !== null
        ? [...durableEntries, optimisticMessage]
        : durableEntries,
    [durableEntries, optimisticMessage, optimisticVisible]
  )
  const items = useMemo(() => groupEntries(visibleEntries), [visibleEntries])
  const turns = useMemo(() => summarizeTurns(items), [items])
  const recoverable = currentRecovery(durableEntries, snapshot?.recovery ?? null)
  const displayedRecovery = recoverable?.key === dismissedRecoveryKey ? null : (recoverable ?? null)

  // Centered like every other whole-surface state in the app: the surface is
  // loading or failed, not a card that happens to sit at its top-left corner.
  if (phase.state === 'loading') {
    return (
      <div className="flex h-full items-center justify-center" aria-busy="true">
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          Reading this Session’s Conversation…
        </p>
      </div>
    )
  }

  if (phase.state === 'failed') {
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 p-8">
        <p className="text-xs text-destructive">
          This Session’s Conversation could not be read. Nothing in your Project was changed.
        </p>
        <Button size="sm" variant="secondary" onClick={() => void refresh()}>
          Try again
        </Button>
      </div>
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
  // Whether the Harness behind the chosen model can run a Session at all.
  const canDevelop = readiness?.harnesses.find((entry) => entry.harness === chosenHarness)
    ?.capabilities.developSession
  const blocked = readiness !== null && canDevelop?.available !== true
  const resumable = displayedRecovery?.recovery.resumableSubmissionId ?? null
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
        <MessageScroller className="@container/transcript min-h-0 flex-1">
          {/* The turns of this Conversation, in the gutter the centered
              transcript leaves free. It is only drawn where that gutter
              actually exists — narrower than this the rail would be standing
              on the prose it is a map of. */}
          <TurnRail turns={turns} />
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
              className="mx-auto w-full max-w-3xl gap-6 px-6 pt-8 pb-6"
            >
              {items.map((item) => {
                if (item.type === 'user') {
                  // The user's message starts the turn, so it is what the
                  // viewport anchors on.
                  return row(
                    item.entry.id,
                    <UserBubble
                      entry={item.entry}
                      pending={optimisticVisible && item.entry.id === optimisticMessageId}
                    />,
                    true
                  )
                }
                if (item.type === 'assistant') {
                  return row(
                    item.entry.id,
                    <AgentText
                      id={item.entry.id}
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
                    live={liveForActiveRun?.runId === item.runId ? liveForActiveRun : null}
                    onOpenFile={onOpenFile}
                    onContinue={() => composerRef.current?.focus()}
                  />
                )
              })}
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

              {catalog?.projectTrustError &&
                row(
                  'skills-observation-error',
                  <div
                    role="alert"
                    aria-label="Project Skills unavailable"
                    className="rounded-md border border-border bg-muted/50 p-3 text-xs"
                  >
                    Project Skills are {projectSkillErrorText(catalog.projectTrustError)}. They are
                    not trusted, and no Project Skill can start until this is resolved.
                  </div>
                )}

              {catalog?.projectTrustError === null &&
                (catalog.untrusted.length > 0 || skillChangeCount(catalog) > 0) &&
                row(
                  'skills-untrusted',
                  // A standing condition, not an interruption: it reads in
                  // place instead of barging in on every mount.
                  <div
                    role="note"
                    aria-label="Project Skills"
                    className="rounded-md border border-border bg-muted/50 p-3"
                  >
                    <p className="text-xs">
                      This Project brings {catalog.untrusted.length === 1 ? 'a Skill' : 'Skills'} of
                      its own. A Skill is instructions for an agent that can edit files and run
                      commands, and these arrived with the Project — so they are not offered until
                      you say so.
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
                    {skillChangeCount(catalog) > 0 && (
                      <div className="mt-2" aria-label="Project Skill changes">
                        <p className="text-xs font-medium">Changes since you trusted them</p>
                        {(['added', 'removed', 'changed'] as const).map(
                          (kind) =>
                            catalog.changes[kind].length > 0 && (
                              <p key={kind} className="text-xs text-muted-foreground">
                                <span className="capitalize">{kind}</span>:{' '}
                                {catalog.changes[kind]
                                  .map((entry) => `${entry.name} (${entry.harness})`)
                                  .join(', ')}
                              </p>
                            )
                        )}
                      </div>
                    )}
                    <Button
                      className="mt-2"
                      size="sm"
                      variant="secondary"
                      disabled={catalog.reviewedDigest === null}
                      onClick={() =>
                        void window.shell
                          .trustProjectSkills({
                            root: session.projectRoot,
                            harness: chosenHarness ?? 'claude',
                            trusted: true,
                            reviewedDigest: catalog.reviewedDigest ?? undefined
                          })
                          .then(setCatalog, () => setError('Those Skills could not be trusted.'))
                      }
                    >
                      Trust this Project’s Skills
                    </Button>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Read them first — they are files in the Project. If they change before you
                      confirm, the grant is refused. You can withdraw this at any time.
                    </p>
                  </div>
                )}

              {pendingApproval &&
                row(
                  'approval',
                  <div
                    ref={approvalCardRef}
                    role="alert"
                    aria-label="Approval request"
                    tabIndex={-1}
                    className="rounded-lg border border-status-blocked-border bg-status-blocked-surface outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={deciding}
                        onClick={() => void decide(pendingApproval, 'deny')}
                      >
                        Deny
                      </Button>
                      {deciding ? (
                        <span
                          role="status"
                          className="ml-auto flex items-center gap-1.5 font-mono text-2xs text-muted-foreground tabular-nums"
                        >
                          <Spinner /> Answering…
                        </span>
                      ) : (
                        <span className="ml-auto font-mono text-2xs text-muted-foreground">
                          ⏎ allow · esc steps away
                        </span>
                      )}
                    </div>
                    {pendingApproval.proposedRule && (
                      // The durable rule comes before the durable action. Once it is
                      // stored the Harness answers with it before this app is asked
                      // anything, so it must occupy the focal area first.
                      <div className="border-t border-status-blocked-border px-3.5 py-3">
                        <p className="font-medium">Standing authorization</p>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          Every matching request in{' '}
                          <span className="text-foreground">
                            {projectDisplayName(session.projectRoot)}
                          </span>{' '}
                          would be answered with this exact rule:
                        </p>
                        <code className="mt-2 block rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs break-all select-text">
                          {ruleText(pendingApproval.proposedRule)}
                        </code>
                        <p className="mt-1.5 text-xs break-all text-muted-foreground">
                          Stored only for {session.projectRoot}. You can revoke it at any time.
                        </p>
                        {standingApprovalConfirmId === pendingApproval.id ? (
                          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-status-blocked-border pt-3">
                            <p className="mr-auto text-xs font-medium">
                              Store this rule for future matching requests?
                            </p>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={deciding}
                              onClick={() => setStandingApprovalConfirmId(null)}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              disabled={deciding}
                              onClick={() => void decide(pendingApproval, 'allow', true)}
                            >
                              Store this rule
                            </Button>
                          </div>
                        ) : (
                          <Button
                            className="mt-3"
                            size="sm"
                            variant="secondary"
                            disabled={deciding}
                            onClick={() => setStandingApprovalConfirmId(pendingApproval.id)}
                          >
                            Always allow for {projectDisplayName(session.projectRoot)}…
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )}

              {displayedRecovery &&
                row(
                  'recovery',
                  <div
                    role="status"
                    aria-label="Run recovery"
                    className="flex items-start gap-2.5 rounded-md border border-border bg-muted/30 px-3 py-2.5"
                  >
                    <TriangleAlert
                      aria-hidden="true"
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-foreground">
                        {RECOVERY_GUIDANCE[displayedRecovery.recovery.category]}
                      </p>
                      <details className="mt-1 text-xs text-muted-foreground">
                        <summary className="w-fit cursor-pointer select-none">Run details</summary>
                        <p className="mt-1 break-words">{displayedRecovery.recovery.summary}</p>
                      </details>
                    </div>
                    {resumable && resumableText?.kind === 'message' && (
                      <Button
                        className="shrink-0"
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          setDismissedRecoveryKey(displayedRecovery.key)
                          void send(
                            resumableText.text,
                            resumableText.source === 'suggested-response'
                              ? 'suggested-response'
                              : 'composer',
                            resumable
                          )
                        }}
                      >
                        Send again
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Dismiss recovery notice"
                      className="-m-1 size-6 shrink-0"
                      onClick={() => setDismissedRecoveryKey(displayedRecovery.key)}
                    >
                      <X aria-hidden="true" className="size-3" />
                    </Button>
                  </div>
                )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>

        {/* Everything the person answers with rides below the transcript, as
            the mock draws it: the composer is the floor of the surface, not a
            row of the conversation. */}
        <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pb-4">
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
                      disabled={busy || blocked || activeRunId !== null || hasQueuedSubmissions}
                      onClick={() => void send(option.value, 'suggested-response')}
                    >
                      {option.label}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {snapshot && snapshot.queue.items.some(isActiveQueuedSubmission) && (
            <section
              aria-label="Queued Submissions"
              className="mb-2 rounded-lg border border-border bg-muted/30 p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-xs font-medium text-foreground">Queued Submissions</h2>
                  <p className="text-2xs text-muted-foreground">
                    {snapshot.queue.paused
                      ? 'Paused. Nothing starts until you resume.'
                      : 'The next item starts after a completed Run.'}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true)
                    const operation = snapshot.queue.paused
                      ? window.shell.resumeConversationQueue(sessionId)
                      : window.shell.pauseConversationQueue(sessionId)
                    void operation
                      .then(
                        (next) => {
                          adoptSnapshot(next)
                          setQueueAnnouncement(durableQueueAnnouncement(next.queue.outcome))
                        },
                        () => setError('The queue state could not be changed.')
                      )
                      .finally(() => setBusy(false))
                  }}
                >
                  {snapshot.queue.paused ? (
                    <Play aria-hidden="true" className="size-3" />
                  ) : (
                    <Pause aria-hidden="true" className="size-3" />
                  )}
                  {snapshot.queue.paused ? 'Resume queue' : 'Pause queue'}
                </Button>
              </div>
              <ol className="mt-2 space-y-2">
                {snapshot.queue.items
                  .filter(isActiveQueuedSubmission)
                  .map((item, index, active) => (
                    <li key={item.id} className="rounded-md border border-border bg-surface p-2">
                      {editingQueuedId === item.submissionId ? (
                        <form
                          onSubmit={(event) => {
                            event.preventDefault()
                            const text = queuedEdit.trim()
                            if (!text) return
                            setBusy(true)
                            void window.shell
                              .editQueuedSubmission({
                                sessionId,
                                submissionId: item.submissionId,
                                text
                              })
                              .then((next) => {
                                adoptSnapshot(next)
                                setEditingQueuedId(null)
                                setQueueAnnouncement(durableQueueAnnouncement(next.queue.outcome))
                                window.requestAnimationFrame(() =>
                                  document.getElementById(`edit-${item.submissionId}`)?.focus()
                                )
                              })
                              .catch(() => setError('That Queued Submission could not be edited.'))
                              .finally(() => setBusy(false))
                          }}
                        >
                          <label className="sr-only" htmlFor={`queued-edit-${item.submissionId}`}>
                            Edit queued message
                          </label>
                          <textarea
                            id={`queued-edit-${item.submissionId}`}
                            aria-label="Edit queued message"
                            rows={2}
                            value={queuedEdit}
                            onChange={(event) => setQueuedEdit(event.target.value)}
                            className="w-full resize-none rounded border border-border bg-background p-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                          />
                          <div className="mt-2 flex justify-end gap-1">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditingQueuedId(null)}
                            >
                              Cancel
                            </Button>
                            <Button type="submit" size="sm" disabled={busy || !queuedEdit.trim()}>
                              Save queued message
                            </Button>
                          </div>
                        </form>
                      ) : (
                        <>
                          <p className="text-xs text-foreground select-text">{item.text}</p>
                          <p className="mt-1 text-2xs text-muted-foreground">
                            {item.harness} · {item.model} · {item.permissionMode}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-1">
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              aria-label={`Move ${item.text} earlier`}
                              disabled={busy || !item.controls.moveEarlier}
                              onClick={() => {
                                setBusy(true)
                                void window.shell
                                  .moveQueuedSubmission({
                                    sessionId,
                                    submissionId: item.submissionId,
                                    direction: 'earlier'
                                  })
                                  .then((next) => {
                                    adoptSnapshot(next)
                                    setQueueAnnouncement(
                                      durableQueueAnnouncement(next.queue.outcome)
                                    )
                                  })
                                  .finally(() => setBusy(false))
                              }}
                            >
                              <ChevronUp aria-hidden="true" className="size-3" />
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              aria-label={`Move ${item.text} later`}
                              disabled={busy || !item.controls.moveLater}
                              onClick={() => {
                                setBusy(true)
                                void window.shell
                                  .moveQueuedSubmission({
                                    sessionId,
                                    submissionId: item.submissionId,
                                    direction: 'later'
                                  })
                                  .then((next) => {
                                    adoptSnapshot(next)
                                    setQueueAnnouncement(
                                      durableQueueAnnouncement(next.queue.outcome)
                                    )
                                  })
                                  .finally(() => setBusy(false))
                              }}
                            >
                              <ChevronDown aria-hidden="true" className="size-3" />
                            </Button>
                            <Button
                              id={`edit-${item.submissionId}`}
                              type="button"
                              size="icon"
                              variant="ghost"
                              aria-label={`Edit ${item.text}`}
                              disabled={busy || !item.controls.edit}
                              onClick={() => {
                                setQueuedEdit(item.text)
                                setEditingQueuedId(item.submissionId)
                              }}
                            >
                              <Pencil aria-hidden="true" className="size-3" />
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              aria-label={`Cancel ${item.text}`}
                              disabled={busy || !item.controls.cancel}
                              onClick={() => {
                                const focusId =
                                  active[index + 1]?.submissionId ?? active[index - 1]?.submissionId
                                setBusy(true)
                                void window.shell
                                  .cancelQueuedSubmission({
                                    sessionId,
                                    submissionId: item.submissionId
                                  })
                                  .then((next) => {
                                    adoptSnapshot(next)
                                    setQueueAnnouncement(
                                      durableQueueAnnouncement(next.queue.outcome)
                                    )
                                    window.requestAnimationFrame(() => {
                                      if (focusId)
                                        document.getElementById(`edit-${focusId}`)?.focus()
                                      else composerRef.current?.focus()
                                    })
                                  })
                                  .finally(() => setBusy(false))
                              }}
                            >
                              <X aria-hidden="true" className="size-3" />
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={busy || !item.controls.sendNow}
                              onClick={() => {
                                setBusy(true)
                                void window.shell
                                  .sendQueuedSubmissionNow({
                                    sessionId,
                                    submissionId: item.submissionId
                                  })
                                  .then((next) => {
                                    adoptSnapshot(next)
                                    setQueueAnnouncement(
                                      durableQueueAnnouncement(next.queue.outcome)
                                    )
                                  })
                                  .finally(() => setBusy(false))
                              }}
                            >
                              Send now
                            </Button>
                          </div>
                        </>
                      )}
                    </li>
                  ))}
              </ol>
              <p role="status" aria-live="polite" className="sr-only">
                {queueAnnouncement}
              </p>
            </section>
          )}

          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              const text = draft.trim()
              if (!text) return
              if (displayedRecovery) setDismissedRecoveryKey(displayedRecovery.key)
              // While a Run works, capture every Run choice in the durable,
              // Session-owned queue. No pending message exists only in React.
              if (activeRunId !== null || hasQueuedSubmissions) {
                if (!chosenHarness) return
                setBusy(true)
                void window.shell
                  .enqueueQueuedSubmission({
                    sessionId,
                    submissionId: crypto.randomUUID(),
                    text,
                    source: 'composer',
                    ...(chosenSkill ? { skill: chosenSkill } : {}),
                    harness: chosenHarness,
                    model: choice?.model ?? HARNESS_DEFAULT_MODEL,
                    effort: applicableEffort(models, choice),
                    permissionMode,
                    reviewAttachments
                  })
                  .then((next) => {
                    adoptSnapshot(next)
                    setDraft((current) => (current === text ? '' : current))
                    setSkill((current) => (current === chosenSkill ? null : current))
                    setReviewAttachments([])
                    if (reviewAttachmentInputRef.current) {
                      reviewAttachmentInputRef.current.value = ''
                    }
                    setQueueAnnouncement(durableQueueAnnouncement(next.queue.outcome))
                  })
                  .catch(() => setError('That message could not be added to the queue.'))
                  .finally(() => setBusy(false))
                return
              }
              void send(text, 'composer')
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
              {/* The field stays alive while a Run works: thinking happens
                  during the agent's turn, and a person mid-thought must not
                  find their keyboard confiscated. Only sending waits. */}
              <textarea
                id="conversation-composer"
                ref={composerRef}
                rows={3}
                value={draft}
                onChange={(event) => {
                  const nextDraft = event.target.value
                  if (nextDraft.trim() && displayedRecovery) {
                    setDismissedRecoveryKey(displayedRecovery.key)
                  }
                  setDraft(nextDraft)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  // Mid-composition Enter belongs to the input method.
                  if (event.nativeEvent.isComposing) return
                  if (event.shiftKey || event.altKey) return
                  // While a send settles or a Run works, Enter makes a line
                  // rather than a second send — holding a message is the
                  // button's deliberate act, never a keystroke's.
                  if (busy || activeRunId !== null || hasQueuedSubmissions) return
                  event.preventDefault()
                  if (draft.trim()) {
                    if (displayedRecovery) setDismissedRecoveryKey(displayedRecovery.key)
                    void send(draft.trim(), 'composer')
                  }
                }}
                placeholder="Reply, or / for a Skill…"
                className="w-full resize-none bg-transparent px-3 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground"
              />
              <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
                <PermissionModePicker
                  value={permissionMode}
                  onChange={(mode) => {
                    modeTouchedRef.current = true
                    setPermissionMode(mode)
                  }}
                  projectRoot={session.projectRoot}
                  disabled={activeRunId !== null}
                />
                <span className="ml-auto">
                  <ModelPicker
                    catalog={models}
                    readiness={readiness}
                    choice={choice}
                    onChange={(next) => {
                      choiceTouchedRef.current = true
                      setChosen(next)
                    }}
                    disabled={activeRunId !== null}
                  />
                </span>
                {(activeRunId !== null || hasQueuedSubmissions) && (
                  <label className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground focus-within:ring-2 focus-within:ring-ring hover:bg-muted hover:text-foreground">
                    <span className="sr-only">Attach files for queued review</span>
                    <Paperclip aria-hidden="true" className="size-3.5" />
                    <input
                      ref={reviewAttachmentInputRef}
                      type="file"
                      multiple
                      aria-label="Attach files for queued review"
                      className="sr-only"
                      onChange={(event) => {
                        const attachments = Array.from(event.currentTarget.files ?? [])
                          .map((file) => ({
                            path: window.shell.pathForFile(file),
                            name: file.name
                          }))
                          .filter((attachment) => attachment.path.length > 0)
                        setReviewAttachments(attachments)
                      }}
                    />
                  </label>
                )}
                <Button
                  type="submit"
                  size="icon"
                  aria-label={
                    activeRunId !== null || hasQueuedSubmissions ? 'Add to queue' : 'Send'
                  }
                  className="rounded-full disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
                  disabled={busy || blocked || !draft.trim()}
                >
                  <ArrowUp aria-hidden="true" className="size-3.5" />
                </Button>
              </div>
            </div>
            {reviewAttachments.length > 0 && (
              <div className="flex flex-wrap gap-1" aria-label="Queued review attachments">
                {reviewAttachments.map((attachment) => (
                  <span
                    key={attachment.path}
                    className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-2xs text-muted-foreground"
                  >
                    <FileText aria-hidden="true" className="size-3" />
                    {attachment.name ?? attachment.path}
                  </span>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setReviewAttachments([])
                    if (reviewAttachmentInputRef.current) {
                      reviewAttachmentInputRef.current.value = ''
                    }
                  }}
                >
                  Clear attachments
                </Button>
              </div>
            )}
            {activeRunId !== null && (
              <p className="text-xs text-muted-foreground">
                A Run is working. Keep typing — Send adds a durable Queued Submission.{' '}
                <span className="font-mono text-2xs">⌘.</span> stops the Run now.
              </p>
            )}
            {chosenSkill && <ChosenSkillNote name={chosenSkill} onClear={() => setSkill(null)} />}
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

          {(error ?? failureSummary) && (
            <p role="alert" className="pt-2 text-xs text-destructive">
              {error ?? failureSummary}
            </p>
          )}
        </div>
      </MessageScrollerProvider>
    </div>
  )
}

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
 * What a Run in flight shows: the composing orb, the current step
 * shimmering as it streams, and how long the Run has been at it. One quiet
 * row rather than a panel — the step-by-step record arrives once the Run has
 * finished, when there is a record to read.
 */
function RunWorkingIndicator({
  steps,
  live,
  startedAt
}: {
  steps: StepEntry[]
  live: LiveRun | null
  startedAt: string | null
}): React.JSX.Element {
  const runningCommand =
    (live?.commands ?? []).find((command) => command.running) ??
    steps.flatMap((step) => (step.kind === 'command' && step.running ? [step] : [])).at(-1)
  const lastWrite =
    (live?.changes ?? []).at(-1) ??
    steps.flatMap((step) => (step.kind === 'file-change' ? [step] : [])).at(-1)
  const current = runningCommand
    ? displayCommand(runningCommand.command)
    : lastWrite
      ? `Wrote ${lastWrite.path}`
      : 'Working…'
  return (
    <div role="status" className="flex items-center gap-2.5 font-mono text-xs">
      <ThinkingOrb
        state="composing"
        size={20}
        theme="auto"
        aria-label="Run in progress"
        className="shrink-0"
      />
      <span className="min-w-0 flex-1 shimmer truncate">{current}</span>
      {startedAt !== null && (
        <span className="shrink-0 text-2xs text-muted-foreground">
          <RunElapsed startedAt={startedAt} />
        </span>
      )}
    </div>
  )
}

/** The ticking value is local, so a clock edge cannot rerender the transcript. */
function RunElapsed({ startedAt }: { startedAt: string }): React.JSX.Element {
  const [elapsed, setElapsed] = useState(() => Date.now() - Date.parse(startedAt))
  useEffect(() => {
    const timer = window.setInterval(() => setElapsed(Date.now() - Date.parse(startedAt)), 1_000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  return <>{formatDuration(elapsed)}</>
}

type FileChangeEntry = Extract<ConversationEntry, { kind: 'file-change' }>

interface ChangedFileGroup {
  path: string
  changes: FileChangeEntry[]
  added: number
  removed: number
  shortened: boolean
  changeKind: FileChangeEntry['changeKind']
}

/** One row per edited file, while retaining each recorded write for its preview. */
function groupChangedFiles(changes: FileChangeEntry[]): ChangedFileGroup[] {
  const grouped = new Map<string, ChangedFileGroup>()
  for (const change of changes) {
    const known = grouped.get(change.path)
    grouped.set(change.path, {
      path: change.path,
      changes: [...(known?.changes ?? []), change],
      added: (known?.added ?? 0) + change.added,
      removed: (known?.removed ?? 0) + change.removed,
      shortened: (known?.shortened ?? false) || change.shortened,
      changeKind: change.changeKind
    })
  }
  return [...grouped.values()]
}

function fileName(path: string): string {
  return path.split('/').at(-1) ?? path
}

const CHANGE_LABEL: Record<FileChangeEntry['changeKind'], string> = {
  added: 'Added',
  changed: 'Edited',
  deleted: 'Deleted'
}

/**
 * The compact successful outcome: changed files only. Hover previews the
 * recorded diff; click still opens the complete Files panel for review.
 */
function ChangedFilesSummary({
  changes,
  onOpenFile
}: {
  changes: FileChangeEntry[]
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  const files = groupChangedFiles(changes)

  return (
    <section
      aria-label={`${String(files.length)} edited file${files.length === 1 ? '' : 's'}`}
      className="overflow-hidden rounded-lg border border-border bg-muted/30"
    >
      <ul className="divide-y divide-border">
        {files.map((file) => (
          <li key={file.path} className="flex items-center gap-2 p-2.5">
            <HoverCard>
              <HoverCardTrigger
                delay={200}
                closeDelay={150}
                render={
                  <button
                    type="button"
                    onClick={() => onOpenFile(file.path)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground">
                  <FileDiff aria-hidden="true" className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium" title={file.path}>
                    {CHANGE_LABEL[file.changeKind]} {fileName(file.path)}
                  </span>
                  <span className="block font-mono text-2xs tabular-nums">
                    <DiffCounts added={file.added} removed={file.removed} />
                  </span>
                </span>
              </HoverCardTrigger>
              <HoverCardContent side="top" align="start" className="w-screen max-w-xl">
                <div className="flex items-baseline gap-2 px-0.5">
                  <p className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
                    {file.path}
                  </p>
                  <span className="shrink-0 font-mono text-2xs tabular-nums">
                    <DiffCounts added={file.added} removed={file.removed} />
                  </span>
                </div>
                <div className="max-h-72 overflow-auto">
                  {file.changes.map((change, index) => (
                    <div key={change.id}>
                      {file.changes.length > 1 && (
                        <p className="mt-2 px-0.5 font-mono text-2xs text-muted-foreground">
                          Write {String(index + 1)} of {String(file.changes.length)}
                        </p>
                      )}
                      <DiffView hunks={change.hunks} />
                    </div>
                  ))}
                  {file.shortened && (
                    <p className="mt-1 px-0.5 text-xs text-muted-foreground">
                      Preview shortened. Review the file to see the complete change.
                    </p>
                  )}
                </div>
              </HoverCardContent>
            </HoverCard>
            <Button size="sm" variant="secondary" onClick={() => onOpenFile(file.path)}>
              Review
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * A successful Run leaves only its edited files. Failed and stopped Runs keep
 * the fuller outcome and activity record needed to understand the interruption.
 */
function RunOutcome({
  group,
  run,
  startedAt,
  steps,
  onOpenFile,
  onContinue
}: {
  group: RunGroup
  run: RunSnapshot | null
  startedAt: string | null
  steps: StepEntry[]
  onOpenFile: (path: string) => void
  onContinue: () => void
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)

  const changes = steps.flatMap((step) => (step.kind === 'file-change' ? [step] : []))
  /** What this list still holds, now that commands have their own rows. */
  const fileSteps = steps.filter((step) => step.kind !== 'command')
  const reads = steps.filter((step) => step.kind === 'read').length
  const edited = new Set(changes.map((step) => step.path))
  const commandCount = steps.filter((step) => step.kind === 'command').length
  const totals = changes.reduce(
    (sum, change) => ({
      added: sum.added + change.added,
      removed: sum.removed + change.removed
    }),
    { added: 0, removed: 0 }
  )
  const summary =
    [
      reads > 0 && `Read ${String(reads)} file${reads === 1 ? '' : 's'}`,
      edited.size > 0 && `Edited ${String(edited.size)} file${edited.size === 1 ? '' : 's'}`,
      commandCount > 0 && `Ran ${String(commandCount)} command${commandCount === 1 ? '' : 's'}`
    ]
      .filter(Boolean)
      .join(' · ') || 'Worked'
  const failed =
    group.ended?.boundary === 'run-failed' || (run !== null && FAILED_STATUSES.has(run.status))
  const stopped = group.ended?.boundary === 'run-stopped' || run?.status === 'stopped'
  if (!failed && !stopped) {
    return changes.length > 0 ? (
      <ChangedFilesSummary changes={changes} onOpenFile={onOpenFile} />
    ) : null
  }

  const outcome = failed ? 'attention' : 'stopped'
  const duration =
    startedAt !== null && group.ended
      ? formatDuration(Date.parse(group.ended.at) - Date.parse(startedAt))
      : null
  const firstChangedPath = changes[0]?.path ?? null
  const outcomeLabel = outcome === 'attention' ? 'Run needs attention' : 'Run stopped'
  const outcomeDetail =
    outcome === 'attention'
      ? 'The Run ended before it could deliver a complete result.'
      : 'Everything completed before the stop is kept.'

  return (
    <section aria-label="Run outcome" className="py-3">
      <div className="flex items-start gap-3 px-3">
        <span
          className={cn(
            'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-surface',
            outcome === 'attention' && 'text-destructive',
            outcome === 'stopped' && 'text-muted-foreground'
          )}
        >
          {outcome === 'attention' ? (
            <TriangleAlert aria-hidden="true" className="size-3.5" />
          ) : (
            <Square aria-hidden="true" className="size-3" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3 className="font-medium">{outcomeLabel}</h3>
            {duration !== null && (
              <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                {duration}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{outcomeDetail}</p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {firstChangedPath !== null && (
            <Button size="sm" variant="secondary" onClick={() => onOpenFile(firstChangedPath)}>
              Review files
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onContinue}>
            Continue
          </Button>
        </div>
      </div>

      <div className="mt-2 pt-1" aria-label="Run activity">
        {steps.length > 0 ? (
          <>
            {/* Commands are not listed here: they have their own openable rows
                above, where what they printed is also readable. This stays the
                file record — what was read, and what was written — so a Run
                that only ran commands has a summary and nothing to open. */}
            <button
              type="button"
              aria-expanded={fileSteps.length > 0 ? expanded : undefined}
              disabled={fileSteps.length === 0}
              onClick={() => setExpanded(!expanded)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/40 disabled:hover:bg-transparent"
            >
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  'size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
                  fileSteps.length === 0 && 'invisible',
                  expanded && 'rotate-90'
                )}
              />
              <span className="min-w-0 flex-1 truncate">{summary}</span>
              {(totals.added > 0 || totals.removed > 0) && (
                <span className="shrink-0 font-mono text-2xs tabular-nums">
                  <DiffCounts added={totals.added} removed={totals.removed} />
                </span>
              )}
            </button>
            {expanded && fileSteps.length > 0 && (
              <ol className="border-t border-border py-1" aria-label="Files this Run touched">
                {fileSteps.map((step) => (
                  <StepRow key={step.id} step={step} onOpenFile={onOpenFile} />
                ))}
              </ol>
            )}
          </>
        ) : (
          <p className="px-3 py-1.5 text-xs text-muted-foreground">
            No command or file activity was recorded.
          </p>
        )}
      </div>
    </section>
  )
}

/**
 * The Run's tool calls: every command it ran, one openable line each.
 *
 * Commands are the only step that answers with something — a read and an edit
 * are already whole in their own line, and the Files panel is the one diff
 * surface — so they are the only step this surface takes. What a command
 * printed was durable all along and had nowhere to be read; here it is, one
 * click from the line that ran it, and closed until then.
 */
function ToolCalls({ steps }: { steps: StepEntry[] }): React.JSX.Element | null {
  const commands = steps.flatMap((step) => (step.kind === 'command' ? [step] : []))
  if (commands.length === 0) return null

  return (
    <section aria-label="Tool calls" className="flex flex-col">
      {commands.map((step) => (
        <ToolResult
          key={step.id}
          title={displayCommand(step.command)}
          status={commandStatus(step)}
          meta={commandMeta(step)}
          copyText={step.output}
        >
          {step.output.trim() === '' ? (
            <p className="text-2xs text-muted-foreground">It printed nothing.</p>
          ) : (
            <ToolResultOutput>{step.output}</ToolResultOutput>
          )}
        </ToolResult>
      ))}
    </section>
  )
}

type CommandEntry = Extract<ConversationEntry, { kind: 'command' }>

/** How a command went, in the four states the row can draw. */
function commandStatus(step: CommandEntry): ToolResultStatus {
  if (step.running) return 'running'
  if (step.interrupted) return 'cancelled'
  return step.failed ? 'error' : 'success'
}

/**
 * What it cost, and what it answered when that is worth saying. A duration of
 * zero is not a measurement — it is a Harness that reported nothing — so it is
 * left off rather than printed as a time the command did not take.
 */
function commandMeta(step: CommandEntry): string | undefined {
  const parts = [
    step.exitCode !== null && step.exitCode !== 0 ? `exit ${String(step.exitCode)}` : null,
    step.durationMs !== null && step.durationMs > 0 ? formatDuration(step.durationMs) : null
  ].filter((part) => part !== null)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/**
 * One step as a row draws it: the fields the row needs and nothing else, so a
 * durable journal entry and a step still streaming render through the same
 * component instead of two parallel renderings of "a step".
 */
type StepView =
  | { kind: 'read'; id: string; path: string }
  | {
      kind: 'command'
      id: string
      command: string
      running: boolean
      failed: boolean
      interrupted: boolean
      exitCode: number | null
      durationMs: number | null
    }
  | { kind: 'file-change'; id: string; path: string; added: number; removed: number }

/** One chronological step of a Run: a read, an edit, or a command. */
function StepRow({
  step,
  onOpenFile
}: {
  step: StepView
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  if (step.kind === 'read') {
    return (
      <li className="flex items-center gap-2 px-3 py-1 font-mono text-xs text-muted-foreground">
        <FileText aria-hidden="true" className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate select-text">Read {step.path}</span>
      </li>
    )
  }
  if (step.kind === 'command') {
    return (
      <li className="flex items-center gap-2 px-3 py-1 font-mono text-xs text-muted-foreground">
        {step.running ? <Spinner /> : <Terminal aria-hidden="true" className="size-3 shrink-0" />}
        <span className="min-w-0 flex-1 truncate select-text">{displayCommand(step.command)}</span>
        {step.interrupted ? (
          <span className="shrink-0">interrupted</span>
        ) : !step.running && step.exitCode !== null ? (
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
      case 'queued-submission':
      case 'queue-state':
      case 'queue-outcome':
        break
    }
  }
  return items
}

/**
 * The transcript folded once more, into the turns the Turn Rail draws: a user
 * message, and everything that answered it before the next one. A turn is the
 * unit someone remembers a Conversation in — "when I asked it to fix the
 * tests" — which is why the rail counts turns and not entries.
 *
 * Anything before the first user message belongs to no turn and is skipped:
 * the rail is a way back to something the person said, and there is nothing
 * there to go back to.
 */
function summarizeTurns(items: ConversationItem[]): TurnSummary[] {
  const turns: TurnSummary[] = []
  for (const item of items) {
    if (item.type === 'user') {
      turns.push({
        id: item.entry.id,
        ordinal: turns.length + 1,
        prompt: previewText(item.entry.text),
        reply: '',
        steps: [],
        stepCount: 0,
        approvals: 0,
        status: null
      })
      continue
    }
    const turn = turns.at(-1)
    if (turn === undefined || item.type === 'note') continue
    if (item.type === 'assistant') {
      if (turn.reply === '') turn.reply = previewText(item.entry.text)
      continue
    }
    if (turn.reply === '') turn.reply = previewText(item.messages.map((m) => m.text).join('\n'))
    turn.stepCount += item.steps.length
    turn.approvals += item.approvals.length
    turn.steps = turn.steps.concat(item.steps.map(stepLine)).slice(0, TURN_STEP_LIMIT)
    turn.status = worseStatus(turn.status, runStatus(item))
  }
  return turns
}

/** Enough steps to fill the card, and no more work spent on the ones past it. */
const TURN_STEP_LIMIT = 4

/** One step as a single line of the card. */
function stepLine(step: StepEntry): TurnStep {
  if (step.kind === 'read')
    return { id: step.id, kind: 'read', text: `Read ${fileName(step.path)}` }
  if (step.kind === 'command')
    return { id: step.id, kind: 'command', text: displayCommand(step.command) }
  return {
    id: step.id,
    kind: 'file-change',
    text: `${CHANGE_LABEL[step.changeKind]} ${fileName(step.path)}`
  }
}

/** How a Run ended, in the four words the rail has for it. */
function runStatus(group: RunGroup): NonNullable<TurnSummary['status']> {
  if (group.ended === null) return 'running'
  if (group.ended.boundary === 'run-failed') return 'failed'
  if (group.ended.boundary === 'run-stopped') return 'stopped'
  return 'done'
}

/**
 * A turn can hold more than one Run, and the tick can only say one thing. It
 * says the thing that still wants an answer: what is happening now, then what
 * went wrong, then what was called off, and only then that it is finished.
 */
const STATUS_URGENCY: Record<NonNullable<TurnSummary['status']>, number> = {
  running: 3,
  failed: 2,
  stopped: 1,
  done: 0
}

function worseStatus(
  left: TurnSummary['status'],
  right: NonNullable<TurnSummary['status']>
): NonNullable<TurnSummary['status']> {
  if (left === null) return right
  return STATUS_URGENCY[right] > STATUS_URGENCY[left] ? right : left
}

/**
 * Prose reduced to something that survives being clamped to two lines: the
 * markdown punctuation dropped, every run of whitespace closed up, and a
 * generous cut so nothing downstream has to carry a whole reply around.
 */
function previewText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*`>_[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280)
}

/** The Run's Permission Mode, in the product's own words. */
const MODE_LABEL: Record<PermissionMode, string> = { ask: 'Ask', auto: 'Full access' }

/**
 * `34ms`, `8.2s`, `22s`, `3m 05s` — the precision worth reading at each scale.
 *
 * Below a second it is stated in milliseconds. A `git log` takes tens of
 * milliseconds, and rounding that to `0.0s` reports a command that took no
 * time at all, which is both wrong and the one reading a duration must never
 * give.
 */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1_000
  if (seconds < 1) return `${String(Math.max(0, Math.round(ms)))}ms`
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${String(Math.round(seconds))}s`
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes)}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`
}

function formatClock(at: string): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function UserBubble({
  entry,
  pending = false
}: {
  entry: MessageEntry
  pending?: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-end gap-1">
      <p className="max-w-lg rounded-lg bg-accent px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap select-text">
        {entry.text}
      </p>
      {pending && (
        <span
          role="status"
          aria-label="Sending message"
          className="flex items-center gap-1 font-mono text-2xs text-muted-foreground"
        >
          <LoaderCircle aria-hidden="true" className="size-2.5 animate-spin" />
          Sending…
        </span>
      )}
    </div>
  )
}

/**
 * How assistant markdown wears this app's clothes. Headings stay modest —
 * chat prose is a document inside a document — code spans are the same mono
 * chips the rest of the product uses for paths and symbols, and fenced code
 * gets the bordered mono block every other captured text gets. Links render
 * as text with the URL on hover: the app opens no arbitrary external link by
 * design, and a link that looks clickable but is refused would be a lie.
 */
const MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => <p className="mt-2 first:mt-0">{children}</p>,
  h1: ({ children }) => <p className="mt-3 text-base font-medium first:mt-0">{children}</p>,
  h2: ({ children }) => <p className="mt-3 text-base font-medium first:mt-0">{children}</p>,
  h3: ({ children }) => <p className="mt-3 text-sm font-medium first:mt-0">{children}</p>,
  h4: ({ children }) => <p className="mt-3 text-sm font-medium first:mt-0">{children}</p>,
  h5: ({ children }) => <p className="mt-3 text-sm font-medium first:mt-0">{children}</p>,
  h6: ({ children }) => <p className="mt-3 text-sm font-medium first:mt-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 first:mt-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 first:mt-0">{children}</ol>
  ),
  code: ({ children }) => (
    <code className="rounded-sm bg-accent px-1 font-mono text-xs">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-surface p-2 font-mono text-xs whitespace-pre first:mt-0 [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  a: ({ children, href }) => (
    <span title={typeof href === 'string' ? href : undefined} className="underline">
      {children}
    </span>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mt-2 border-l border-border pl-3 text-muted-foreground first:mt-0">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="mt-2 overflow-x-auto first:mt-0">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border px-2 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-border px-2 py-1">{children}</td>,
  hr: () => <hr className="mt-3 border-border" />
}

const MARKDOWN_PLUGINS = [remarkGfm]

/**
 * Assistant prose, flat like a document: no avatar, no header. The agent
 * writes markdown, so markdown is what renders — as React elements, never
 * injected HTML, and raw HTML in the message stays inert text.
 */
const AgentText = memo(function AgentText({
  text,
  partial
}: {
  id: string
  text: string
  partial: boolean
}): React.JSX.Element {
  // The packaged-shell performance fixture installs this optional browser
  // probe. Ordinary application windows never define it.
  ;(
    window as typeof window & {
      __argosTestConversationRenderProbe?: (text: string) => void
    }
  ).__argosTestConversationRenderProbe?.(text)
  return (
    <div className="max-w-lg">
      <div className="text-sm leading-relaxed select-text">
        <Markdown remarkPlugins={MARKDOWN_PLUGINS} components={MARKDOWN_COMPONENTS}>
          {text}
        </Markdown>
      </div>
      {partial && (
        <p className="mt-1 text-xs text-muted-foreground">
          Partial — the Run ended before this message finished.
        </p>
      )}
    </div>
  )
})

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
  live,
  onOpenFile,
  onContinue
}: {
  group: RunGroup
  run: RunSnapshot | null
  active: boolean
  waiting: boolean
  live: LiveRun | null
  onOpenFile: (path: string) => void
  onContinue: () => void
}): React.JSX.Element {
  const startedAt = group.started?.at ?? run?.acceptedAt ?? null
  const resolved = group.approvals.filter((entry) => entry.decision !== null)
  const durableMessageIds = new Set(group.messages.map((message) => message.id))
  const liveMessages = new Map(
    (live?.messages ?? []).map((message) => [assistantMessageId(group.runId, message.id), message])
  )
  // A streamed message and its checkpoint share Core's durable assistant id.
  // Keep one row at that identity: live text wins while the Run is active,
  // then the same keyed row naturally hands off to the durable projection.
  const messages = [
    ...group.messages.map((message) => {
      const streaming = liveMessages.get(message.id)
      return {
        id: message.id,
        text: streaming?.text ?? message.text,
        partial: streaming === undefined && message.completeness === 'partial'
      }
    }),
    ...(live?.messages ?? [])
      .map((message) => ({
        id: assistantMessageId(group.runId, message.id),
        text: message.text,
        partial: false
      }))
      .filter((message) => !durableMessageIds.has(message.id))
  ]
  return (
    <div className="flex flex-col gap-4">
      <RunDivider view={{ group, run, active, waiting, startedAt }} />
      {messages
        .filter((message) => message.text)
        .map((message) => (
          <AgentText
            key={message.id}
            id={message.id}
            text={message.text}
            partial={message.partial}
          />
        ))}
      {/* What the Run ran, in the order it ran it, and what each one printed
          for anyone who asks. It sits under the prose that announced it and
          above the line saying what is happening now. */}
      <ToolCalls steps={group.steps} />
      {/* In flight: one pulsing line about the current step. At rest: only
          changed files or an interrupted Run need an outcome surface. */}
      {active && !waiting && (
        <RunWorkingIndicator steps={group.steps} live={live} startedAt={startedAt} />
      )}
      {resolved.map((entry) => (
        <ApprovalRow key={entry.id} entry={entry} />
      ))}
      {/* The sanitized activity log surfaces only when a Run ended badly —
          that is exactly when the detail matters, and it belongs to the Run
          that produced it rather than to the bottom of the screen. */}
      {run && FAILED_STATUSES.has(run.status) && <ActivityPanel run={run} defaultOpen />}
      {!active && (
        <RunOutcome
          group={group}
          run={run}
          startedAt={startedAt}
          steps={group.steps}
          onOpenFile={onOpenFile}
          onContinue={onContinue}
        />
      )}
    </div>
  )
}

/**
 * One Run as its divider presents it: the durable group, the Run record when
 * there is one, and the moments the outcome is phrased from. One value rather
 * than a clump of loose props, because the pieces only mean anything
 * together.
 */
interface RunDividerView {
  group: RunGroup
  run: RunSnapshot | null
  active: boolean
  waiting: boolean
  startedAt: string | null
}

/**
 * The Run boundary as a rule of the page: `Run · model · mode`, a hairline,
 * and on the right what became of it — running, waited on, or how long it
 * worked. Mono and muted, so history reads as history.
 */
function RunDivider({ view }: { view: RunDividerView }): React.JSX.Element {
  const { group, run, active, waiting, startedAt } = view
  const model = run?.configuration.model ?? group.started?.model ?? null
  const mode = run ? MODE_LABEL[run.configuration.permissionMode] : null
  const label = ['Run', model, mode].filter(Boolean).join(' · ')
  let outcome: React.ReactNode = null
  if (active && !waiting) {
    outcome = (
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-status-running" />
        Running{startedAt !== null && ' · '}
        {startedAt !== null && <RunElapsed startedAt={startedAt} />}
      </span>
    )
  } else if (active && waiting) {
    outcome = startedAt !== null ? formatClock(startedAt) : null
  }
  return (
    <div
      aria-label={label}
      className="flex min-w-0 items-center gap-2.5 font-mono text-2xs text-muted-foreground"
    >
      <span className="min-w-0 truncate">{label}</span>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
      {outcome !== null && <span className="shrink-0">{outcome}</span>}
    </div>
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
        {HARNESS_LABEL[run.configuration.harness]} ·{' '}
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
