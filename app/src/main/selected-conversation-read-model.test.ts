import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ConversationSnapshot, ConversationStreamEvent, RunSnapshot } from '@shared/contract'
import {
  SelectedConversationReadModel,
  conversationSelectedFor,
  planOf,
  type SelectedConversationSnapshot
} from '../renderer/src/lib/selected-conversation-read-model'
import { sessionChanges } from '../renderer/src/lib/useSessionChanges'

const AT = '2026-08-05T00:00:00.000Z'
const RENDERER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../renderer/src')

async function rendererSourceFiles(directory = RENDERER_ROOT): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return rendererSourceFiles(path)
      return Promise.resolve(/\.tsx?$/.test(entry.name) ? [path] : [])
    })
  )
  return nested.flat()
}

function conversation(
  activeRunId: string | null,
  entries: ConversationSnapshot['entries'] = [],
  journalPosition = 0
): ConversationSnapshot {
  return {
    sessionId: 'session',
    journalPosition,
    entries,
    usage: {
      run: null,
      session: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextWindow: null,
        contextUsed: null
      }
    },
    recovery: null,
    harnessThreads: {},
    changedFiles: [],
    activeRunId,
    pendingApprovalId: null,
    queue: { paused: true, items: [], outcome: null }
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('selected Conversation refreshes', () => {
  it('keeps every renderer consumer behind the selected Conversation owner', async () => {
    const durableReads: string[] = []
    for (const path of await rendererSourceFiles()) {
      const source = await readFile(path, 'utf8')
      for (const match of source.matchAll(/window\.shell\.(getConversation|listRuns)\(/g)) {
        durableReads.push(`${relative(RENDERER_ROOT, path)}:${match[1] ?? ''}`)
      }
    }

    expect(durableReads.sort()).toEqual([
      'lib/useSelectedConversation.ts:getConversation',
      'lib/useSelectedConversation.ts:listRuns'
    ])
  })

  it('subscribes before requesting the initial durable snapshot', async () => {
    const source = await readFile(join(RENDERER_ROOT, 'lib/useSelectedConversation.ts'), 'utf8')

    expect(source.indexOf('const stop = window.shell.onConversationEvent')).toBeLessThan(
      source.indexOf('void owner.requestRefresh()')
    )
  })

  it('does not expose the previous Session snapshot during a selection change', () => {
    const previous = {
      conversation: conversation(null),
      runs: [],
      live: null,
      failureSummary: null
    }

    expect(conversationSelectedFor('next-session', previous)).toBeNull()
  })

  it('bounds durable reads for a long Conversation independently of consumers', async () => {
    const entries: ConversationSnapshot['entries'] = Array.from({ length: 10_000 }, (_, index) => ({
      kind: 'message',
      id: `message-${String(index)}`,
      at: AT,
      runId: 'run',
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `Message ${String(index)}`,
      completeness: 'complete',
      source: index % 2 === 0 ? 'composer' : 'harness',
      reviewAttachments: [],
      submissionId: null,
      suggestedResponses: [],
      plainOptions: false
    }))
    async function readsFor(rendererConsumerCount: number): Promise<[number, number]> {
      const firstRead = deferred<ConversationSnapshot>()
      const readConversation = vi
        .fn<() => Promise<ConversationSnapshot>>()
        .mockReturnValueOnce(firstRead.promise)
        .mockResolvedValue(conversation('run', entries))
      const readRuns = vi.fn<() => Promise<RunSnapshot[]>>().mockResolvedValue([])
      const consumers = Array.from({ length: rendererConsumerCount }, () => vi.fn())
      const refresh = new SelectedConversationReadModel('session', {
        readConversation,
        readRuns,
        publish: (snapshot) => {
          for (const consume of consumers) {
            consume({
              messages: snapshot.conversation.entries,
              files: snapshot.conversation.changedFiles,
              runs: snapshot.runs
            })
          }
        }
      })

      const requested = refresh.requestRefresh()
      firstRead.resolve(conversation('run', entries))
      await requested
      expect(consumers.every((consume) => consume.mock.calls.length > 0)).toBe(true)
      return [readConversation.mock.calls.length, readRuns.mock.calls.length]
    }

    expect(await readsFor(20)).toEqual(await readsFor(1))
  })

  it('coalesces overlapping requests into one trailing refresh', async () => {
    const firstRead = deferred<ConversationSnapshot>()
    const readConversation = vi
      .fn<() => Promise<ConversationSnapshot>>()
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValue(conversation('run'))
    const refresh = new SelectedConversationReadModel('session', {
      readConversation,
      readRuns: vi.fn(() => Promise.resolve([])),
      publish: vi.fn()
    })

    const requested = Array.from({ length: 20 }, () => refresh.requestRefresh())
    firstRead.resolve(conversation('run'))
    await Promise.all(requested)

    expect(readConversation).toHaveBeenCalledTimes(2)
  })

  it('discards an older read after an action adopts a newer snapshot', async () => {
    const oldRead = deferred<ConversationSnapshot>()
    const readConversation = vi.fn(() => oldRead.promise)
    const publish = vi.fn((_snapshot: SelectedConversationSnapshot): void => undefined)
    const refresh = new SelectedConversationReadModel('session', {
      readConversation,
      readRuns: vi.fn(() => Promise.resolve([])),
      publish
    })

    const reading = refresh.requestRefresh()
    const newer = conversation('new-run')
    refresh.adopt(newer)
    oldRead.resolve(conversation(null))
    await reading

    expect(publish).toHaveBeenLastCalledWith({
      conversation: newer,
      runs: [],
      live: null,
      failureSummary: null
    })
  })

  it('discards a read that began before lifecycle invalidation', async () => {
    const oldRead = deferred<ConversationSnapshot>()
    const scheduled: (() => void)[] = []
    const publish = vi.fn((_snapshot: SelectedConversationSnapshot): void => undefined)
    const refresh = new SelectedConversationReadModel('session', {
      readConversation: vi
        .fn<() => Promise<ConversationSnapshot>>()
        .mockReturnValueOnce(oldRead.promise)
        .mockResolvedValue(conversation('run')),
      readRuns: vi.fn(() => Promise.resolve([])),
      publish,
      requestPaint: (callback) => {
        callback(0)
        return 1
      },
      cancelPaint: vi.fn(),
      scheduleRefresh: (callback) => {
        scheduled.push(callback)
        return scheduled.length
      },
      cancelRefresh: vi.fn()
    })

    const reading = refresh.requestRefresh()
    refresh.push({
      sessionId: 'session',
      runId: 'run',
      journalPosition: 0,
      invalidation: 'mailbox',
      event: { type: 'started' }
    })
    oldRead.resolve(conversation(null))
    await reading

    expect(publish).not.toHaveBeenCalled()
    scheduled[0]?.()
    await vi.waitFor(() => expect(publish).toHaveBeenCalled())
    expect(publish.mock.calls[0]?.[0].conversation.activeRunId).toBe('run')
  })

  it('returns the durable snapshot an optimistic action refreshes against', async () => {
    const durable = conversation(null, [
      {
        kind: 'message',
        id: 'user:submission',
        at: AT,
        runId: null,
        role: 'user',
        text: 'Keep this message',
        completeness: 'complete',
        source: 'composer',
        reviewAttachments: [],
        submissionId: 'submission',
        suggestedResponses: [],
        plainOptions: false
      }
    ])
    const refresh = new SelectedConversationReadModel('session', {
      readConversation: vi.fn(() => Promise.resolve(durable)),
      readRuns: vi.fn(() => Promise.resolve([])),
      publish: vi.fn()
    })

    const result = await refresh.requestRefresh()

    expect(result?.conversation).toEqual(durable)
  })

  it('reloads Run history only when the active Run identity changes', async () => {
    const snapshots = [conversation('run'), conversation('run'), conversation(null)]
    const readRuns = vi.fn<() => Promise<RunSnapshot[]>>().mockResolvedValue([])
    const refresh = new SelectedConversationReadModel('session', {
      readConversation: vi.fn(() => Promise.resolve(snapshots.shift() ?? conversation(null))),
      readRuns,
      publish: vi.fn()
    })

    await refresh.requestRefresh()
    await refresh.requestRefresh()
    await refresh.requestRefresh()

    expect(readRuns).toHaveBeenCalledTimes(2)
  })

  it('folds streamed state at paint cadence without durable reads', async () => {
    const readConversation = vi.fn(() => Promise.resolve(conversation('run')))
    const paints: ((time: number) => void)[] = []
    const publish = vi.fn((_snapshot: SelectedConversationSnapshot): void => undefined)
    const refresh = new SelectedConversationReadModel('session', {
      readConversation,
      readRuns: vi.fn(() => Promise.resolve([])),
      publish,
      requestPaint: (callback) => {
        paints.push(callback)
        return paints.length
      },
      cancelPaint: vi.fn()
    })
    const pushed = (event: ConversationStreamEvent['event']): void =>
      refresh.push({
        sessionId: 'session',
        runId: 'run',
        journalPosition: 0,
        invalidation: 'none',
        event
      })

    await refresh.requestRefresh()
    readConversation.mockClear()
    publish.mockClear()

    pushed({ type: 'assistant-message', id: 'message', text: 'One', complete: false })
    pushed({ type: 'assistant-message', id: 'message', text: 'One two', complete: false })
    pushed({
      type: 'file-change',
      path: '/project/src/index.ts',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }]
    })

    expect(paints).toHaveLength(1)
    expect(readConversation).not.toHaveBeenCalled()
    paints[0]?.(0)
    expect(publish).toHaveBeenCalledOnce()
    expect(publish.mock.calls[0]?.[0].live).toMatchObject({
      runId: 'run',
      messages: [{ id: 'message', text: 'One two' }],
      changes: [{ path: '/project/src/index.ts' }]
    })
  })

  it('keeps an event arriving during the snapshot and drops it once that event is durable', async () => {
    const firstRead = deferred<ConversationSnapshot>()
    const settled = conversation(
      'run',
      [
        {
          kind: 'message',
          id: 'assistant:run:message',
          at: AT,
          runId: 'run',
          role: 'assistant',
          text: 'Arrived in between',
          completeness: 'complete',
          source: 'harness',
          reviewAttachments: [],
          submissionId: null,
          suggestedResponses: [],
          plainOptions: false
        }
      ],
      11
    )
    const snapshots = [firstRead.promise, Promise.resolve(settled)]
    const refresh = new SelectedConversationReadModel('session', {
      readConversation: vi.fn(() => snapshots.shift() ?? Promise.resolve(conversation('run'))),
      readRuns: vi.fn(() => Promise.resolve([])),
      publish: vi.fn()
    })

    const reading = refresh.requestRefresh()
    refresh.push({
      sessionId: 'session',
      runId: 'run',
      journalPosition: 10,
      invalidation: 'none',
      event: {
        type: 'assistant-message',
        id: 'message',
        text: 'Arrived in between',
        complete: false
      }
    })
    firstRead.resolve(conversation('run', [], 10))

    expect((await reading)?.live?.messages).toEqual([{ id: 'message', text: 'Arrived in between' }])

    const durable = await refresh.requestRefresh()
    expect(durable?.conversation.entries).toHaveLength(1)
    expect(durable?.live?.messages ?? []).toEqual([])
  })

  it('reconciles live state against the active durable Run identity', async () => {
    const snapshots = [conversation('run'), conversation(null)]
    const publish = vi.fn()
    const refresh = new SelectedConversationReadModel('session', {
      readConversation: vi.fn(() => Promise.resolve(snapshots.shift() ?? conversation(null))),
      readRuns: vi.fn(() => Promise.resolve([])),
      publish,
      requestPaint: (callback) => {
        callback(0)
        return 1
      },
      cancelPaint: vi.fn()
    })

    await refresh.requestRefresh()
    refresh.push({
      sessionId: 'session',
      runId: 'run',
      journalPosition: 0,
      invalidation: 'none',
      event: { type: 'assistant-message', id: 'message', text: 'Live', complete: false }
    })
    await refresh.requestRefresh()

    expect(publish).toHaveBeenLastCalledWith({
      conversation: conversation(null),
      runs: [],
      live: null,
      failureSummary: null
    })
  })

  it('keeps a streamed failure visible after terminal durability catches up', async () => {
    const paints: ((time: number) => void)[] = []
    const publish = vi.fn((_snapshot: SelectedConversationSnapshot): void => undefined)
    const refresh = new SelectedConversationReadModel('session', {
      readConversation: vi.fn(() => Promise.resolve(conversation(null))),
      readRuns: vi.fn(() => Promise.resolve([])),
      publish,
      requestPaint: (callback) => {
        paints.push(callback)
        return paints.length
      },
      cancelPaint: vi.fn()
    })

    await refresh.requestRefresh()
    refresh.push({
      sessionId: 'session',
      runId: 'run',
      journalPosition: 0,
      invalidation: 'mailbox',
      event: { type: 'failed', category: 'process-crash', summary: 'The Harness exited' }
    })
    paints[0]?.(0)
    await refresh.requestRefresh()

    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ failureSummary: 'The Harness exited' })
    )
  })

  it('projects streamed file changes into the shared Files and title-bar model', async () => {
    const paints: ((time: number) => void)[] = []
    let selected: SelectedConversationSnapshot | null = null
    const refresh = new SelectedConversationReadModel('session', {
      readConversation: vi.fn(() => Promise.resolve(conversation('run'))),
      readRuns: vi.fn(() => Promise.resolve([])),
      publish: (snapshot) => {
        selected = snapshot
      },
      requestPaint: (callback) => {
        paints.push(callback)
        return paints.length
      },
      cancelPaint: vi.fn()
    })

    await refresh.requestRefresh()
    refresh.push({
      sessionId: 'session',
      runId: 'run',
      journalPosition: 0,
      invalidation: 'none',
      event: {
        type: 'file-change',
        path: 'src/index.ts',
        changeKind: 'changed',
        hunks: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-old', '+new', '+more'] }
        ]
      }
    })
    paints[0]?.(0)

    const current = selected as SelectedConversationSnapshot | null
    expect(sessionChanges(current?.conversation ?? null, current?.live ?? null)).toMatchObject({
      files: [{ path: 'src/index.ts', changes: 1, added: 2, removed: 1 }],
      entries: [{ id: 'file-change:run:1', path: 'src/index.ts' }],
      totals: { added: 2, removed: 1 }
    })
  })
})

describe('the Plan a Run is working through', () => {
  const plan = (steps: { step: string; status: string }[]): ConversationSnapshot['entries'] => [
    {
      kind: 'plan',
      id: 'plan:run',
      at: AT,
      startedAt: AT,
      runId: 'run',
      explanation: null,
      steps: steps.map((step) => ({
        step: step.step,
        activeForm: null,
        status: step.status as 'pending' | 'in-progress' | 'completed'
      }))
    }
  ]

  it('reads the journal when nothing is streaming', () => {
    expect(
      planOf(plan([{ step: 'Map the seams', status: 'completed' }]), null, 'run')
    ).toMatchObject({ steps: [{ step: 'Map the seams', status: 'completed' }] })
  })

  it('lets the live report win outright, because both carry the whole list', () => {
    const live = {
      runId: 'run',
      messages: [],
      changes: [],
      fileChangeOrdinal: 0,
      commands: [],
      subagents: [],
      plan: {
        explanation: 'Revised.',
        steps: [
          { step: 'Map the seams', activeForm: null, status: 'completed' as const },
          { step: 'Draw the indicator', activeForm: null, status: 'in-progress' as const }
        ]
      },
      suggestedResponses: []
    }
    // The durable entry still says one step; merging the two would show a step
    // from one snapshot beside a step from another.
    expect(planOf(plan([{ step: 'Map the seams', status: 'in-progress' }]), live, 'run')).toEqual(
      live.plan
    )
  })

  it('says nothing for a Run that kept no Plan, which is most of them', () => {
    expect(planOf([], null, 'run')).toBeNull()
    expect(planOf(plan([{ step: 'Map the seams', status: 'completed' }]), null, 'other')).toBeNull()
  })
})
