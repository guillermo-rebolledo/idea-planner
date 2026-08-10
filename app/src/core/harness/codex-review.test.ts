import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ReviewEvent } from '@shared/review'
import { createCodexReviewAdapter, createReviewAdapter } from './codex-review'

/**
 * The Codex review contract suite. `codex-review.jsonl` is a real detached
 * review recorded from the installed binary (codex-cli 0.147.0) against a
 * scratch repository carrying one deliberate regression, so what this suite
 * asserts is what that Harness actually says rather than what its
 * documentation claims.
 *
 * Re-record it with `pnpm codex:record-review` when the supported version
 * moves.
 */

/** Replays the recording, answering as the app does, in chunks of `size`. */
async function replay(size = 64): Promise<{ events: ReviewEvent[]; sent: unknown[] }> {
  const raw = await readFile(join(__dirname, 'fixtures', 'codex-review.jsonl'), 'utf8')
  const adapter = createCodexReviewAdapter({ cwd: '/a-project' })
  const events: ReviewEvent[] = []
  const sent = [...adapter.takeOutgoing()]
  for (let index = 0; index < raw.length; index += size) {
    events.push(...adapter.ingest(raw.slice(index, index + size)))
    sent.push(...adapter.takeOutgoing())
  }
  return { events, sent: sent.map((frame): unknown => JSON.parse(frame)) }
}

describe('the Codex review Adapter', () => {
  it('asks for a detached review of the uncommitted changes, read-only', async () => {
    const { sent } = await replay()
    expect(sent).toMatchObject([
      { id: 1, method: 'initialize' },
      { method: 'initialized' },
      {
        id: 2,
        method: 'thread/start',
        params: { cwd: '/a-project', approvalPolicy: 'never', sandbox: 'read-only' }
      },
      {
        id: 3,
        method: 'review/start',
        params: { target: { type: 'uncommittedChanges' }, delivery: 'detached' }
      }
    ])
  })

  it('answers once, with findings that name a file and a line', async () => {
    const { events } = await replay()
    expect(events).toHaveLength(1)
    const [event] = events
    expect(event?.type).toBe('review-completed')
    if (event?.type !== 'review-completed') return
    expect(event.findings).toHaveLength(1)
    expect(event.findings[0]).toMatchObject({
      priority: 'P1',
      path: 'greeting.js',
      startLine: 2,
      endLine: 2
    })
    expect(event.findings[0]?.title).toContain('non-string names')
    expect(event.findings[0]?.body).toContain('TypeError')
    // The overall read the reviewer was asked for is not a Finding: it names
    // no place, and a row pointing nowhere is what this surface replaces.
    expect(event.assessment).toContain('Overall assessment')
    expect(event.assessment).not.toContain('TypeError')
  })

  it('reads the same review however the bytes are chopped up', async () => {
    const [small, large] = await Promise.all([replay(1), replay(65_536)])
    expect(small.events).toEqual(large.events)
  })
})

describe('createReviewAdapter', () => {
  it('has nothing to offer for a Harness with no review of its own', () => {
    expect(createReviewAdapter('claude', { cwd: '/a-project' })).toBeNull()
    expect(createReviewAdapter('codex', { cwd: '/a-project' })).not.toBeNull()
  })
})

describe('a review that never answers', () => {
  it('is a failure rather than a review with nothing in it', () => {
    const adapter = createCodexReviewAdapter({ cwd: '/a-project' })
    expect(adapter.flush()).toEqual([
      { type: 'review-failed', summary: 'Codex ended before it answered this review' }
    ])
  })

  it('reports what the Harness said when it refuses outright, and only once', () => {
    const adapter = createCodexReviewAdapter({ cwd: '/a-project' })
    adapter.takeOutgoing()
    const refused = adapter.ingest(
      `${JSON.stringify({ id: 1, error: { message: 'not signed in' } })}\n`
    )
    expect(refused).toEqual([{ type: 'review-failed', summary: 'not signed in' }])
    expect(adapter.flush()).toEqual([])
  })
})
