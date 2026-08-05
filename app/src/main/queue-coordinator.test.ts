import { describe, expect, it, vi } from 'vitest'
import type { CoreCommand } from '@shared/contract'
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

describe('per-Session queue drainage', () => {
  it('claims and starts only one item across concurrent drains', async () => {
    const commands: CoreCommand[] = []
    let claimed = false
    const core = {
      send: vi.fn((command: CoreCommand) => {
        commands.push(command)
        if (command.type === 'conversation/queue-claim') {
          if (claimed) return Promise.resolve(null)
          claimed = true
          return Promise.resolve(ITEM)
        }
        return Promise.resolve({})
      })
    }
    const start = vi.fn(() => Promise.resolve({ status: 'running' as const, recovered: false }))
    const pause = vi.fn(() => Promise.resolve())
    const coordinator = new QueueCoordinator({ core, start, pause })

    await Promise.all([coordinator.drain('session'), coordinator.drain('session')])

    expect(start).toHaveBeenCalledTimes(1)
    expect(commands.filter((command) => command.type === 'conversation/queue-sent')).toHaveLength(1)
  })

  it('pauses without changing the claimed item when launch fails', async () => {
    const commands: CoreCommand[] = []
    const core = {
      send: vi.fn((command: CoreCommand) => {
        commands.push(command)
        return Promise.resolve(command.type === 'conversation/queue-claim' ? ITEM : {})
      })
    }
    const pause = vi.fn(() => Promise.resolve())
    const coordinator = new QueueCoordinator({
      core,
      start: vi.fn(() => Promise.reject(new Error('not ready'))),
      pause
    })

    await coordinator.drain('session')

    expect(pause).toHaveBeenCalledWith('session')
    expect(commands).toContainEqual({
      type: 'conversation/queue-release',
      input: { sessionId: 'session', submissionId: 'submission-1' }
    })
    expect(commands.some((command) => command.type === 'conversation/queue-sent')).toBe(false)
  })

  it('releases and pauses a claim when no Harness was contacted', async () => {
    const commands: CoreCommand[] = []
    const core = {
      send: vi.fn((command: CoreCommand) => {
        commands.push(command)
        return Promise.resolve(command.type === 'conversation/queue-claim' ? ITEM : {})
      })
    }
    const pause = vi.fn(() => Promise.resolve())
    const coordinator = new QueueCoordinator({
      core,
      start: vi.fn(() =>
        Promise.resolve({ status: 'supervision-failed' as const, recovered: false })
      ),
      pause
    })

    await coordinator.drain('session')

    expect(commands).toContainEqual({
      type: 'conversation/queue-release',
      input: { sessionId: 'session', submissionId: 'submission-1' }
    })
    expect(commands.some((command) => command.type === 'conversation/queue-sent')).toBe(false)
    expect(pause).toHaveBeenCalledWith('session')
  })

  it('reconciles a recovered claim without launching a second Run', async () => {
    let claims = 0
    const commands: CoreCommand[] = []
    const core = {
      send: vi.fn((command: CoreCommand) => {
        commands.push(command)
        if (command.type !== 'conversation/queue-claim') return Promise.resolve({})
        claims += 1
        return Promise.resolve(claims === 1 ? ITEM : null)
      })
    }
    const start = vi.fn(() => Promise.resolve({ status: 'failed' as const, recovered: true }))
    const coordinator = new QueueCoordinator({
      core,
      start,
      pause: vi.fn(() => Promise.resolve())
    })

    await coordinator.drain('session')

    expect(start).toHaveBeenCalledTimes(1)
    expect(commands.filter((command) => command.type === 'conversation/queue-sent')).toHaveLength(1)
  })
})
