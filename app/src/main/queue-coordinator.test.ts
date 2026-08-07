import { describe, expect, it, vi } from 'vitest'
import type { QueuedSubmission } from '@shared/conversation'
import { QueueCoordinator } from './queue-coordinator'

const ITEM: QueuedSubmission = {
  kind: 'queued-submission',
  id: 'queued:submission-1',
  at: '2026-08-05T00:00:00.000Z',
  submissionId: 'submission-1',
  text: 'Queued work',
  source: 'composer',
  harness: 'codex',
  model: 'gpt-5-codex',
  effort: 'medium',
  skill: null,
  permissionMode: 'ask',
  reviewAttachments: [],
  status: 'claimed',
  position: 0
}

const PLAN = {
  sessionId: 'session',
  item: ITEM,
  runSubmissionId: 'submission-1',
  prompt: ITEM.text
}

describe('per-Session queue drainage', () => {
  it('claims and starts only one item across concurrent drains', async () => {
    const observations: unknown[] = []
    let claimed = false
    const queue = {
      next: vi.fn(() => {
        if (claimed) return Promise.resolve(null)
        claimed = true
        return Promise.resolve(PLAN)
      }),
      observeLaunch: vi.fn((input: unknown) => {
        observations.push(input)
        return Promise.resolve({ continueDraining: false })
      })
    }
    const start = vi.fn(() => Promise.resolve({ status: 'running' as const }))
    const coordinator = new QueueCoordinator({ queue, start })

    await Promise.all([coordinator.drain('session'), coordinator.drain('session')])

    expect(start).toHaveBeenCalledTimes(1)
    expect(observations).toContainEqual({
      sessionId: 'session',
      submissionId: 'submission-1',
      outcome: 'started'
    })
  })

  it('pauses without changing the claimed item when launch fails', async () => {
    const observations: unknown[] = []
    const queue = {
      next: vi.fn(() => Promise.resolve(PLAN)),
      observeLaunch: vi.fn((input: unknown) => {
        observations.push(input)
        return Promise.resolve({ continueDraining: false })
      })
    }
    const coordinator = new QueueCoordinator({
      queue,
      start: vi.fn(() => Promise.reject(new Error('not ready')))
    })

    await coordinator.drain('session')

    expect(observations).toContainEqual({
      sessionId: 'session',
      submissionId: 'submission-1',
      outcome: 'not-started'
    })
  })

  it('releases and pauses a claim when no Harness was contacted', async () => {
    const observations: unknown[] = []
    const queue = {
      next: vi.fn(() => Promise.resolve(PLAN)),
      observeLaunch: vi.fn((input: unknown) => {
        observations.push(input)
        return Promise.resolve({ continueDraining: false })
      })
    }
    const coordinator = new QueueCoordinator({
      queue,
      start: vi.fn(() => Promise.resolve({ status: 'supervision-failed' as const }))
    })

    await coordinator.drain('session')

    expect(observations).toContainEqual({
      sessionId: 'session',
      submissionId: 'submission-1',
      outcome: 'not-started'
    })
  })
})
