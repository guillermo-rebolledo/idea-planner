import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CodexLaunch, HarnessEvent } from '@shared/conversation'
import { createCodexAdapter } from './codex'

/**
 * The Codex contract suite. `codex-app-server.jsonl` is a real session
 * recorded from the installed binary (codex-cli 0.146.0) driving a file change
 * and a command in a scratch repository, so what this suite asserts is what
 * that Harness actually says rather than what its documentation claims.
 *
 * Re-record it with `pnpm codex:record` when the supported version moves.
 */

function launch(overrides: Partial<CodexLaunch> = {}): CodexLaunch {
  return {
    cwd: '/a-project',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    effort: 'low',
    developerInstructions: 'Be terse.',
    prompt: 'Change the greeting',
    ...overrides
  }
}

/** Replays the recording, answering as the app does, in chunks of `size`. */
async function replay(size = 64): Promise<{ events: HarnessEvent[]; sent: string[] }> {
  const raw = await readFile(join(__dirname, 'fixtures', 'codex-app-server.jsonl'), 'utf8')
  const adapter = createCodexAdapter(launch())
  const events: HarnessEvent[] = []
  const sent = [...adapter.takeOutgoing()]
  for (let index = 0; index < raw.length; index += size) {
    events.push(...adapter.ingest(raw.slice(index, index + size)))
    sent.push(...adapter.takeOutgoing())
  }
  events.push(...adapter.flush())
  return { events, sent }
}

function frames(sent: string[]): { method: string; params: Record<string, unknown> }[] {
  return sent.map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
}

describe('the exchange', () => {
  it('opens by speaking first, because Codex says nothing until it is spoken to', () => {
    const adapter = createCodexAdapter(launch())
    expect(frames(adapter.takeOutgoing()).map((frame) => frame.method)).toEqual(['initialize'])
    // Handed over exactly once: a frame written twice is a turn started twice.
    expect(adapter.takeOutgoing()).toEqual([])
  })

  it('starts a Harness Thread and one turn, in that order, as the answers arrive', async () => {
    const { sent } = await replay()
    expect(frames(sent).map((frame) => frame.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start'
    ])
  })

  it('carries the Run’s configuration over the protocol rather than in argv', async () => {
    const { sent } = await replay()
    const start = frames(sent).find((frame) => frame.method === 'thread/start')
    expect(start?.params).toMatchObject({
      cwd: '/a-project',
      // The wire values the installed binary accepts are kebab-case; the
      // published documentation's camelCase is rejected outright.
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      developerInstructions: 'Be terse.',
      config: { model_reasoning_effort: 'low' }
    })
  })

  it('continues a Harness Thread when there is one to continue', () => {
    const adapter = createCodexAdapter(launch({ resumeThreadId: 'thread-1' }))
    adapter.takeOutgoing()
    adapter.ingest(`${JSON.stringify({ id: 1, result: {} })}\n`)
    const [, resume] = frames(adapter.takeOutgoing())
    expect(resume?.method).toBe('thread/resume')
    expect(resume?.params).toMatchObject({ threadId: 'thread-1', cwd: '/a-project' })
    // Resume declares its own parameters, and a thread's source is not one:
    // it was fixed when the thread was started.
    expect(resume?.params).not.toHaveProperty('threadSource')
  })
})

describe('what the Run did', () => {
  it('normalizes the session identically however the stream is chopped up', async () => {
    const [byteAtATime, wholeFile] = await Promise.all([replay(1), replay(1_000_000)])
    expect(byteAtATime.events).toEqual(wholeFile.events)
    expect(byteAtATime.sent).toEqual(wholeFile.sent)
  })

  it('reports the Harness Thread so the Conversation can continue it', async () => {
    const { events } = await replay()
    expect(events.filter((event) => event.type === 'thread-ready')).toMatchObject([
      { harness: 'codex', threadId: '019fc3da-e096-72a3-8bcd-56313b8ca5e9' }
    ])
  })

  it('grows an assistant message and completes it once', async () => {
    const { events } = await replay()
    const messages = events.filter((event) => event.type === 'assistant-message')
    expect(messages.filter((event) => event.complete)).toHaveLength(2)
    // Every delta carries the whole message so far, so Core can supersede.
    const growing = messages.filter((event) => !event.complete)
    expect(growing[0]?.text.length).toBeLessThan(growing.at(-1)?.text.length ?? 0)
  })

  it('shows a command when it starts and again with what it printed', async () => {
    const { events } = await replay()
    expect(events.filter((event) => event.type === 'command')).toMatchObject([
      { command: "/bin/zsh -lc 'wc -l greeting.txt'", running: true, output: '' },
      {
        command: "/bin/zsh -lc 'wc -l greeting.txt'",
        running: false,
        failed: false,
        output: '       2 greeting.txt\n'
      }
    ])
  })

  it('renders a file change from the patch Codex computed for it', async () => {
    const { events } = await replay()
    // The thing `exec --json` could never do: its file_change items carry a
    // path and a kind and no diff at all.
    expect(events.filter((event) => event.type === 'file-change')).toMatchObject([
      {
        path: '/a-project/greeting.txt',
        hunks: [
          {
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 2,
            lines: ['-hello world', '+goodbye world', ' second line']
          }
        ]
      }
    ])
  })

  it('reports usage and the end of the turn', async () => {
    const { events } = await replay()
    expect(events.filter((event) => event.type === 'usage').at(-1)).toMatchObject({
      usage: { totalTokens: 52823, contextWindow: 258400 }
    })
    expect(events.filter((event) => event.type === 'completed')).toHaveLength(1)
  })

  it('says nothing about protocol it knows to skip, and names what it does not', async () => {
    const { events } = await replay()
    expect(events.filter((event) => event.type === 'unsupported')).toEqual([])

    const adapter = createCodexAdapter(launch())
    const [event] = adapter.ingest(`${JSON.stringify({ method: 'turn/other', params: {} })}\n`)
    expect(event).toMatchObject({ type: 'unsupported' })
  })
})

describe('an Approval Request', () => {
  /** What Codex sends when it wants a command allowed, as its schema declares. */
  function commandApproval(id = 0): string {
    return `${JSON.stringify({
      id,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 't',
        turnId: 'u',
        itemId: 'exec-1',
        startedAtMs: 1,
        command: 'gh pr view 7888',
        cwd: '/a-project',
        proposedExecpolicyAmendment: ['gh', 'pr', 'view']
      }
    })}\n`
  }

  it('becomes a request the person answers, carrying the rule Codex proposed', () => {
    const adapter = createCodexAdapter(launch())
    adapter.takeOutgoing()
    // A server request carries an id *and* a method. Read as an answer it
    // would be dropped, and Codex would block on a reply that never came.
    expect(adapter.ingest(commandApproval())).toMatchObject([
      {
        type: 'approval-request',
        id: '0',
        summary: 'gh pr view 7888',
        // Codex computed this prefix; the app never guesses one for it.
        proposedRule: { harness: 'codex', kind: 'command', pattern: ['gh', 'pr', 'view'] }
      }
    ])
    // Nothing is sent yet: it is the person who answers.
    expect(adapter.takeOutgoing()).toEqual([])
  })

  it('is answered on the wire, and remembering sends Codex its own amendment', () => {
    const adapter = createCodexAdapter(launch())
    adapter.ingest(commandApproval(3))
    adapter.takeOutgoing()

    expect(adapter.answerApproval('3', { allow: true, remember: true })).toBe(true)
    expect(JSON.parse(adapter.takeOutgoing()[0] ?? '{}')).toMatchObject({
      id: 3,
      result: {
        decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['gh', 'pr', 'view'] } }
      }
    })
    // Answered once: a second answer is not a second decision.
    expect(adapter.answerApproval('3', { allow: true, remember: false })).toBe(false)
  })

  it('declines plainly, and never claims a rule for a file change', () => {
    const adapter = createCodexAdapter(launch())
    adapter.ingest(commandApproval(1))
    adapter.takeOutgoing()
    adapter.answerApproval('1', { allow: false, remember: false })
    expect(JSON.parse(adapter.takeOutgoing()[0] ?? '{}')).toMatchObject({
      result: { decision: 'decline' }
    })

    // A file change has no reliable rule — `grantRoot` is unstable in Codex's
    // own schema — so remembering one is neither offered nor sent.
    expect(
      adapter.ingest(
        `${JSON.stringify({
          id: 2,
          method: 'item/fileChange/requestApproval',
          params: { threadId: 't', turnId: 'u', itemId: 'i', startedAtMs: 1, cwd: '/a-project' }
        })}\n`
      )
    ).toMatchObject([{ type: 'approval-request', proposedRule: null }])
    adapter.answerApproval('2', { allow: true, remember: true })
    expect(JSON.parse(adapter.takeOutgoing()[0] ?? '{}')).toMatchObject({
      result: { decision: 'accept' }
    })
  })

  it('drops a request Codex has stopped waiting on', () => {
    const adapter = createCodexAdapter(launch())
    adapter.ingest(commandApproval(5))
    const [resolved] = adapter.ingest(
      `${JSON.stringify({
        method: 'serverRequest/resolved',
        params: { threadId: 't', requestId: 5 }
      })}\n`
    )
    expect(resolved).toMatchObject({ type: 'approval-resolved', id: '5', decision: 'abandoned' })
    // And it says nothing about one it never had.
    expect(
      adapter.ingest(
        `${JSON.stringify({ method: 'serverRequest/resolved', params: { requestId: 99 } })}\n`
      )
    ).toEqual([])
  })

  it('refuses a request it cannot answer rather than leaving Codex on silence', () => {
    const adapter = createCodexAdapter(launch())
    adapter.takeOutgoing()
    expect(
      adapter.ingest(
        `${JSON.stringify({ id: 9, method: 'item/tool/requestUserInput', params: {} })}\n`
      )
    ).toMatchObject([{ type: 'unsupported' }])
    expect(JSON.parse(adapter.takeOutgoing()[0] ?? '{}')).toMatchObject({
      id: 9,
      error: { code: -32601 }
    })
  })
})

describe('stopping', () => {
  it('asks the turn to end, once it knows which turn to name', async () => {
    const raw = await readFile(join(__dirname, 'fixtures', 'codex-app-server.jsonl'), 'utf8')
    const adapter = createCodexAdapter(launch())
    adapter.ingest(raw)
    adapter.takeOutgoing()

    adapter.interrupt()
    expect(frames(adapter.takeOutgoing())).toMatchObject([
      { method: 'turn/interrupt', params: { threadId: '019fc3da-e096-72a3-8bcd-56313b8ca5e9' } }
    ])
  })

  it('says nothing when there is no turn to interrupt', () => {
    const adapter = createCodexAdapter(launch())
    adapter.takeOutgoing()
    adapter.interrupt()
    expect(adapter.takeOutgoing()).toEqual([])
  })
})

describe('a new file', () => {
  it('is read as every line added, because Codex sends its whole content', () => {
    const adapter = createCodexAdapter(launch())
    const [change] = adapter.ingest(
      `${JSON.stringify({
        method: 'item/completed',
        params: {
          item: {
            type: 'fileChange',
            id: 'exec-1',
            status: 'completed',
            changes: [{ path: '/a-project/new.txt', kind: { type: 'add' }, diff: 'alpha\nbeta\n' }]
          }
        }
      })}\n`
    )
    expect(change).toMatchObject({
      type: 'file-change',
      path: '/a-project/new.txt',
      hunks: [{ lines: ['+alpha', '+beta'] }]
    })
  })
})

describe('failure', () => {
  it('reports what the Harness said, categorized', () => {
    const adapter = createCodexAdapter(launch())
    const [refused] = adapter.ingest(
      `${JSON.stringify({ id: 2, error: { message: 'Unauthorized: please run codex login' } })}\n`
    )
    expect(refused).toMatchObject({ type: 'failed', category: 'authentication' })
  })

  it('reports a torn final line rather than inventing an ending', () => {
    const adapter = createCodexAdapter(launch())
    adapter.ingest('{"method":"item/started","par')
    expect(adapter.flush()).toEqual([{ type: 'unsupported', detail: 'unreadable protocol line' }])
  })
})
