import { spawn } from 'node:child_process'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  reviewSchema,
  reviewStateSchema,
  reviewStreamSchema,
  type Review,
  type ReviewEvent,
  type ReviewState
} from '@shared/review'
import type { CoreCommand, SessionSummary } from '@shared/contract'
import { checkoutDirectory } from '@shared/checkout'
import type { HarnessId, ReadinessSnapshot } from '@shared/readiness'
import type { ReviewStore } from './review-store'

/**
 * Which Harnesses can be asked for a Review at all. Codex exposes one, with a
 * thread of its own and located findings; Claude exposes nothing equivalent,
 * and the app says so rather than offering an action that would do nothing —
 * the precedent Skills and Permission Modes already set.
 */
const REVIEWING_HARNESSES = new Set<HarnessId>(['codex'])

export function harnessReviews(harness: HarnessId): boolean {
  return REVIEWING_HARNESSES.has(harness)
}

/**
 * How long one Review is given before it is abandoned. A review reads a whole
 * change and its call sites, so it is a long request by nature; one that has
 * not answered by here is one nobody is still waiting for.
 */
export const REVIEW_TIMEOUT_MS = 15 * 60_000

/** How much a Review may print before it is stopped. */
const REVIEW_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024

export interface ReviewProcessRequest {
  executable: string
  args: string[]
  environment: Record<string, string>
  workingDirectory: string
  timeoutMs: number
  /** The frames that open the exchange, written before anything is read. */
  opening: string[]
  /**
   * One chunk of the Harness's own protocol, answered with the frames it is
   * owed — and with whether the Review is over, which is what stops the
   * process: an app-server asked for one review does not end by itself.
   */
  onOutput: (chunk: string) => Promise<{ frames: string[]; done: boolean }>
  /**
   * Raised when nobody is waiting for this Review any more. The process is
   * stopped where it stands: abandoning is not a failure, so the runner
   * returns rather than throwing.
   */
  signal: AbortSignal
}

export type ReviewProcessRunner = (request: ReviewProcessRequest) => Promise<void>

export interface ReviewServiceDeps {
  core: { send(command: CoreCommand): Promise<unknown> }
  store: ReviewStore
  session(sessionId: string): Promise<SessionSummary>
  /** The Harness that has most recently answered in this Session, if any. */
  harnessFor(sessionId: string): Promise<HarnessId | null>
  readiness: { refresh(harness: HarnessId): Promise<ReadinessSnapshot> }
  homeDirectory: string
  /** Where a Review may keep its own scratch files; never inside a Project. */
  privateRoot: string
  now?: () => Date
  randomId?: () => string
  runProcess?: ReviewProcessRunner
}

/**
 * Asking a Harness what it thinks of the code a Session changed.
 *
 * A Review is a detached thread rather than a Run: it appends nothing to the
 * Conversation, spends none of the Session's context, and is refused the
 * ability to change anything in the Checkout. That is what makes it worth
 * having in the long Sessions where a check is most useful — and it is why
 * this lives beside RunService rather than inside it.
 */
export class ReviewService {
  private readonly deps: ReviewServiceDeps
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly runProcess: ReviewProcessRunner
  /**
   * The Review each Session has in flight, and the handle that abandons it.
   * One per Session at a time; a second ask joins the first.
   */
  private readonly running = new Map<
    string,
    { work: Promise<ReviewState>; abandon: AbortController }
  >()
  /** Why the last attempt did not answer, until another one does. */
  private readonly failures = new Map<string, string>()

  constructor(deps: ReviewServiceDeps) {
    this.deps = deps
    this.now = deps.now ?? ((): Date => new Date())
    this.randomId = deps.randomId ?? ((): string => `review-${Date.now().toString(36)}`)
    this.runProcess = deps.runProcess ?? runCodexAppServer
  }

  /** What the changed-files surface knows without asking for anything. */
  async state(sessionId: string): Promise<ReviewState> {
    const harness = await this.deps.harnessFor(sessionId)
    return reviewStateSchema.parse({
      harness,
      supported: harness !== null && harnessReviews(harness),
      running: this.running.has(sessionId),
      review: await this.deps.store.read(sessionId),
      failure: this.failures.get(sessionId) ?? null
    })
  }

  /**
   * Asks for one. A Review already running for this Session is the answer to a
   * second ask: two reviews of the same change would cost two requests and
   * disagree about which one the surface is showing.
   */
  request(sessionId: string): Promise<ReviewState> {
    const inFlight = this.running.get(sessionId)
    if (inFlight) return inFlight.work
    const abandon = new AbortController()
    const work = this.review(sessionId, abandon.signal).finally(() => {
      if (this.running.get(sessionId)?.abandon === abandon) this.running.delete(sessionId)
    })
    this.running.set(sessionId, { work, abandon })
    return work
  }

  /**
   * Forgets the Review a Session was given, and abandons the one it has in
   * flight. Stopping the Harness is the point rather than a tidy-up: a Review
   * left running for a deleted Session reads a Checkout nothing owns any more
   * for another quarter of an hour, and then writes its answer back under an
   * id that was deleted — recreating exactly the Session-owned state Delete
   * was asked to remove.
   *
   * The abandoned Review is waited on before the record goes, so it cannot
   * land between the abandonment and the delete.
   */
  async forget(sessionId: string): Promise<void> {
    const inFlight = this.running.get(sessionId)
    inFlight?.abandon.abort()
    await inFlight?.work.catch(() => undefined)
    this.running.delete(sessionId)
    this.failures.delete(sessionId)
    await this.deps.store.forget(sessionId)
  }

  private async review(sessionId: string, signal: AbortSignal): Promise<ReviewState> {
    /** Read through a call, so a check after an await is a real check. */
    const abandoned = (): boolean => signal.aborted
    // Abandoned before it began — deleted in the same tick it was asked for.
    // No Harness is started for a Session that is already gone.
    if (abandoned()) return await this.state(sessionId)
    const harness = await this.deps.harnessFor(sessionId)
    if (harness === null || !harnessReviews(harness)) return await this.state(sessionId)
    const requestedAt = this.now().toISOString()
    try {
      const outcome = await this.ask(sessionId, harness, signal)
      // Nobody is waiting for this any more: the Session it belonged to is
      // gone, so its answer is not written and its failure is not reported.
      if (abandoned()) return await this.state(sessionId)
      if (outcome.type === 'review-failed') {
        this.failures.set(sessionId, outcome.summary)
        return await this.state(sessionId)
      }
      const review: Review = reviewSchema.parse({
        sessionId,
        harness,
        requestedAt,
        completedAt: this.now().toISOString(),
        findings: outcome.findings,
        assessment: outcome.assessment
      })
      await this.deps.store.write(sessionId, review)
      this.failures.delete(sessionId)
    } catch (cause) {
      // A Review that fails says why and leaves the Session otherwise
      // untouched: nothing is written, and the previous Review stays readable.
      if (!abandoned()) this.failures.set(sessionId, describe(cause))
    }
    return await this.state(sessionId)
  }

  /** Drives one Harness process to the single event that ends the Review. */
  private async ask(
    sessionId: string,
    harness: HarnessId,
    signal: AbortSignal
  ): Promise<ReviewEvent> {
    const session = await this.deps.session(sessionId)
    const checkout = checkoutDirectory(session.projectRoot, session.checkout)
    const snapshot = await this.deps.readiness.refresh(harness)
    const entry = snapshot.harnesses.find((candidate) => candidate.harness === harness)
    if (!entry?.available || !entry.executablePath) {
      throw new Error(`${harness} is not ready to review this Session`)
    }
    const executable = entry.executablePath
    const reviewId = this.randomId()
    const reviewDirectory = join(this.deps.privateRoot, 'reviews', reviewId)
    // A staged home, exactly as a Run and a compaction get one: the person's
    // own `~/.codex` is never written to, and nothing they configured for
    // themselves applies to a request the app made (ADR 0003).
    const codexHome = join(reviewDirectory, 'codex-home')
    await mkdir(codexHome, { recursive: true, mode: 0o700 })
    await symlink(
      join(this.deps.homeDirectory, '.codex', 'auth.json'),
      join(codexHome, 'auth.json')
    ).catch(() => undefined)
    // The one event that ends a Review, held in a box: it is set from inside
    // the callbacks below, and a plain binding would read as never assigned.
    const answered: { event?: ReviewEvent } = {}
    const take = (events: ReviewEvent[]): void => {
      answered.event ??= events.at(0)
    }
    const opening = reviewStreamSchema.parse(
      await this.deps.core.send({
        type: 'review/open',
        reviewId,
        harness,
        launch: { cwd: checkout }
      })
    )
    try {
      await this.runProcess({
        executable,
        args: ['app-server'],
        environment: {
          PATH: `${dirname(executable)}:/usr/bin:/bin`,
          HOME: this.deps.homeDirectory,
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
          CODEX_HOME: codexHome,
          TMPDIR: reviewDirectory
        },
        workingDirectory: checkout,
        timeoutMs: REVIEW_TIMEOUT_MS,
        signal,
        opening: opening.outgoing,
        onOutput: async (chunk) => {
          const stream = reviewStreamSchema.parse(
            await this.deps.core.send({ type: 'review/ingest', reviewId, chunk })
          )
          take(stream.events)
          const done = answered.event !== undefined
          return { frames: done ? [] : stream.outgoing, done }
        }
      })
    } finally {
      const closing = reviewStreamSchema.parse(
        await this.deps.core.send({ type: 'review/close', reviewId })
      )
      take(closing.events)
      await rm(reviewDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
    return (
      answered.event ?? { type: 'review-failed', summary: 'The review ended without answering' }
    )
  }
}

function describe(cause: unknown): string {
  return (cause instanceof Error ? cause.message : 'The review could not be run').slice(0, 500)
}

/**
 * One `codex app-server`, spoken to until it has answered. Bounded in time and
 * in output, because a request that never ends — or answers with a gigabyte —
 * is one that takes the app down with it.
 */
function runCodexAppServer(request: ReviewProcessRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      cwd: request.workingDirectory,
      env: request.environment,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let bytes = 0
    let settled = false
    /** Read through a call, so a check after an await is a real check. */
    const stopped = (): boolean => settled
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGTERM')
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(
      () => finish(new Error('The review did not answer in time')),
      request.timeoutMs
    )
    // Abandoning is not a failure: nobody is waiting for an answer, so the
    // process is stopped and the runner simply returns.
    request.signal.addEventListener('abort', () => {
      finish()
    })
    if (request.signal.aborted) {
      finish()
      return
    }
    for (const frame of request.opening) child.stdin.write(`${frame}\n`)
    child.stdout.setEncoding('utf8')
    // Chunks are handed over strictly in order. Reading them is a round trip
    // to another process, and a protocol reassembled out of order is one whose
    // lines were cut in half by the reader rather than by the writer.
    let inOrder = Promise.resolve()
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > REVIEW_OUTPUT_LIMIT_BYTES) {
        finish(new Error('The review printed more than the app will read'))
        return
      }
      inOrder = inOrder
        .then(async () => {
          if (stopped()) return
          const answer = await request.onOutput(chunk)
          if (stopped()) return
          if (answer.done) {
            finish()
            return
          }
          for (const frame of answer.frames) child.stdin.write(`${frame}\n`)
        })
        .catch((cause: unknown) => {
          finish(cause instanceof Error ? cause : new Error('The review could not be read'))
        })
    })
    child.once('error', (cause: Error) => {
      finish(cause)
    })
    child.once('close', () => {
      finish()
    })
  })
}
