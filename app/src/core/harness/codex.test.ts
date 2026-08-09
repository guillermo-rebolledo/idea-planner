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

  it('steers the active turn with the installed protocol precondition', () => {
    const adapter = createCodexAdapter(launch())
    adapter.takeOutgoing()
    adapter.ingest(`${JSON.stringify({ id: 1, result: {} })}\n`)
    adapter.takeOutgoing()
    adapter.ingest(`${JSON.stringify({ id: 2, result: { thread: { id: 'thread-1' } } })}\n`)
    adapter.takeOutgoing()
    adapter.ingest(`${JSON.stringify({ id: 3, result: { turn: { id: 'turn-1' } } })}\n`)

    expect(adapter.steer('Correct course now')).toBe(true)
    expect(frames(adapter.takeOutgoing())).toEqual([
      expect.objectContaining({
        method: 'turn/steer',
        params: {
          threadId: 'thread-1',
          expectedTurnId: 'turn-1',
          input: [{ type: 'text', text: 'Correct course now', text_elements: [] }]
        }
      })
    ])
  })

  it('accepts steering in the stream recorded from the installed binary', async () => {
    const raw = await readFile(join(__dirname, 'fixtures', 'codex-app-server.jsonl'), 'utf8')
    const response = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id?: number; result?: unknown; error?: unknown })
      .find((frame) => frame.id === 5)

    expect(response?.id).toBe(5)
    expect(typeof (response?.result as { turnId?: unknown } | undefined)?.turnId).toBe('string')
    expect(response).not.toHaveProperty('error')
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
    const ready = events.find((event) => event.type === 'thread-ready')
    expect(ready).toMatchObject({ harness: 'codex' })
    expect(ready?.type === 'thread-ready' ? typeof ready.threadId : 'missing').toBe('string')
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
    const commands = events.filter(
      (event) => event.type === 'command' && event.command === "/bin/zsh -lc 'wc -l greeting.txt'"
    )
    expect(commands).toMatchObject([
      {
        command: "/bin/zsh -lc 'wc -l greeting.txt'",
        running: true,
        output: '',
        exitCode: null,
        durationMs: null
      },
      {
        command: "/bin/zsh -lc 'wc -l greeting.txt'",
        running: false,
        failed: false,
        output: '       2 greeting.txt\n',
        // Codex says both outright, so the record keeps its figures.
        exitCode: 0,
        durationMs: 0
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
    const usage = events.filter((event) => event.type === 'usage').at(-1)
    expect(usage).toMatchObject({ usage: { contextWindow: 258400 } })
    expect(usage?.type === 'usage' ? typeof usage.usage.totalTokens : 'missing').toBe('number')
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
    const [interruption] = frames(adapter.takeOutgoing())
    expect(interruption?.method).toBe('turn/interrupt')
    expect(typeof interruption?.params['threadId']).toBe('string')
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

describe('subagents', () => {
  /**
   * A second recording, of a turn that delegated its work
   * (`codex-subagent.jsonl`). Codex runs a subagent as a Harness Thread of its
   * own, so the interesting part is what belongs to which thread.
   */
  async function replaySubagents(size = 64): Promise<HarnessEvent[]> {
    const raw = await readFile(join(__dirname, 'fixtures', 'codex-subagent.jsonl'), 'utf8')
    const adapter = createCodexAdapter(launch())
    const events: HarnessEvent[] = []
    for (let index = 0; index < raw.length; index += size) {
      events.push(...adapter.ingest(raw.slice(index, index + size)))
    }
    events.push(...adapter.flush())
    return events
  }

  it('names the subagent Codex spawned and follows it to its report', async () => {
    const subagents = (await replaySubagents()).filter((event) => event.type === 'subagent')

    expect(subagents.at(0)).toMatchObject({
      type: 'subagent',
      id: 'call_O5Z9xjHdfvzJzLVc1HZRo7C1',
      name: 'Count notes',
      status: 'working'
    })
    // Codex carries no dispatch prompt for a spawn, so the surface has no
    // brief to show and must not invent one.
    expect(subagents.at(0)).not.toHaveProperty('brief')

    const last = subagents.at(-1)
    expect(last).toMatchObject({ type: 'subagent', status: 'done', steps: 1 })
    // Its last word before its turn ended, and not a word before: a message it
    // produced while still working is as likely to be thinking aloud.
    expect(last?.type === 'subagent' && last.result).toBe('2 lines (`wc -l notes.txt`).')
    expect(
      subagents.filter((event) => event.status === 'working').some((event) => event.result)
    ).toBe(false)
  })

  it('keeps the subagent’s thread out of the Run’s own record', async () => {
    const events = await replaySubagents()

    // The subagent ran the command and gave the answer. Both arrived on its
    // own thread, and neither is the Run's own work.
    expect(events.filter((event) => event.type === 'command')).toEqual([])
    expect(
      events.filter((event) => event.type === 'assistant-message').map((event) => event.text)
    ).not.toContain('2')
  })

  it('ends the Run on its own turn, not on the subagent’s', async () => {
    // The recording holds both endings: the subagent's turn completes while
    // the Run works on, and the Run's own turn completes after it. Reading the
    // first as the Run's would close a Run that is still going.
    const events = await replaySubagents()
    const endings = events.filter(
      (event) => event.type === 'completed' || event.type === 'subagent'
    )
    expect(endings.filter((event) => event.type === 'completed')).toHaveLength(1)
    // The subagent landed before the Run did.
    expect(endings.at(-1)).toMatchObject({ type: 'completed' })
    expect(endings.filter((event) => event.type === 'subagent').at(-1)).toMatchObject({
      status: 'done'
    })
  })

  /**
   * A second way Codex spawns, seen on gpt-5.3-codex-spark: no
   * `subAgentActivity` at all, only `collabAgentToolCall`. The spawn carries
   * the brief, and the `wait` that follows carries each agent's state and the
   * report it came back with.
   */
  async function replayCollab(size = 64): Promise<HarnessEvent[]> {
    const raw = await readFile(join(__dirname, 'fixtures', 'codex-collab-subagents.jsonl'), 'utf8')
    const adapter = createCodexAdapter(launch())
    const events: HarnessEvent[] = []
    for (let index = 0; index < raw.length; index += size) {
      events.push(...adapter.ingest(raw.slice(index, index + size)))
    }
    events.push(...adapter.flush())
    return events
  }

  it('follows both subagents spawned through the collab tools', async () => {
    const subagents = (await replayCollab()).filter((event) => event.type === 'subagent')
    const byId = new Map(subagents.map((event) => [event.id, event]))
    expect(byId.size).toBe(2)

    // The spawn carries the brief this Harness had none of before.
    expect([...byId.values()].map((event) => event.brief)).toEqual([
      expect.stringContaining('Inspect repository structure and build tooling'),
      expect.stringContaining('Inspect source code layout')
    ])
    // Both landed, and each came back with what it found.
    expect([...byId.values()].every((event) => event.status === 'done')).toBe(true)
    expect([...byId.values()].every((event) => (event.result ?? '').length > 0)).toBe(true)
    // Named apart, so a dock of two says which is which.
    expect(new Set([...byId.values()].map((event) => event.name)).size).toBe(2)
  })

  it('keeps both subagents’ own work out of the Run, and the Run’s end its own', async () => {
    const events = await replayCollab()
    expect(events.filter((event) => event.type === 'command')).toEqual([])
    expect(events.filter((event) => event.type === 'completed')).toHaveLength(1)
    // The Run's own turn ends last, after both subagents have landed.
    expect(events.at(-1)).toMatchObject({ type: 'completed' })
  })

  it('reports no unsupported protocol for a turn that delegated', async () => {
    expect((await replaySubagents()).filter((event) => event.type === 'unsupported')).toEqual([])
    expect((await replayCollab()).filter((event) => event.type === 'unsupported')).toEqual([])
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

/**
 * The checklist Codex keeps for a turn, from hand-written frames rather than
 * from the recording: neither recorded session asked for work long enough for
 * the model to write a plan, so there is no `turn/plan/updated` in either
 * fixture. Re-record with `pnpm codex:record` against a task that earns one
 * and these become assertions about a real session.
 *
 * The shapes below are the generated bindings' own — `TurnPlanUpdatedNotification`
 * and `TurnPlanStep` in `codex-protocol/v2`.
 */
describe('the plan', () => {
  function planFrame(
    plan: { step: string; status: string }[],
    explanation: string | null = null
  ): string {
    return `${JSON.stringify({
      method: 'turn/plan/updated',
      params: { threadId: 'thread-1', turnId: 'turn-1', explanation, plan }
    })}\n`
  }

  it('reads the whole checklist, in this app’s spelling of its states', () => {
    const adapter = createCodexAdapter(launch())
    const [plan] = adapter.ingest(
      planFrame([
        { step: 'Read the Adapter', status: 'completed' },
        { step: 'Map the notification', status: 'inProgress' },
        { step: 'Record a fixture', status: 'pending' }
      ])
    )
    expect(plan).toEqual({
      type: 'plan',
      explanation: null,
      steps: [
        { step: 'Read the Adapter', activeForm: null, status: 'completed' },
        { step: 'Map the notification', activeForm: null, status: 'in-progress' },
        { step: 'Record a fixture', activeForm: null, status: 'pending' }
      ]
    })
  })

  it('carries the reason Codex gives for changing it', () => {
    const adapter = createCodexAdapter(launch())
    const [plan] = adapter.ingest(
      planFrame(
        [{ step: 'Split the reading out', status: 'inProgress' }],
        'The Claude side needs its own step.'
      )
    )
    expect(plan).toMatchObject({ explanation: 'The Claude side needs its own step.' })
  })

  it('says nothing for a plan of no steps, rather than announcing an empty one', () => {
    const adapter = createCodexAdapter(launch())
    expect(adapter.ingest(planFrame([]))).toEqual([])
  })

  it('is no longer reported as protocol this Adapter does not understand', () => {
    const adapter = createCodexAdapter(launch())
    const events = adapter.ingest(planFrame([{ step: 'Do the thing', status: 'pending' }]))
    expect(events.filter((event) => event.type === 'unsupported')).toEqual([])
  })

  it('reads a Thread Codex compacted itself, rather than calling it protocol it cannot read', () => {
    const adapter = createCodexAdapter(launch())
    const events = adapter.ingest(
      `${JSON.stringify({
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'contextCompaction', id: 'item-compaction-1' }
        }
      })}\n`
    )
    expect(events).toMatchObject([{ type: 'context-compacted' }])
    expect(events.filter((event) => event.type === 'unsupported')).toEqual([])
  })

  it('records that compaction once, from the item rather than the deprecated notice', () => {
    const adapter = createCodexAdapter(launch())
    const events = adapter.ingest(
      `${JSON.stringify({
        method: 'thread/compacted',
        params: { threadId: 'thread-1', turnId: 'turn-1' }
      })}\n`
    )
    expect(events).toEqual([])
  })

  it('leaves plan mode alone, which shares the word and nothing else', () => {
    const adapter = createCodexAdapter(launch())
    const events = adapter.ingest(
      `${JSON.stringify({
        method: 'item/plan/delta',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: '## Plan' }
      })}\n`
    )
    expect(events).toEqual([])
  })
})
