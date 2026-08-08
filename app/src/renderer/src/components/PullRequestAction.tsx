import { useState } from 'react'
import { ExternalLink, GitPullRequest, LoaderCircle } from 'lucide-react'
import type { PreparePullRequestResult, PullRequest, SessionSummary } from '@shared/contract'
import { Button } from '@renderer/components/ui/button'
import { Modal } from '@renderer/components/ui/dialog'
import { cn } from '@renderer/lib/utils'

const CHIP_CLASS =
  'flex h-6 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground'

type DialogState =
  | { kind: 'closed' }
  | { kind: 'preparing' }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'editing'; draft: Extract<PreparePullRequestResult, { status: 'ready' }> }
  | {
      kind: 'publishing'
      draft: Extract<PreparePullRequestResult, { status: 'ready' }>
    }

export function PullRequestAction({
  session,
  onPublished,
  onAnnounce
}: {
  session: SessionSummary & { pullRequest?: PullRequest | null }
  onPublished: () => void
  onAnnounce: (message: string) => void
}): React.JSX.Element {
  const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' })
  const [pullRequest, setPullRequest] = useState<PullRequest | null>(session.pullRequest ?? null)

  async function prepare(): Promise<void> {
    setDialog({ kind: 'preparing' })
    try {
      const result = await window.shell.preparePullRequest({ sessionId: session.id })
      if (result.status === 'ready') setDialog({ kind: 'editing', draft: result })
      else {
        setDialog({
          kind: 'unavailable',
          detail: result.detail ?? unavailableMessage(result.reason)
        })
      }
    } catch {
      setDialog({ kind: 'unavailable', detail: 'The Pull Request could not be prepared.' })
    }
  }

  async function publish(
    draft: Extract<PreparePullRequestResult, { status: 'ready' }>
  ): Promise<void> {
    setDialog({ kind: 'publishing', draft })
    try {
      const result = await window.shell.createPullRequest({
        sessionId: session.id,
        baseBranch: draft.baseBranch,
        title: draft.title,
        body: draft.body,
        publishMode: draft.publishMode,
        expectedTree: draft.expectedTree
      })
      if (result.status === 'failed') {
        setDialog({ kind: 'unavailable', detail: result.detail })
        return
      }
      setPullRequest(result.pullRequest)
      setDialog({ kind: 'closed' })
      onPublished()
      onAnnounce(
        result.status === 'created'
          ? `Created PR #${String(result.pullRequest.number)}.`
          : `Opened existing PR #${String(result.pullRequest.number)}.`
      )
    } catch {
      setDialog({ kind: 'unavailable', detail: 'The Pull Request could not be created.' })
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={dialog.kind === 'preparing' || dialog.kind === 'publishing'}
        title={pullRequest ? `Open PR #${String(pullRequest.number)}` : 'Create a Pull Request'}
        aria-label={
          pullRequest ? `Open PR #${String(pullRequest.number)}` : 'Create a Pull Request'
        }
        onClick={() =>
          pullRequest
            ? void window.shell.openPullRequest(session.id)
            : dialog.kind === 'closed' && void prepare()
        }
        className={cn(
          CHIP_CLASS,
          'font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40'
        )}
      >
        {dialog.kind === 'preparing' || dialog.kind === 'publishing' ? (
          <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
        ) : pullRequest ? (
          <ExternalLink aria-hidden="true" className="size-3" />
        ) : (
          <GitPullRequest aria-hidden="true" className="size-3" />
        )}
        {pullRequest ? `PR #${String(pullRequest.number)}` : 'Create PR'}
      </button>

      {dialog.kind !== 'closed' && dialog.kind !== 'preparing' && (
        <Modal
          labelledBy="pull-request-title"
          onDismiss={() => {
            if (dialog.kind !== 'publishing') setDialog({ kind: 'closed' })
          }}
        >
          {dialog.kind === 'unavailable' ? (
            <>
              <h2 id="pull-request-title" className="text-sm font-semibold">
                Pull Request unavailable
              </h2>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{dialog.detail}</p>
              <div className="mt-4 flex justify-end">
                <Button size="sm" onClick={() => setDialog({ kind: 'closed' })}>
                  Close
                </Button>
              </div>
            </>
          ) : (
            <PullRequestDraft
              draft={dialog.draft}
              publishing={dialog.kind === 'publishing'}
              onChange={(draft) => setDialog({ kind: 'editing', draft })}
              onCancel={() => setDialog({ kind: 'closed' })}
              onPublish={(draft) => void publish(draft)}
            />
          )}
        </Modal>
      )}
    </>
  )
}

function PullRequestDraft({
  draft,
  publishing,
  onChange,
  onCancel,
  onPublish
}: {
  draft: Extract<PreparePullRequestResult, { status: 'ready' }>
  publishing: boolean
  onChange: (draft: Extract<PreparePullRequestResult, { status: 'ready' }>) => void
  onCancel: () => void
  onPublish: (draft: Extract<PreparePullRequestResult, { status: 'ready' }>) => void
}): React.JSX.Element {
  return (
    <>
      <h2 id="pull-request-title" className="text-sm font-semibold">
        Create Pull Request
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Review the prose first. Publishing commits this{' '}
        {draft.publishMode === 'local' ? 'Local Checkout' : 'Worktree'}, pushes {draft.headBranch},
        and opens a PR into {draft.baseBranch}.
      </p>
      {draft.publishMode === 'local' && (
        <p className="mt-3 rounded-md border border-border bg-muted/40 p-2 text-xs leading-relaxed text-muted-foreground">
          Local Checkout safety: Argos will commit only the exact tree reviewed here. Existing
          staged work, a dirty Session baseline, or edits made after this dialog opened are refused.
        </p>
      )}
      <label className="mt-4 block text-xs font-medium">
        Title
        <input
          data-autofocus=""
          value={draft.title}
          maxLength={200}
          disabled={publishing}
          onChange={(event) => onChange({ ...draft, title: event.target.value })}
          className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 font-normal outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <label className="mt-3 block text-xs font-medium">
        Base branch
        <input
          value={draft.baseBranch}
          maxLength={500}
          disabled={publishing}
          onChange={(event) => onChange({ ...draft, baseBranch: event.target.value })}
          className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-xs font-normal outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <label className="mt-3 block text-xs font-medium">
        Description
        <textarea
          value={draft.body}
          maxLength={100_000}
          rows={12}
          disabled={publishing}
          onChange={(event) => onChange({ ...draft, body: event.target.value })}
          className="mt-1 w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-xs font-normal outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" size="sm" disabled={publishing} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={
            publishing ||
            draft.baseBranch.trim() === '' ||
            draft.title.trim() === '' ||
            draft.body.trim() === ''
          }
          onClick={() => onPublish(draft)}
        >
          {publishing ? 'Publishing…' : 'Commit, push & create PR'}
        </Button>
      </div>
    </>
  )
}

function unavailableMessage(reason: string): string {
  if (reason === 'local-checkout') return 'Use an isolated Worktree Session to publish a PR.'
  if (reason === 'local-unsafe') return 'The Local Checkout could not be verified safely.'
  if (reason === 'detached-head') return 'Check out a branch before publishing.'
  if (reason === 'checkout-busy') return 'Finish the current Git operation before publishing.'
  if (reason === 'gh-unavailable') return 'Install the GitHub CLI, then try again.'
  if (reason === 'gh-unauthenticated') return 'Run gh auth login in your terminal, then try again.'
  return 'GitHub is unavailable right now.'
}
