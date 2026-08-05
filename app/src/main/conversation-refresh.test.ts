import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ConversationSnapshot, RunSnapshot } from '@shared/contract'
import {
  ConversationRefresh,
  conversationSelectedFor
} from '../renderer/src/lib/conversation-refresh'

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
  entries: ConversationSnapshot['entries'] = []
): ConversationSnapshot {
  return {
    sessionId: 'session',
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
    pendingApprovalId: null
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

  it('does not expose the previous Session snapshot during a selection change', () => {
    const previous = { conversation: conversation(null), runs: [] }

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
      const refresh = new ConversationRefresh('session', {
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

      const requested = refresh.request()
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
    const refresh = new ConversationRefresh('session', {
      readConversation,
      readRuns: vi.fn(() => Promise.resolve([])),
      publish: vi.fn()
    })

    const requested = Array.from({ length: 20 }, () => refresh.request())
    firstRead.resolve(conversation('run'))
    await Promise.all(requested)

    expect(readConversation).toHaveBeenCalledTimes(2)
  })

  it('discards an older read after an action adopts a newer snapshot', async () => {
    const oldRead = deferred<ConversationSnapshot>()
    const readConversation = vi.fn(() => oldRead.promise)
    const publish = vi.fn()
    const refresh = new ConversationRefresh('session', {
      readConversation,
      readRuns: vi.fn(() => Promise.resolve([])),
      publish
    })

    const reading = refresh.request()
    const newer = conversation('new-run')
    refresh.adopt(newer)
    oldRead.resolve(conversation(null))
    await reading

    expect(publish).toHaveBeenLastCalledWith({ conversation: newer, runs: [] })
  })

  it('reloads Run history only when the active Run identity changes', async () => {
    const snapshots = [conversation('run'), conversation('run'), conversation(null)]
    const readRuns = vi.fn<() => Promise<RunSnapshot[]>>().mockResolvedValue([])
    const refresh = new ConversationRefresh('session', {
      readConversation: vi.fn(() => Promise.resolve(snapshots.shift() ?? conversation(null))),
      readRuns,
      publish: vi.fn()
    })

    await refresh.request()
    await refresh.request()
    await refresh.request()

    expect(readRuns).toHaveBeenCalledTimes(2)
  })
})
