import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreCommand, SessionSummary } from '@shared/contract'
import { parseReviewReport, type ReviewEvent } from '@shared/review'
import type { HarnessId, ReadinessSnapshot } from '@shared/readiness'
import { ReviewStore } from './review-store'
import { ReviewService, type ReviewProcessRunner } from './review-service'

/**
 * A Review is a detached thread rather than a Run, so what is asserted here is
 * mostly what it does *not* do: it reaches no Conversation, it answers with
 * located Findings, and one that fails says why and leaves the Session as it
 * was.
 *
 * The Harness protocol is Core's and stays there — the Adapter is proven
 * against the recorded binary in `codex-review.test.ts`. What crosses the
 * process seam is the validated review stream, so that is what stands in for
 * Core here.
 */

const SESSION: SessionSummary = {
  id: 'session-1',
  projectRoot: '/a-project',
  checkout: { kind: 'local' },
  worktreeBootstrap: null,
  title: 'A Session',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  pinned: false,
  archivedAt: null
}

const REPORT = [
  '[P1] Close the reader before returning — src/io.ts:40-58',
  '',
  'The early return leaves the handle open.',
  '',
  'Otherwise the change reads well.'
].join('\n')

const COMPLETED: ReviewEvent = { type: 'review-completed', ...parseReviewReport(REPORT) }

function readiness(available = true): ReadinessSnapshot {
  return {
    harnesses: [
      {
        harness: 'codex',
        displayName: 'Codex',
        command: 'codex',
        executablePath: available ? '/usr/local/bin/codex' : null,
        executableSource: 'path',
        version: '0.147.0',
        checks: [],
        capabilities: { developSession: { available: true, summary: 'Ready' } },
        checkedAt: '2026-01-01T00:00:00.000Z',
        available
      }
    ],
    pathSources: [],
    loginShellConsent: false,
    skillsInstallCommand: 'codex skills install'
  } as unknown as ReadinessSnapshot
}

/** Everything Main said to Core while a Review ran, and what Core answered. */
class FakeCore {
  readonly sent: CoreCommand[] = []

  constructor(private readonly events: ReviewEvent[]) {}

  send = (command: CoreCommand): Promise<unknown> => {
    this.sent.push(command)
    if (command.type === 'review/open') {
      return Promise.resolve({ events: [], outgoing: ['{"id":1,"method":"initialize"}'] })
    }
    if (command.type === 'review/ingest') {
      return Promise.resolve({ events: this.events, outgoing: [] })
    }
    if (command.type === 'review/close') return Promise.resolve({ events: [], outgoing: [] })
    throw new Error(`unexpected command ${command.type}`)
  }
}

/** A Harness that prints once, which is all Core needs in order to answer. */
const printsOnce: ReviewProcessRunner = async (request) => {
  await request.onOutput('{"method":"turn/completed"}\n')
}

/** A Harness that never answers, so the wait can be interrupted from outside. */
function neverAnswers(): {
  runProcess: ReviewProcessRunner
  started: Promise<void>
  stopped: () => boolean
} {
  let aborted = false
  let running = (): void => undefined
  const started = new Promise<void>((resolve) => {
    running = resolve
  })
  return {
    started,
    stopped: () => aborted,
    runProcess: (request) =>
      new Promise((resolve) => {
        const stop = (): void => {
          aborted = true
          resolve()
        }
        // The runner's contract: an already-raised signal is honoured before
        // anything is spawned, and a later one is listened for.
        if (request.signal.aborted) {
          stop()
          return
        }
        request.signal.addEventListener('abort', stop)
        running()
      })
  }
}

describe('ReviewService', () => {
  let root: string

  const service = (
    core: FakeCore,
    overrides: Partial<ConstructorParameters<typeof ReviewService>[0]> = {}
  ): ReviewService =>
    new ReviewService({
      core,
      store: new ReviewStore(root),
      session: () => Promise.resolve(SESSION),
      harnessFor: () => Promise.resolve<HarnessId | null>('codex'),
      readiness: { refresh: () => Promise.resolve(readiness()) },
      homeDirectory: root,
      privateRoot: root,
      now: () => new Date('2026-02-02T03:04:05.000Z'),
      randomId: () => 'review-1',
      runProcess: printsOnce,
      ...overrides
    })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'argos-review-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('answers with findings that name a file and a line range', async () => {
    const state = await service(new FakeCore([COMPLETED])).request(SESSION.id)
    expect(state.review?.findings).toEqual([
      {
        id: 'finding-1',
        priority: 'P1',
        title: 'Close the reader before returning',
        body: 'The early return leaves the handle open.',
        path: 'src/io.ts',
        startLine: 40,
        endLine: 58
      }
    ])
    expect(state.review?.assessment).toBe('Otherwise the change reads well.')
    expect(state.failure).toBeNull()
  })

  it('says nothing to any Conversation while it does it', async () => {
    const core = new FakeCore([COMPLETED])
    await service(core).request(SESSION.id)
    expect(core.sent.map((command) => command.type)).toEqual([
      'review/open',
      'review/ingest',
      'review/close'
    ])
  })

  it('keeps the Review so the surface can read it back without asking again', async () => {
    await service(new FakeCore([COMPLETED])).request(SESSION.id)
    const state = await service(new FakeCore([])).state(SESSION.id)
    expect(state.review?.findings).toHaveLength(1)
    expect(state.running).toBe(false)
  })

  it('reports a Review the Harness refused, and keeps the last one readable', async () => {
    await service(new FakeCore([COMPLETED])).request(SESSION.id)
    const state = await service(
      new FakeCore([{ type: 'review-failed', summary: 'not signed in' }])
    ).request(SESSION.id)
    expect(state.failure).toBe('not signed in')
    expect(state.review?.findings).toHaveLength(1)
  })

  it('reports a Review whose process never started', async () => {
    const state = await service(new FakeCore([COMPLETED]), {
      runProcess: () => Promise.reject(new Error('codex would not start'))
    }).request(SESSION.id)
    expect(state.failure).toBe('codex would not start')
    expect(state.review).toBeNull()
  })

  it('refuses to ask a Harness that is not ready, without touching the store', async () => {
    const state = await service(new FakeCore([COMPLETED]), {
      readiness: { refresh: () => Promise.resolve(readiness(false)) }
    }).request(SESSION.id)
    expect(state.failure).toBe('codex is not ready to review this Session')
    expect(state.review).toBeNull()
  })

  it('states that a Harness with no review capability has none', async () => {
    const core = new FakeCore([COMPLETED])
    const state = await service(core, {
      harnessFor: () => Promise.resolve<HarnessId | null>('claude')
    }).request(SESSION.id)
    expect(state.supported).toBe(false)
    expect(state.harness).toBe('claude')
    expect(state.review).toBeNull()
    expect(core.sent).toEqual([])
  })

  it('says there is nothing to ask when no Harness has answered yet', async () => {
    const state = await service(new FakeCore([COMPLETED]), {
      harnessFor: () => Promise.resolve(null)
    }).request(SESSION.id)
    expect(state.supported).toBe(false)
    expect(state.harness).toBeNull()
  })

  it('answers a second ask with the Review already running', async () => {
    const core = new FakeCore([COMPLETED])
    const reviewing = service(core)
    const [first, second] = await Promise.all([
      reviewing.request(SESSION.id),
      reviewing.request(SESSION.id)
    ])
    expect(first).toEqual(second)
    expect(core.sent.filter((command) => command.type === 'review/open')).toHaveLength(1)
  })

  it('forgets a Review with the Session it belonged to', async () => {
    const reviewing = service(new FakeCore([COMPLETED]))
    await reviewing.request(SESSION.id)
    await reviewing.forget(SESSION.id)
    expect((await reviewing.state(SESSION.id)).review).toBeNull()
  })

  it('stops a Review in flight when its Session is deleted, and writes nothing', async () => {
    const harness = neverAnswers()
    const reviewing = service(new FakeCore([COMPLETED]), { runProcess: harness.runProcess })
    const asked = reviewing.request(SESSION.id)
    await harness.started
    await reviewing.forget(SESSION.id)
    // The Harness is stopped rather than left reading a deleted Session's
    // Checkout, and the answer it never gave recreates nothing.
    expect(harness.stopped()).toBe(true)
    const state = await asked
    expect(state.review).toBeNull()
    expect(state.failure).toBeNull()
    expect((await reviewing.state(SESSION.id)).review).toBeNull()
  })

  it('keeps an abandoned Review from overwriting a record deleted after it', async () => {
    const reviewing = service(new FakeCore([COMPLETED]))
    await reviewing.request(SESSION.id)
    const second = reviewing.request(SESSION.id)
    await reviewing.forget(SESSION.id)
    await second
    expect((await reviewing.state(SESSION.id)).review).toBeNull()
  })
})
