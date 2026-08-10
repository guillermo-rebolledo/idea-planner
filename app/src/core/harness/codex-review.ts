import { z } from 'zod'
import { parseReviewReport, type ReviewEvent, type ReviewLaunch } from '@shared/review'
import { redactCredentials } from '@shared/redaction'
import type { HarnessId } from '@shared/readiness'
import type { ReviewStartParams } from './codex-protocol/v2/ReviewStartParams'
import type { ThreadStartParams } from './codex-protocol/v2/ThreadStartParams'

/**
 * A review Adapter translates one Harness's own review protocol into Findings,
 * so nothing outside it sees a raw Harness frame — the same bargain the Run
 * Adapters make, for a request that is not a Run.
 *
 * Only Codex has one. Claude exposes no structured review, and the app says so
 * rather than pretending: `createReviewAdapter` answers null for a Harness it
 * cannot ask, and the surface states that instead of offering an action that
 * would do nothing.
 */
export interface ReviewAdapter {
  /** Consumes a raw stdout chunk and returns what it learned. */
  ingest(chunk: string): ReviewEvent[]
  /** Reports whatever the end of the stream implies, when it implies anything. */
  flush(): ReviewEvent[]
  /** Frames the Harness is owed. Main writes them, because Main owns processes. */
  takeOutgoing(): string[]
}

/** The JSON-RPC ids this Adapter uses, in the order it sends them. */
const INITIALIZE_ID = 1
const THREAD_ID = 2
const REVIEW_ID = 3

const responseSchema = z.object({
  id: z.number(),
  result: z.record(z.unknown()).optional(),
  error: z.object({ message: z.string().default('') }).optional()
})

const notificationSchema = z.object({
  method: z.string().min(1),
  params: z.record(z.unknown()).default({})
})

const threadSchema = z.object({ id: z.string().min(1).max(200) })
const reviewStartedSchema = z.object({ reviewThreadId: z.string().min(1).max(200) })

/**
 * The message the review answers with. Codex marks the one that is the answer
 * rather than the thinking aloud that precedes it, so the Adapter reads the
 * mark instead of guessing from position.
 */
const messageSchema = z.object({
  type: z.string().default(''),
  text: z.string().default(''),
  phase: z.string().nullable().default(null)
})

/** How much of one report is read. Beyond this it is not a report anybody reads. */
const MAX_REPORT = 200_000

/**
 * `codex app-server`, asked for a review rather than a turn.
 *
 * The exchange is fixed: initialize, start a thread in the Checkout, then
 * `review/start` with `delivery: "detached"`. Codex answers with the id of a
 * thread of its own, runs the review there, and the Session's own thread is
 * never touched — which is exactly what makes a review cost the Session no
 * context. Everything worth reading afterwards arrives under that id.
 *
 * Both threads live in the staged Codex home the app starts the process with,
 * so asking for a review leaves nothing in the person's own Codex history.
 */
export function createCodexReviewAdapter(launch: ReviewLaunch): ReviewAdapter {
  let pending = ''
  const outgoing: string[] = []
  let reviewThreadId: string | null = null
  /** The answer so far. A later final message supersedes an earlier one. */
  let report = ''
  let done = false

  const send = (message: Record<string, unknown>): void => {
    outgoing.push(JSON.stringify({ jsonrpc: '2.0', ...message }))
  }

  send({
    id: INITIALIZE_ID,
    method: 'initialize',
    params: { clientInfo: { name: 'argos', title: 'Argos', version: '0.1.0' } }
  })

  function startThread(): void {
    send({ method: 'initialized', params: {} })
    // A review reads; it does not write. Read-only is the sandbox rather than
    // an instruction, so how the model reads its brief cannot change what it
    // is able to do to the person's Checkout.
    //
    // The seed thread is deliberately not `ephemeral`: 0.147.0 answers
    // `review/start` on an ephemeral thread and then runs no review at all —
    // no review thread is started and no item ever arrives. What keeps this
    // out of the person's own history is the staged `CODEX_HOME` the app
    // starts the process with, which is where the rollout is written instead.
    const params: ThreadStartParams = {
      cwd: launch.cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      threadSource: 'argos'
    }
    send({ id: THREAD_ID, method: 'thread/start', params })
  }

  function startReview(threadId: string): void {
    const params: ReviewStartParams = {
      threadId,
      target: { type: 'uncommittedChanges' },
      delivery: 'detached'
    }
    send({ id: REVIEW_ID, method: 'review/start', params })
  }

  function finish(): ReviewEvent[] {
    if (done) return []
    done = true
    const { findings, assessment } = parseReviewReport(report)
    return [{ type: 'review-completed', findings, assessment }]
  }

  function fail(summary: string): ReviewEvent[] {
    if (done) return []
    done = true
    return [{ type: 'review-failed', summary: summarize(summary) }]
  }

  function consumeResponse(raw: z.infer<typeof responseSchema>): ReviewEvent[] {
    if (raw.error) return fail(raw.error.message)
    if (raw.id === INITIALIZE_ID) {
      startThread()
      return []
    }
    if (raw.id === THREAD_ID) {
      const started = threadSchema.safeParse(raw.result?.['thread'])
      if (!started.success) return fail('Codex started no thread for this review')
      startReview(started.data.id)
      return []
    }
    if (raw.id === REVIEW_ID) {
      const started = reviewStartedSchema.safeParse(raw.result)
      if (!started.success) return fail('Codex started no review thread')
      reviewThreadId = started.data.reviewThreadId
    }
    return []
  }

  function consumeNotification(raw: z.infer<typeof notificationSchema>): ReviewEvent[] {
    const { method, params } = raw
    // `error` is the server speaking about itself and carries no thread, so it
    // is read before anything is filtered by which thread it came from.
    if (method === 'error') {
      return fail(text(object(params['error'])['message']) || text(params['message']))
    }
    // Everything else is only this review's if it happened on the review's own
    // thread. The seed thread's frames are not the review's, and reading them
    // would let a thread that answered nothing end the wait.
    if (reviewThreadId === null || text(params['threadId']) !== reviewThreadId) return []
    if (method === 'item/completed') {
      const item = messageSchema.safeParse(params['item'])
      if (!item.success || item.data.type !== 'agentMessage') return []
      // Codex says which message is the answer; the rest is the reviewer
      // narrating what it is about to do, and a Finding read out of that would
      // point at nothing.
      if (item.data.phase !== 'final_answer') return []
      report = item.data.text.slice(0, MAX_REPORT)
      return []
    }
    if (method === 'turn/completed') return finish()
    if (method === 'turn/failed') {
      return fail(text(object(params['error'])['message']) || 'Codex could not finish this review')
    }
    return []
  }

  function consumeLine(line: string): ReviewEvent[] {
    if (!line.trim()) return []
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      return []
    }
    const notification = notificationSchema.safeParse(record)
    if (notification.success) return consumeNotification(notification.data)
    const response = responseSchema.safeParse(record)
    return response.success ? consumeResponse(response.data) : []
  }

  return {
    ingest(chunk) {
      pending += chunk
      const events: ReviewEvent[] = []
      for (;;) {
        const boundary = pending.indexOf('\n')
        if (boundary < 0) break
        const line = pending.slice(0, boundary)
        pending = pending.slice(boundary + 1)
        events.push(...consumeLine(line))
      }
      return events
    },
    flush() {
      pending = ''
      // The process ended without Codex ever saying the review was over. A
      // report it had already written is still the answer; nothing at all is a
      // review that failed, and the Session is otherwise untouched either way.
      return report ? finish() : fail('Codex ended before it answered this review')
    },
    takeOutgoing() {
      return outgoing.splice(0)
    }
  }
}

/**
 * The review Adapter for one Harness, or null where that Harness has none.
 * Null is an answer the surface states rather than hides: an action offered
 * for a Harness that cannot do it is one the person presses and learns nothing
 * from.
 */
export function createReviewAdapter(
  harness: HarnessId,
  launch: ReviewLaunch
): ReviewAdapter | null {
  return harness === 'codex' ? createCodexReviewAdapter(launch) : null
}

function summarize(message: string): string {
  return redactCredentials(message).trim().slice(0, 500) || 'Codex reported an error'
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
