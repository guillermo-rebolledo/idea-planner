import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConversationEntry, DiffHunk, HarnessEvent } from '@shared/conversation'
import { createCore, type Core } from './core'

/**
 * Developing a Session through the permanent Conversation, observed at the
 * Core interface: what the person submits, what streams back, and what
 * survives a Stop, a failure, or a crash.
 */

let stateDir: string
let projectRoot: string
let core: Core
let sessionId: string

/** Every Session in these tests is started by this message. */
const STARTING_MESSAGE = 'Offline receipts'

function makeCore(): Core {
  let tick = 0
  return createCore({
    stateDirectory: stateDir,
    now: () => new Date(Date.UTC(2026, 6, 31, 12, 0, tick++)),
    randomId: (() => {
      let n = 0
      return () => `test-id-${String(++n).padStart(4, '0')}`
    })()
  })
}

async function startRun(prompt: string, submissionId: string): Promise<string> {
  const run = await core.acceptRun({
    submissionId,
    sessionId,
    prompt,
    configuration: {
      harness: 'codex',
      executable: '/usr/local/bin/codex',
      executableHash: 'a'.repeat(64),
      harnessVersion: 'codex-cli 0.146.0',
      model: 'gpt-5-codex',
      effort: 'medium',
      skill: { name: 'grilling', path: '/home/.agents/skills/grilling', hash: 'b'.repeat(64) },
      environment: {},
      checkout: projectRoot,
      permissionMode: 'ask'
    }
  })
  await core.beginConversationRun({
    sessionId,
    runId: run.id,
    submissionId,
    harness: 'codex',
    skill: 'grilling',
    model: 'gpt-5-codex',
    askedPermissionMode: 'bypassPermissions'
  })
  return run.id
}

async function stream(runId: string, events: HarnessEvent[]): Promise<void> {
  for (const event of events) {
    await core.applyHarnessEvent({ sessionId, runId, event })
  }
}

function messages(entries: ConversationEntry[]): Extract<ConversationEntry, { kind: 'message' }>[] {
  return entries.filter((entry) => entry.kind === 'message')
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'session-conversation-state-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'session-conversation-project-'))
  core = makeCore()
  await core.addProject(projectRoot)
  const session = await core.startSession({ projectRoot, message: STARTING_MESSAGE })
  sessionId = session.id
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

describe('submitting to the Conversation', () => {
  it('starts with the message that created the Session and nothing else', async () => {
    const snapshot = await core.getConversation(sessionId)
    expect(messages(snapshot.entries)).toMatchObject([{ role: 'user', text: STARTING_MESSAGE }])
    expect(snapshot.activeRunId).toBeNull()
    expect(snapshot.usage.session.totalTokens).toBe(0)
  })

  it('accepts the user message locally before any Harness is contacted', async () => {
    const snapshot = await core.submitConversationMessage({
      sessionId,
      submissionId: 'submission-1',
      text: 'Grill me about this Session',
      source: 'composer'
    })
    expect(messages(snapshot.entries)).toMatchObject([
      { role: 'user', text: STARTING_MESSAGE },
      {
        role: 'user',
        text: 'Grill me about this Session',
        completeness: 'complete',
        source: 'composer',
        submissionId: 'submission-1'
      }
    ])
    expect(snapshot.activeRunId).toBeNull()
  })

  it('records a Suggested Response as an ordinary readable user message', async () => {
    const snapshot = await core.submitConversationMessage({
      sessionId,
      submissionId: 'submission-1',
      text: 'Solo freelancers who invoice a handful of clients.',
      source: 'suggested-response'
    })
    expect(messages(snapshot.entries)).toMatchObject([
      { role: 'user', text: STARTING_MESSAGE },
      {
        role: 'user',
        text: 'Solo freelancers who invoice a handful of clients.',
        source: 'suggested-response'
      }
    ])
  })

  it('is idempotent for a resent submission id', async () => {
    const input = {
      sessionId,
      submissionId: 'submission-1',
      text: 'Grill me',
      source: 'composer' as const
    }
    await core.submitConversationMessage(input)
    const snapshot = await core.submitConversationMessage(input)
    // The starting message, and the resent one recorded once.
    expect(messages(snapshot.entries)).toHaveLength(2)
  })

  it('rejects reusing a submission id for different content', async () => {
    await core.submitConversationMessage({
      sessionId,
      submissionId: 'submission-1',
      text: 'Grill me',
      source: 'composer'
    })
    await expect(
      core.submitConversationMessage({
        sessionId,
        submissionId: 'submission-1',
        text: 'Something else',
        source: 'composer'
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('streaming a Run into the Conversation', () => {
  beforeEach(async () => {
    await core.submitConversationMessage({
      sessionId,
      submissionId: 'submission-1',
      text: 'Grill me',
      source: 'composer'
    })
  })

  it('marks the Run boundary and reports the Run as active', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    const snapshot = await core.getConversation(sessionId)
    expect(snapshot.activeRunId).toBe(runId)
    expect(snapshot.entries.at(-1)).toMatchObject({
      kind: 'boundary',
      boundary: 'run-started',
      runId
    })
  })

  it('accumulates streamed text into one complete assistant message', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await stream(runId, [
      { type: 'assistant-message', id: 'item_0', text: 'Who ', complete: false },
      { type: 'assistant-message', id: 'item_0', text: 'Who is this for?', complete: true }
    ])
    await core.finalizeConversationRun({
      sessionId,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Harness process completed'
    })
    const snapshot = await core.getConversation(sessionId)
    expect(messages(snapshot.entries).at(-1)).toMatchObject({
      role: 'assistant',
      text: 'Who is this for?',
      completeness: 'complete'
    })
    expect(snapshot.activeRunId).toBeNull()
  })

  it('keeps a stopped Run’s partial text and labels it partial', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await stream(runId, [
      { type: 'assistant-message', id: 'item_0', text: 'Who is this f', complete: false }
    ])
    await core.finalizeConversationRun({
      sessionId,
      runId,
      outcome: 'stopped',
      category: null,
      summary: 'Run stopped by user'
    })
    const snapshot = await core.getConversation(sessionId)
    expect(messages(snapshot.entries).at(-1)).toMatchObject({
      role: 'assistant',
      text: 'Who is this f',
      completeness: 'partial'
    })
    expect(snapshot.recovery).toMatchObject({ category: 'stopped' })
  })

  it('attaches Harness-native structured choices as Suggested Responses', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await stream(runId, [
      { type: 'assistant-message', id: 'item_0', text: 'Who is this for?', complete: true },
      {
        type: 'choices',
        question: 'Who is this for?',
        options: [{ id: 'option-1', label: 'Solo freelancers', value: 'Solo freelancers.' }]
      }
    ])
    await core.finalizeConversationRun({
      sessionId,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Harness process completed'
    })
    const snapshot = await core.getConversation(sessionId)
    expect(messages(snapshot.entries).at(-1)?.suggestedResponses).toEqual([
      { id: 'option-1', label: 'Solo freelancers', value: 'Solo freelancers.' }
    ])
  })

  it('does not turn an ambiguous prose list into Suggested Responses', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await stream(runId, [
      {
        type: 'assistant-message',
        id: 'item_0',
        text: 'Pick one:\n1. Solo freelancers\n2. Small agencies\n3. Something else',
        complete: true
      }
    ])
    await core.finalizeConversationRun({
      sessionId,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Harness process completed'
    })
    const last = messages((await core.getConversation(sessionId)).entries).at(-1)
    expect(last?.suggestedResponses).toEqual([])
    expect(last?.plainOptions).toBe(true)
  })

  it('keeps reasoning summaries and tool activity out of Conversation content', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await stream(runId, [
      { type: 'reasoning', summary: 'Reading the Session first.' },
      { type: 'tool', name: 'app.read_file', summary: 'Read file source.ts' },
      { type: 'assistant-message', id: 'item_0', text: 'Who is this for?', complete: true }
    ])
    await core.finalizeConversationRun({
      sessionId,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Harness process completed'
    })
    const said = (await core.getConversation(sessionId)).entries.map((entry) =>
      entry.kind === 'message' ? entry.text : entry.kind === 'boundary' ? entry.summary : ''
    )
    expect(said).toContain('Who is this for?')
    expect(said.join('\n')).not.toContain('Reading the Session first.')
    expect(said.join('\n')).not.toContain('read_file')
  })

  it('keeps every assistant message a Run produced, in order', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await stream(runId, [
      { type: 'assistant-message', id: 'item_0', text: 'Let me read the notes.', complete: true },
      { type: 'assistant-message', id: 'item_2', text: 'Who is this for?', complete: true }
    ])
    await core.finalizeConversationRun({
      sessionId,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Harness process completed'
    })
    const assistant = messages((await core.getConversation(sessionId)).entries).filter(
      (entry) => entry.role === 'assistant'
    )
    expect(assistant.map((entry) => entry.text)).toEqual([
      'Let me read the notes.',
      'Who is this for?'
    ])
  })

  it('attaches structured choices to the newest message of the Run', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await stream(runId, [
      { type: 'assistant-message', id: 'item_0', text: 'Let me read the notes.', complete: true },
      { type: 'assistant-message', id: 'item_2', text: 'Who is this for?', complete: true },
      {
        type: 'choices',
        question: 'Who is this for?',
        options: [{ id: 'option-1', label: 'Solo freelancers', value: 'Solo freelancers.' }]
      }
    ])
    await core.finalizeConversationRun({
      sessionId,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Harness process completed'
    })
    const assistant = messages((await core.getConversation(sessionId)).entries).filter(
      (entry) => entry.role === 'assistant'
    )
    expect(assistant.at(-1)?.suggestedResponses).toHaveLength(1)
    expect(assistant.at(0)?.suggestedResponses).toEqual([])
  })

  it('reports Harness usage per Run and per Session as informational totals', async () => {
    const first = await startRun('Grill me', 'submission-1')
    await stream(first, [
      {
        type: 'usage',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          contextWindow: 272_000,
          contextUsed: 120
        }
      }
    ])
    await core.finalizeConversationRun({
      sessionId,
      runId: first,
      outcome: 'completed',
      category: null,
      summary: 'Harness process completed'
    })
    await core.submitConversationMessage({
      sessionId,
      submissionId: 'submission-2',
      text: 'Small agencies.',
      source: 'suggested-response'
    })
    const second = await startRun('Small agencies.', 'submission-2')
    await stream(second, [
      {
        type: 'usage',
        usage: {
          inputTokens: 300,
          outputTokens: 40,
          totalTokens: 340,
          contextWindow: 272_000,
          contextUsed: 340
        }
      }
    ])
    const snapshot = await core.getConversation(sessionId)
    expect(snapshot.usage.run).toMatchObject({ totalTokens: 340, contextUsed: 340 })
    expect(snapshot.usage.session).toMatchObject({ totalTokens: 460, contextWindow: 272_000 })
  })

  it('keeps the Harness Thread as separate durable state', async () => {
    const runId = await startRun('Develop this', 'submission-1')
    await stream(runId, [
      {
        type: 'thread-ready',
        harness: 'codex',
        threadId: 'thread-1',
        model: 'gpt-5-codex'
      },
      { type: 'completed' }
    ])
    const snapshot = await core.getConversation(sessionId)
    expect(snapshot.harnessThreads).toEqual({ codex: 'thread-1' })
    expect(snapshot.entries.some((entry) => entry.kind === 'thread')).toBe(false)
  })
})

describe('ingesting raw Harness output', () => {
  beforeEach(async () => {
    await core.submitConversationMessage({
      sessionId,
      submissionId: 'submission-1',
      text: 'Grill me',
      source: 'composer'
    })
  })

  it('turns Codex protocol into Conversation content across split chunks', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    const lines = [
      '{"method":"item/agentMessage/delta","params":{"itemId":"item_0","delta":"Who is "}}\n{"method":"item/compl',
      'eted","params":{"item":{"id":"item_0","type":"agentMessage","text":"Who is this for?"}}}\n{"method":"turn/completed","params":{}}\n'
    ]
    const seen = []
    for (const chunk of lines) {
      const stream = await core.ingestHarnessOutput({
        sessionId,
        runId,
        harness: 'codex',
        chunk
      })
      seen.push(...stream.events)
    }
    expect(seen.at(-1)).toEqual({ type: 'completed' })
    await core.finalizeConversationRun({
      sessionId,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Harness process completed'
    })
    expect(messages((await core.getConversation(sessionId)).entries).at(-1)).toMatchObject({
      role: 'assistant',
      text: 'Who is this for?',
      completeness: 'complete'
    })
  })

  it('says the Harness spoke unreadably rather than showing an empty Conversation', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    // A Harness whose protocol this app does not model: the process is
    // perfectly happy and exits zero, but nothing usable ever arrives.
    await core.ingestHarnessOutput({
      sessionId,
      runId,
      harness: 'codex',
      chunk: '{"type":"some.future.event"}\n{"type":"another.one"}\n'
    })
    await core.finalizeConversationRun({
      sessionId,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Harness process completed'
    })
    expect((await core.getConversation(sessionId)).recovery).toMatchObject({
      category: 'protocol-unsupported'
    })
  })

  it('stays silent when a Run it could read completes normally', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await core.ingestHarnessOutput({
      sessionId,
      runId,
      harness: 'codex',
      chunk:
        '{"method":"item/completed","params":{"item":{"id":"item_0","type":"agentMessage","text":"Who is this for?"}}}\n'
    })
    await core.finalizeConversationRun({
      sessionId,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Harness process completed'
    })
    expect((await core.getConversation(sessionId)).recovery).toBeNull()
  })

  it('reports what the Harness said rather than blaming its protocol', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    // Unmodelled protocol arrived, but the Harness also said why it failed.
    // The stated cause is the one the person can act on.
    await core.ingestHarnessOutput({
      sessionId,
      runId,
      harness: 'codex',
      chunk: '{"type":"some.future.event"}\n'
    })
    await core.finalizeConversationRun({
      sessionId,
      runId,
      outcome: 'failed',
      category: 'authentication',
      summary: 'The Harness reports it is no longer signed in'
    })
    expect((await core.getConversation(sessionId)).recovery).toMatchObject({
      category: 'authentication'
    })
  })

  it('keeps a stop a stop, whatever protocol arrived first', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await core.ingestHarnessOutput({
      sessionId,
      runId,
      harness: 'codex',
      chunk: '{"type":"some.future.event"}\n'
    })
    await core.finalizeConversationRun({
      sessionId,
      runId,
      outcome: 'stopped',
      category: null,
      summary: 'Run stopped by user'
    })
    expect((await core.getConversation(sessionId)).recovery).toMatchObject({
      category: 'stopped'
    })
  })

  it('gives Claude the same durable Conversation behavior as Codex', async () => {
    const run = await core.acceptRun({
      submissionId: 'submission-1',
      sessionId,
      prompt: 'Develop this',
      configuration: {
        harness: 'claude',
        executable: '/usr/local/bin/claude',
        executableHash: 'a'.repeat(64),
        harnessVersion: '2.1.220',
        model: 'claude-sonnet-4-5',
        effort: 'medium',
        skill: { name: 'wayfinder', path: '/home/.claude/skills/wayfinder', hash: 'b'.repeat(64) },
        environment: {},
        checkout: projectRoot,
        permissionMode: 'ask'
      }
    })
    await core.beginConversationRun({
      sessionId,
      runId: run.id,
      submissionId: 'submission-1',
      harness: 'claude',
      skill: 'wayfinder',
      model: 'claude-sonnet-4-5'
    })
    const runId = run.id
    const seen = await core.ingestHarnessOutput({
      sessionId,
      runId,
      harness: 'claude',
      chunk:
        '{"type":"system","subtype":"init","session_id":"thread-1","model":"claude-sonnet-4-5"}\n{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"What decision is blocking this Session?"}],"usage":{"input_tokens":10,"output_tokens":7}}}\n{"type":"result","subtype":"success","is_error":false,"result":"What decision is blocking this Session?","usage":{"input_tokens":10,"output_tokens":7}}\n'
    })
    expect(seen.events.at(-1)).toEqual({ type: 'completed' })
    await core.finalizeConversationRun({
      sessionId,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Harness process completed'
    })
    expect(messages((await core.getConversation(sessionId)).entries).at(-1)).toMatchObject({
      role: 'assistant',
      text: 'What decision is blocking this Session?',
      completeness: 'complete'
    })
  })
})

describe('recovering from a Run that ended badly', () => {
  beforeEach(async () => {
    await core.submitConversationMessage({
      sessionId,
      submissionId: 'submission-1',
      text: 'Grill me',
      source: 'composer'
    })
  })

  it('offers a safe resend after authentication loss', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await stream(runId, [{ type: 'assistant-message', id: 'item_0', text: 'Who', complete: false }])
    await core.finalizeConversationRun({
      sessionId,
      runId,
      outcome: 'failed',
      category: 'authentication',
      summary: 'The Harness reports it is no longer signed in'
    })
    const snapshot = await core.getConversation(sessionId)
    expect(snapshot.recovery).toMatchObject({
      category: 'authentication',
      resumableSubmissionId: 'submission-1'
    })
    expect(messages(snapshot.entries).at(-1)).toMatchObject({ completeness: 'partial' })
  })

  it('does not offer a resend when the context window is exhausted', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await stream(runId, [{ type: 'assistant-message', id: 'item_0', text: 'Who', complete: false }])
    await core.finalizeConversationRun({
      sessionId,
      runId,
      outcome: 'failed',
      category: 'context-exhausted',
      summary: 'The Run ran out of context'
    })
    expect((await core.getConversation(sessionId)).recovery).toMatchObject({
      category: 'context-exhausted',
      resumableSubmissionId: null
    })
  })

  it('calls a failure with no Harness output an uncertain submission', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await core.finalizeConversationRun({
      sessionId,
      runId,
      outcome: 'failed',
      category: 'process-crash',
      summary: 'Harness process failed'
    })
    expect((await core.getConversation(sessionId)).recovery).toMatchObject({
      category: 'uncertain-submission',
      resumableSubmissionId: 'submission-1'
    })
  })

  it('clears the previous recovery once the next Run starts', async () => {
    const first = await startRun('Grill me', 'submission-1')
    await core.finalizeConversationRun({
      sessionId,
      runId: first,
      outcome: 'failed',
      category: 'rate-limit',
      summary: 'The Harness is rate limiting this account'
    })
    await core.submitConversationMessage({
      sessionId,
      submissionId: 'submission-2',
      text: 'Try again',
      source: 'composer'
    })
    await startRun('Try again', 'submission-2')
    expect((await core.getConversation(sessionId)).recovery).toBeNull()
  })

  it('keeps history readable after a crash mid-stream', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await stream(runId, [
      { type: 'assistant-message', id: 'item_0', text: 'Who is this f', complete: false }
    ])
    // A crash means nothing finalizes the Run: a fresh Core must still read
    // the durable history and see the interrupted work labelled.
    const restarted = makeCore()
    const snapshot = await restarted.getConversation(sessionId)
    expect(messages(snapshot.entries).at(-1)).toMatchObject({
      role: 'assistant',
      text: 'Who is this f',
      completeness: 'partial'
    })
    expect(snapshot.activeRunId).toBe(runId)
  })
})

describe('file changes', () => {
  it('keeps what a Run changed in the Conversation across a reload', async () => {
    const runId = await startRun('Rename the greeting', 'submission-change')
    await core.applyHarnessEvent({
      sessionId,
      runId,
      event: {
        type: 'file-change',
        path: '/tmp/a-project/greeting.ts',
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ['-const a = 1', '+const a = 2']
          }
        ]
      }
    })

    // The Checkout records the change; the Conversation records the Run having
    // made it, and both outlive the process that watched it happen.
    const reloaded = await makeCore().getConversation(sessionId)
    expect(reloaded.entries.filter((entry) => entry.kind === 'file-change')).toMatchObject([
      { path: '/tmp/a-project/greeting.ts', runId }
    ])
  })
})

describe('file change identity', () => {
  it('keeps every change when the process restarts part-way through a Run', async () => {
    const runId = await startRun('Rename twice', 'submission-restart')
    const change = (line: string): Parameters<Core['applyHarnessEvent']>[0] => ({
      sessionId,
      runId,
      event: {
        type: 'file-change',
        path: '/tmp/a-project/greeting.ts',
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [line] }]
      }
    })

    await core.applyHarnessEvent(change('+first'))
    // A restart loses whatever was only in memory. The change already written
    // must survive the one written after it.
    await makeCore().applyHarnessEvent(change('+second'))

    const reloaded = await makeCore().getConversation(sessionId)
    const changes = reloaded.entries.filter((entry) => entry.kind === 'file-change')
    expect(changes).toHaveLength(2)
  })
})

describe('what this Session changed', () => {
  const hunk = (lines: string[]): DiffHunk => ({
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: lines.length,
    lines
  })

  it('gathers one row per file across every Run, counting what it did to each', async () => {
    const first = await startRun('Rename the greeting', 'submission-one')
    await core.applyHarnessEvent({
      sessionId,
      runId: first,
      event: {
        type: 'file-change',
        path: `${projectRoot}/greeting.ts`,
        hunks: [hunk(['-const a = 1', '+const a = 2'])]
      }
    })
    await core.applyHarnessEvent({
      sessionId,
      runId: first,
      event: {
        type: 'file-change',
        path: `${projectRoot}/README.md`,
        hunks: [hunk(['+Now with greetings'])]
      }
    })
    await core.finalizeConversationRun({
      sessionId,
      runId: first,
      outcome: 'completed',
      category: null,
      summary: 'Harness process completed'
    })

    // A second Run touching the same file is the same file, not a second row.
    const second = await startRun('And again', 'submission-two')
    await core.applyHarnessEvent({
      sessionId,
      runId: second,
      event: {
        type: 'file-change',
        path: `${projectRoot}/greeting.ts`,
        hunks: [hunk(['+const b = 3'])]
      }
    })

    const changed = (await makeCore().getConversation(sessionId)).changedFiles
    expect(changed).toMatchObject([
      { path: 'greeting.ts', changes: 2, added: 2, removed: 1 },
      { path: 'README.md', changes: 1, added: 1, removed: 0 }
    ])
  })

  it('reports nothing for a Session whose agent changed nothing', async () => {
    const runId = await startRun('Just have a look', 'submission-look')
    await core.applyHarnessEvent({
      sessionId,
      runId,
      event: { type: 'assistant-message', id: 'msg_1', text: 'Looks fine.', complete: true }
    })

    expect((await core.getConversation(sessionId)).changedFiles).toEqual([])
  })

  it('counts the whole change, not the part of the diff it kept', async () => {
    // A long diff is shortened before it is stored. Counting what survived
    // would report a smaller change than the one that actually happened.
    const runId = await startRun('Rewrite it all', 'submission-long')
    const long = Array.from({ length: 500 }, (_, index) => `+line ${String(index)}`)
    await core.applyHarnessEvent({
      sessionId,
      runId,
      event: {
        type: 'file-change',
        path: `${projectRoot}/generated.ts`,
        hunks: [hunk(long)]
      }
    })

    const [file] = (await makeCore().getConversation(sessionId)).changedFiles
    expect(file).toMatchObject({ path: 'generated.ts', added: 500, removed: 0 })
  })

  it('reports only what the agent changed, never what was already dirty', async () => {
    // The Checkout is edited in place (ADR 0004), so a Project the person had
    // already been working in would hand `git diff` their edits as the
    // agent's. This record comes from what the Harness reported instead — so
    // this passes by construction today, and stands as the guard against
    // anybody later reaching for the repository to answer this.
    await writeFile(join(projectRoot, 'mine.ts'), 'export const mine = true')
    const runId = await startRun('Change yours', 'submission-dirty')
    await core.applyHarnessEvent({
      sessionId,
      runId,
      event: {
        type: 'file-change',
        path: `${projectRoot}/theirs.ts`,
        hunks: [hunk(['+export const theirs = true'])]
      }
    })

    const changed = (await core.getConversation(sessionId)).changedFiles
    expect(changed.map((file) => file.path)).toEqual(['theirs.ts'])
  })
})

describe('what a diff is allowed to carry', () => {
  it('redacts a credential the Harness has just written into a file', async () => {
    const runId = await startRun('Add the key', 'submission-secret')
    await core.applyHarnessEvent({
      sessionId,
      runId,
      event: {
        type: 'file-change',
        path: `${projectRoot}/.env`,
        hunks: [
          {
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: ['+OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789']
          }
        ]
      }
    })

    const stored = await readFile(
      join(stateDir, 'sessions', sessionId, 'conversation.jsonl'),
      'utf8'
    )
    // A diff is Conversation content like any other, and it is the one kind
    // that carries whatever the Harness just wrote.
    expect(stored).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789')
    // The path is relative to the Checkout, so it cannot leak a home directory.
    expect(stored).not.toContain(projectRoot)
    const snapshot = await core.getConversation(sessionId)
    expect(snapshot.entries.filter((entry) => entry.kind === 'file-change')).toMatchObject([
      { path: '.env' }
    ])
  })
})

describe('commands in the Conversation', () => {
  it('keeps what a command printed, redacted and bounded', async () => {
    const runId = await startRun('Run the tests', 'submission-command')
    await core.applyHarnessEvent({
      sessionId,
      runId,
      event: {
        type: 'command',
        id: 'toolu_1',
        command: 'pnpm test',
        output: `token=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\n${'log line\n'.repeat(5_000)}`,
        failed: false,
        running: false
      }
    })

    const stored = await readFile(
      join(stateDir, 'sessions', sessionId, 'conversation.jsonl'),
      'utf8'
    )
    // A command prints whatever it prints, including secrets, and a build log
    // must not be able to displace the Conversation around it.
    expect(stored).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789')
    const reloaded = await makeCore().getConversation(sessionId)
    const commands = reloaded.entries.filter((entry) => entry.kind === 'command')
    expect(commands).toMatchObject([{ command: 'pnpm test', failed: false, runId }])
    const [only] = commands
    if (only?.kind !== 'command') throw new Error('expected a command entry')
    expect(only.output.length).toBeLessThanOrEqual(16_100)
    // Says that something was dropped rather than pretending it is whole.
    expect(only.output).toContain('earlier output not kept')
  })
})

describe('the mode a Run really ran under', () => {
  it('records it in the Conversation when it is not the one that was asked for', async () => {
    const runId = await startRun('Change something', 'submission-mode')
    await core.applyHarnessEvent({
      sessionId,
      runId,
      event: {
        type: 'thread-ready',
        harness: 'codex',
        threadId: 'thread-1',
        model: 'a-model',
        // Managed settings can override what the app asked for. A Run whose
        // provenance says only what was chosen is a Run that lies about
        // itself.
        permissionMode: 'plan'
      }
    })

    const reloaded = await makeCore().getConversation(sessionId)
    const notices = reloaded.entries.filter(
      (entry) => entry.kind === 'boundary' && entry.summary.includes('plan')
    )
    expect(notices).toHaveLength(1)
  })
})

describe('a command from start to finish', () => {
  it('replaces the running command rather than recording it twice', async () => {
    const runId = await startRun('Run the tests', 'submission-running')
    const command = (patch: { output?: string; running: boolean }) =>
      core.applyHarnessEvent({
        sessionId,
        runId,
        event: {
          type: 'command',
          id: 'toolu_1',
          command: 'pnpm test',
          output: patch.output ?? '',
          failed: false,
          running: patch.running
        }
      })

    await command({ running: true })
    await command({ output: 'all good', running: false })

    const reloaded = await makeCore().getConversation(sessionId)
    const commands = reloaded.entries.filter((entry) => entry.kind === 'command')
    // One command happened, so the Conversation shows one — finished.
    expect(commands).toMatchObject([{ command: 'pnpm test', output: 'all good', running: false }])
  })
})

describe('an approval from request to answer', () => {
  const request: Extract<HarnessEvent, { type: 'approval-request' }> = {
    type: 'approval-request',
    id: 'toolu_approve_1',
    tool: 'Bash',
    summary: 'pnpm test',
    detail: '{"command":"pnpm test"}',
    proposedRule: { harness: 'claude', kind: 'command', toolName: 'Bash', content: 'pnpm test:*' }
  }

  it('blocks the Run on the request and leaves that state when it is answered', async () => {
    const runId = await startRun('Run the tests', 'submission-approval')

    await stream(runId, [request])
    const blocked = await makeCore().getConversation(sessionId)
    expect(blocked.pendingApprovalId).toBe(`approval:${runId}:toolu_approve_1`)

    await stream(runId, [
      {
        type: 'approval-resolved',
        id: 'toolu_approve_1',
        decision: 'allowed',
        message: '',
        remembered: false
      }
    ])
    const resolved = await makeCore().getConversation(sessionId)
    expect(resolved.pendingApprovalId).toBeNull()
    // One request happened, so the Conversation holds one — answered.
    expect(resolved.entries.filter((entry) => entry.kind === 'approval')).toMatchObject([
      { tool: 'Bash', summary: 'pnpm test', decision: 'allowed' }
    ])
  })

  it('keeps the message the agent was denied with', async () => {
    const runId = await startRun('Delete everything', 'submission-denied')
    await stream(runId, [
      request,
      {
        type: 'approval-resolved',
        id: 'toolu_approve_1',
        decision: 'denied',
        message: 'Run the unit tests instead',
        remembered: false
      }
    ])

    const reloaded = await makeCore().getConversation(sessionId)
    expect(reloaded.entries.filter((entry) => entry.kind === 'approval')).toMatchObject([
      { decision: 'denied', message: 'Run the unit tests instead' }
    ])
  })

  it('redacts and bounds what the request carries, as any other durable content', async () => {
    const runId = await startRun('Call the API', 'submission-secret')
    await stream(runId, [
      {
        ...request,
        summary: 'curl -H "api_key: sk-live-1234567890"',
        detail: 'x'.repeat(9_000)
      }
    ])

    const [approval] = (await makeCore().getConversation(sessionId)).entries.filter(
      (entry) => entry.kind === 'approval'
    )
    if (approval?.kind !== 'approval') throw new Error('expected an approval entry')
    expect(approval.summary).not.toContain('sk-live-1234567890')
    expect(approval.detail.length).toBeLessThanOrEqual(4_000)
  })

  it('keeps the rule the person was offered, and says when they took it', async () => {
    const runId = await startRun('Run the tests', 'submission-remembered')
    await stream(runId, [
      request,
      {
        type: 'approval-resolved',
        id: 'toolu_approve_1',
        decision: 'allowed',
        message: '',
        remembered: true
      }
    ])

    // The Conversation is where the person can go back and read exactly what
    // they granted, which matters most for the grants that never ask again.
    expect(
      (await makeCore().getConversation(sessionId)).entries.filter(
        (entry) => entry.kind === 'approval'
      )
    ).toMatchObject([
      {
        decision: 'allowed',
        remembered: true,
        proposedRule: {
          harness: 'claude',
          kind: 'command',
          toolName: 'Bash',
          content: 'pnpm test:*'
        }
      }
    ])
  })

  it('settles an unanswered request when the Run ends, so nothing reads as allowed', async () => {
    const runId = await startRun('Run the tests', 'submission-abandoned')
    await stream(runId, [request])

    await core.finalizeConversationRun({
      sessionId,
      runId,
      outcome: 'stopped',
      category: null,
      summary: 'Run stopped by user'
    })

    const reloaded = await makeCore().getConversation(sessionId)
    expect(reloaded.pendingApprovalId).toBeNull()
    expect(reloaded.entries.filter((entry) => entry.kind === 'approval')).toMatchObject([
      { decision: 'abandoned' }
    ])
    // The Session is left usable rather than stuck behind a dead request.
    expect(reloaded.activeRunId).toBeNull()
  })
})
