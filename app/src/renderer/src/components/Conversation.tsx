import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, ChevronRight, Send, Square, User } from 'lucide-react'
import {
  PROVIDER_DEFAULT_MODEL,
  WORKFLOW_ATTRIBUTION,
  type ConversationEntry,
  type ConversationRecovery,
  type ConversationSnapshot,
  type HarnessUsage,
  type IdeaSummary,
  type PermissionMode,
  type PlanningWorkflow,
  type ProviderId,
  type ReadinessSnapshot,
  type RunSnapshot,
  type SuggestedResponse
} from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

/**
 * The Idea's permanent Conversation: the primary surface for developing it.
 * Streamed assistant text arrives on the push channel and is reconciled
 * against the durable snapshot, so what is on screen never outlives what was
 * saved. Suggested Responses submit directly; typed answers wait for Send.
 */

type Phase =
  { state: 'loading' } | { state: 'failed' } | { state: 'ready'; snapshot: ConversationSnapshot }

/** Assistant text for the Run in flight, ahead of the durable projection. */
interface LiveRun {
  runId: string
  /** One entry per provider message, in the order the provider opened them. */
  messages: { id: string; text: string }[]
  suggestedResponses: SuggestedResponse[]
}

/** The one planning workflow this surface starts today. */
const WORKFLOW: PlanningWorkflow = 'grilling'

const EFFORT_OPTIONS = ['low', 'medium', 'high']

const RECOVERY_GUIDANCE: Record<ConversationRecovery['category'], string> = {
  authentication:
    'The provider is no longer signed in. Sign in with its own CLI, then send your message again.',
  'rate-limit':
    'The provider is rate limiting this account. Nothing was lost — send your message again in a moment.',
  'context-exhausted':
    'The Run ran out of provider context. Start a shorter message rather than resending this one.',
  'process-crash': 'The provider process ended unexpectedly. Your message is safe to send again.',
  stopped: 'You stopped this Run. Everything up to that point is kept.',
  'uncertain-submission':
    'The Run ended before the provider answered, so its outcome is unknown. Your message is kept and safe to send again.',
  'protocol-unsupported':
    'The provider reported its work in a format this app does not understand, so nothing usable came back. Updating the provider — or this app — is what fixes it.',
  'policy-violation':
    'The Run was stopped because it attempted something outside planning authority. Review the activity below.',
  'supervision-failed':
    'Provider cleanup could not be verified. Quit the app and check Activity Monitor before starting another Run.'
}

export function Conversation({ idea }: { idea: IdeaSummary }): React.JSX.Element {
  const relativePath = idea.relativePath
  const [phase, setPhase] = useState<Phase>({ state: 'loading' })
  const [runs, setRuns] = useState<RunSnapshot[]>([])
  const [readiness, setReadiness] = useState<ReadinessSnapshot | null>(null)
  const [live, setLive] = useState<LiveRun | null>(null)
  const [draft, setDraft] = useState('')
  const [provider, setProvider] = useState<ProviderId>('codex')
  const [model, setModel] = useState(PROVIDER_DEFAULT_MODEL)
  const [effort, setEffort] = useState('medium')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const snapshot = phase.state === 'ready' ? phase.snapshot : null
  const activeRunId = snapshot?.activeRunId ?? null

  const refresh = useCallback(async () => {
    try {
      const next = await window.ideaShell.getConversation(relativePath)
      setPhase({ state: 'ready', snapshot: next })
      if (next.activeRunId === null) setLive(null)
    } catch {
      setPhase((current) => (current.state === 'ready' ? current : { state: 'failed' }))
    }
    await window.ideaShell.listRuns(relativePath).then(setRuns, () => undefined)
  }, [relativePath])

  useEffect(() => {
    void refresh()
    void window.ideaShell.getReadiness().then(setReadiness, () => undefined)
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
      window.ideaShell.onConversationEvent((streamed) => {
        if (streamed.relativePath !== relativePath) return
        const event = streamed.event
        if (event.type === 'failed') {
          setError(event.summary)
          return
        }
        setLive((current) => {
          const base: LiveRun =
            current?.runId === streamed.runId
              ? current
              : { runId: streamed.runId, messages: [], suggestedResponses: [] }
          if (event.type === 'choices') return { ...base, suggestedResponses: event.options }
          if (event.type !== 'assistant-message') return base
          // Each event carries the whole message so far, so a later one for
          // the same provider item replaces the earlier one.
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
    [relativePath]
  )

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [snapshot?.entries.length, live?.messages])

  const send = useCallback(
    async (text: string, source: 'composer' | 'suggested-response', submissionId?: string) => {
      setBusy(true)
      setError(null)
      try {
        const next = await window.ideaShell.developIdea({
          relativePath,
          submissionId: submissionId ?? crypto.randomUUID(),
          text,
          source,
          workflow: WORKFLOW,
          provider,
          model,
          effort,
          permissionMode
        })
        setPhase({ state: 'ready', snapshot: next })
        if (source === 'composer' && !submissionId) setDraft('')
        await window.ideaShell.listRuns(relativePath).then(setRuns, () => undefined)
      } catch {
        setError(
          'The Run could not start. Check that the provider is ready and that supervision has recovered.'
        )
        // The message was accepted durably before the Run was attempted, so
        // re-read the Conversation rather than leaving it looking lost.
        await refresh()
      } finally {
        setBusy(false)
      }
    },
    [relativePath, provider, model, effort, permissionMode, refresh]
  )

  if (phase.state === 'loading') {
    return (
      <section className="mt-4 rounded-md border border-border bg-surface p-3" aria-busy="true">
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          Reading this Idea’s Conversation…
        </p>
      </section>
    )
  }

  if (phase.state === 'failed') {
    return (
      <section className="mt-4 rounded-md border border-border bg-surface p-3">
        <p role="alert" className="text-xs text-destructive">
          This Idea’s Conversation could not be read. Its Markdown on disk is untouched.
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
  const activeRun = runs.find((run) => run.id === activeRunId) ?? runs[0]
  const providers = readiness?.providers ?? []
  const selected = providers.find((entry) => entry.provider === provider)
  const canDevelop = selected?.capabilities.developIdea
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
            One permanent history for this Idea. Everything here is plain Markdown on disk.
          </p>
        </div>
        {activeRunId && (
          <Button
            className="ml-auto"
            size="sm"
            variant="secondary"
            onClick={() =>
              void window.ideaShell.stopRun({ runId: activeRunId, relativePath }).then(
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
            Nothing has been developed yet. Choose a workflow below and send your first message.
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
        {activeRunId && !liveForActiveRun?.messages.some((message) => message.text) && (
          <li className="text-xs text-muted-foreground">Waiting for the provider to answer…</li>
        )}
        <div ref={endRef} />
      </ol>

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
          <Field label="Workflow">
            <span className="text-foreground">Grill Me</span>
          </Field>
          <Field label="Provider">
            <select
              aria-label="Provider"
              value={provider}
              onChange={(event) => setProvider(event.target.value as ProviderId)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            >
              {providers.length === 0 && <option value="codex">Codex</option>}
              {providers.map((entry) => (
                <option key={entry.provider} value={entry.provider}>
                  {entry.displayName}
                  {entry.capabilities.developIdea.available ? '' : ' — unavailable'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model">
            <input
              aria-label="Model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={PROVIDER_DEFAULT_MODEL}
              title={`Leave as “${PROVIDER_DEFAULT_MODEL}” to use the provider’s configured model.`}
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
              aria-label="Permission prompts"
              value={permissionMode}
              onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}
              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            >
              <option value="ask">Ask</option>
              <option value="auto">Auto inside the planning sandbox</option>
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
              This app never installs or updates a provider for you.
            </p>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          Auto stays inside the same fixed planning authority as Ask. Git, source edits, secrets,
          sockets, scripts, and package managers are always blocked.
        </p>
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

function EntryRow({ entry }: { entry: ConversationEntry }): React.JSX.Element | null {
  if (entry.kind === 'usage') return null
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
  usage: { run: HarnessUsage | null; idea: HarnessUsage }
}): React.JSX.Element | null {
  if (usage.idea.totalTokens === 0) return null
  const contextWindow = usage.run?.contextWindow ?? usage.idea.contextWindow
  const used = usage.run?.contextUsed ?? null
  return (
    <section className="border-t border-border px-3 py-2" aria-label="Provider-reported usage">
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex gap-1">
          <dt>This Run</dt>
          <dd className="text-foreground">
            {(usage.run?.totalTokens ?? 0).toLocaleString()} tokens
          </dd>
        </span>
        <span className="flex gap-1">
          <dt>This Idea</dt>
          <dd className="text-foreground">{usage.idea.totalTokens.toLocaleString()} tokens</dd>
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
        Reported by the provider and informational only. It is not a quota, allowance, or cost.
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
    void window.ideaShell.openExternalLink(url).catch(() => undefined)
  }
  return (
    <footer className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
      {WORKFLOW_ATTRIBUTION.notice}{' '}
      <Button
        size="sm"
        variant="ghost"
        className="h-auto px-1 text-[11px] underline"
        onClick={() => open(WORKFLOW_ATTRIBUTION.website)}
      >
        {WORKFLOW_ATTRIBUTION.author}’s website
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-auto px-1 text-[11px] underline"
        onClick={() => open(WORKFLOW_ATTRIBUTION.repository)}
      >
        skills repository ({WORKFLOW_ATTRIBUTION.licence})
      </Button>
    </footer>
  )
}
