import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  ConversationEntry,
  CheckoutChange,
  DiffHunk,
  HarnessEvent,
  PlanStep,
  SubagentStatus
} from '@shared/conversation'
import { createCore, type Core } from './core'
import { finishRunLifecycle } from './run-lifecycle-test-support'

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
  const opened = await core.openRunLifecycle({
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
    },
    askedPermissionMode: 'bypassPermissions'
  })
  await core.recordRunEvent({
    sessionId,
    runId: opened.run.id,
    status: 'starting',
    kind: 'lifecycle',
    summary: 'Starting the Harness'
  })
  await core.recordRunEvent({
    sessionId,
    runId: opened.run.id,
    status: 'running',
    kind: 'lifecycle',
    summary: 'Harness process running'
  })
  return opened.run.id
}

const finishRun = (input: Parameters<typeof finishRunLifecycle>[1], changes?: CheckoutChange[]) =>
  finishRunLifecycle(core, input, changes)

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
    expect(snapshot.journalPosition).toBeGreaterThan(0)
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

describe('durable Queued Submissions', () => {
  const queued = (submissionId: string, text: string) => ({
    sessionId,
    submissionId,
    text,
    source: 'composer' as const,
    harness: 'codex' as const,
    model: 'gpt-5-codex',
    effort: 'medium',
    skill: 'grilling',
    permissionMode: 'ask' as const,
    reviewAttachments: []
  })

  it('projects FIFO items from replacement entries and survives a Core restart', async () => {
    await core.changeQueuedSubmissions({
      type: 'enqueue',
      input: queued('queued-1', 'First queued message')
    })
    await core.changeQueuedSubmissions({
      type: 'enqueue',
      input: queued('queued-2', 'Second queued message')
    })
    await core.changeQueuedSubmissions({
      type: 'move',
      input: { sessionId, submissionId: 'queued-2', direction: 'earlier' }
    })
    await core.changeQueuedSubmissions({
      type: 'edit',
      input: { sessionId, submissionId: 'queued-2', text: 'Edited second message' }
    })

    core = makeCore()
    const snapshot = await core.getConversation(sessionId)
    expect(snapshot.queue.paused).toBe(true)
    expect(snapshot.queue.items).toMatchObject([
      {
        submissionId: 'queued-2',
        text: 'Edited second message',
        status: 'pending',
        controls: { edit: true, moveEarlier: false, moveLater: true, cancel: true }
      },
      {
        submissionId: 'queued-1',
        text: 'First queued message',
        status: 'pending',
        controls: { edit: true, moveEarlier: true, moveLater: false, cancel: true }
      }
    ])
    expect(snapshot.queue.outcome).toMatchObject({
      type: 'edited',
      submissionId: 'queued-2'
    })
  })

  it('atomically claims the FIFO item and admits its user message once', async () => {
    await core.changeQueuedSubmissions({
      type: 'enqueue',
      input: queued('queued-1', 'First queued message')
    })
    await core.changeQueuedSubmissions({
      type: 'enqueue',
      input: queued('queued-2', 'Second queued message')
    })
    await core.changeQueuedSubmissions({ type: 'resume', sessionId })

    const first = (await core.nextQueuedSubmission(sessionId))?.item
    const replay = (await core.nextQueuedSubmission(sessionId))?.item
    const snapshot = await core.getConversation(sessionId)

    expect(first).toMatchObject({ submissionId: 'queued-1', status: 'claimed' })
    expect(replay).toMatchObject({ submissionId: 'queued-1', status: 'claimed' })
    expect(
      messages(snapshot.entries).filter((entry) => entry.submissionId === 'queued-1')
    ).toHaveLength(1)
    expect(snapshot.queue.items).toMatchObject([
      {
        submissionId: 'queued-1',
        status: 'claimed',
        controls: { edit: false, moveEarlier: false, moveLater: false, cancel: false }
      },
      { submissionId: 'queued-2', status: 'pending' }
    ])
  })

  it('prioritizes Send now atomically without disturbing the other FIFO positions', async () => {
    await core.changeQueuedSubmissions({
      type: 'enqueue',
      input: queued('queued-1', 'First queued message')
    })
    await core.changeQueuedSubmissions({
      type: 'enqueue',
      input: queued('queued-2', 'Second queued message')
    })
    await core.changeQueuedSubmissions({
      type: 'enqueue',
      input: queued('queued-3', 'Third queued message')
    })

    const snapshot = await core.changeQueuedSubmissions({
      type: 'send-now',
      input: { sessionId, submissionId: 'queued-3' }
    })

    expect(snapshot.queue.items.map((item) => item.submissionId)).toEqual([
      'queued-3',
      'queued-1',
      'queued-2'
    ])
  })

  it('makes a pre-launch failure editable and claimable again', async () => {
    await core.changeQueuedSubmissions({
      type: 'enqueue',
      input: queued('queued-1', 'Original queued message')
    })
    await core.changeQueuedSubmissions({ type: 'resume', sessionId })
    await core.nextQueuedSubmission(sessionId)
    await core.observeQueuedSubmissionLaunch({
      sessionId,
      submissionId: 'queued-1',
      outcome: 'not-started'
    })
    await core.changeQueuedSubmissions({
      type: 'edit',
      input: { sessionId, submissionId: 'queued-1', text: 'Edited after launch failed' }
    })
    await core.changeQueuedSubmissions({ type: 'resume', sessionId })

    const claimed = (await core.nextQueuedSubmission(sessionId))?.item
    const snapshot = await core.getConversation(sessionId)
    expect(claimed).toMatchObject({ text: 'Edited after launch failed', status: 'claimed' })
    expect(
      messages(snapshot.entries).filter((entry) => entry.submissionId === 'queued-1')
    ).toMatchObject([{ text: 'Edited after launch failed' }])
  })

  it('owns the durable disposition after Main reports that no Harness started', async () => {
    await core.changeQueuedSubmissions({
      type: 'enqueue',
      input: queued('queued-1', 'Try this when ready')
    })
    await core.changeQueuedSubmissions({ type: 'resume', sessionId })
    await core.nextQueuedSubmission(sessionId)

    const result = await core.observeQueuedSubmissionLaunch({
      sessionId,
      submissionId: 'queued-1',
      outcome: 'not-started'
    })
    const snapshot = await core.getConversation(sessionId)

    expect(result).toEqual({ continueDraining: false })
    expect(snapshot.queue).toMatchObject({
      paused: true,
      outcome: { type: 'launch-paused', submissionId: 'queued-1' },
      items: [
        {
          submissionId: 'queued-1',
          status: 'pending',
          controls: { edit: true, cancel: true, sendNow: true }
        }
      ]
    })
  })

  it('lets a restarted paused queue edit and reorder a recovered claim', async () => {
    await core.changeQueuedSubmissions({
      type: 'enqueue',
      input: queued('queued-1', 'Claimed before crash')
    })
    await core.changeQueuedSubmissions({
      type: 'enqueue',
      input: queued('queued-2', 'Still pending')
    })
    await core.changeQueuedSubmissions({ type: 'resume', sessionId })
    await core.nextQueuedSubmission(sessionId)

    core = makeCore()
    await core.changeQueuedSubmissions({
      type: 'edit',
      input: { sessionId, submissionId: 'queued-1', text: 'Edited after restart' }
    })
    const moved = await core.changeQueuedSubmissions({
      type: 'move',
      input: { sessionId, submissionId: 'queued-1', direction: 'later' }
    })

    expect(moved.queue.paused).toBe(true)
    expect(moved.queue.items).toMatchObject([
      { submissionId: 'queued-2', status: 'pending' },
      { submissionId: 'queued-1', text: 'Edited after restart', status: 'pending' }
    ])
  })

  it('keeps terminal replacements and enforces the fifty-item limit', async () => {
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        core.changeQueuedSubmissions({
          type: 'enqueue',
          input: queued(`queued-${String(index)}`, `Message ${String(index)}`)
        })
      )
    )
    await expect(
      core.changeQueuedSubmissions({
        type: 'enqueue',
        input: queued('queued-overflow', 'One too many')
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    await core.changeQueuedSubmissions({
      type: 'cancel',
      input: { sessionId, submissionId: 'queued-0' }
    })
    await core.changeQueuedSubmissions({
      type: 'enqueue',
      input: queued('queued-replacement', 'Replacement')
    })
    const snapshot = await core.getConversation(sessionId)
    expect(snapshot.queue.items.find((item) => item.submissionId === 'queued-0')).toMatchObject({
      status: 'cancelled'
    })
  })
})

describe('Review Attachments on durable submissions', () => {
  const snapshotOf = (lines: string[], id = 'file-change:run-1:1') => ({
    id,
    path: 'src/greeting.ts',
    runId: 'run-1',
    entryId: id,
    scope: 'hunk' as const,
    hunkIndex: 0,
    startLine: 1,
    endLine: lines.length,
    lines,
    shortened: false,
    capturedAt: '2026-07-31T12:00:00.000Z'
  })

  const attached = snapshotOf(['-const greeting = "hello"', '+const greeting = "goodbye"'])

  const queuedWith = (submissionId: string, reviewAttachments: (typeof attached)[]) => ({
    sessionId,
    submissionId,
    text: 'Make this shorter',
    source: 'composer' as const,
    harness: 'codex' as const,
    model: 'gpt-5-codex',
    effort: 'medium',
    skill: 'grilling',
    permissionMode: 'ask' as const,
    reviewAttachments
  })

  it('keeps the reviewed snapshot on the message it was sent with', async () => {
    await core.submitConversationMessage({
      sessionId,
      submissionId: 'submission-1',
      text: 'Make this shorter',
      source: 'composer',
      reviewAttachments: [attached]
    })

    core = makeCore()
    const snapshot = await core.getConversation(sessionId)
    const message = messages(snapshot.entries).find(
      (entry) => entry.submissionId === 'submission-1'
    )
    // The prose is the person's, unchanged: the snapshot travels beside it.
    expect(message?.text).toBe('Make this shorter')
    expect(message?.reviewAttachments).toEqual([attached])
  })

  it('reads a message written before attachments existed as carrying none', async () => {
    const snapshot = await core.getConversation(sessionId)
    const starting = messages(snapshot.entries)[0]

    expect(starting?.reviewAttachments).toEqual([])
  })

  it('refuses a submission identity reused for different reviewed code', async () => {
    await core.submitConversationMessage({
      sessionId,
      submissionId: 'submission-1',
      text: 'Make this shorter',
      source: 'composer',
      reviewAttachments: [attached]
    })

    await expect(
      core.submitConversationMessage({
        sessionId,
        submissionId: 'submission-1',
        text: 'Make this shorter',
        source: 'composer',
        reviewAttachments: [snapshotOf(['+const greeting = "hi"'])]
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('refuses a queued identity reused for different reviewed code', async () => {
    await core.changeQueuedSubmissions({
      type: 'enqueue',
      input: queuedWith('queued-1', [attached])
    })

    await expect(
      core.changeQueuedSubmissions({
        type: 'enqueue',
        input: queuedWith('queued-1', [snapshotOf(['+const greeting = "hi"'])])
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('refuses more selections than a message may carry, before anything is written', async () => {
    const many = Array.from({ length: 11 }, (_value, index) =>
      snapshotOf(['+line'], `file-change:run-1:${String(index)}`)
    )

    await expect(
      core.changeQueuedSubmissions({ type: 'enqueue', input: queuedWith('queued-1', many) })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect((await core.getConversation(sessionId)).queue.items).toHaveLength(0)
  })

  it('is idempotent for a resend carrying the same reviewed code', async () => {
    const input = {
      sessionId,
      submissionId: 'submission-1',
      text: 'Make this shorter',
      source: 'composer' as const,
      reviewAttachments: [attached]
    }
    await core.submitConversationMessage(input)
    const snapshot = await core.submitConversationMessage(input)

    expect(
      messages(snapshot.entries).filter((entry) => entry.text === 'Make this shorter')
    ).toHaveLength(1)
  })

  it('keeps a queued message an older build wrote, without the shape it once had', async () => {
    await core.changeQueuedSubmissions({ type: 'enqueue', input: queuedWith('queued-1', []) })
    const journal = join(stateDir, 'sessions', sessionId, 'conversation.jsonl')
    const entry = JSON.parse(
      (await readFile(journal, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id: string })
        .filter((parsed) => parsed.id === 'queued:queued-1')
        .map((parsed) => JSON.stringify(parsed))[0] ?? '{}'
    ) as Record<string, unknown>
    // What the previous build wrote there: a file path, not a snapshot.
    await writeFile(
      journal,
      `${await readFile(journal, 'utf8')}${JSON.stringify({
        ...entry,
        reviewAttachments: [{ path: 'src/greeting.ts', name: 'greeting.ts' }]
      })}\n`
    )

    core = makeCore()
    const snapshot = await core.getConversation(sessionId)
    // The message survives; only what it quoted, which was never a snapshot,
    // is gone.
    expect(snapshot.queue.items).toMatchObject([
      { submissionId: 'queued-1', reviewAttachments: [] }
    ])
  })

  it('carries the snapshot through edit, reorder, restart, claim and launch', async () => {
    await core.changeQueuedSubmissions({
      type: 'enqueue',
      input: queuedWith('queued-1', [attached])
    })
    await core.changeQueuedSubmissions({ type: 'enqueue', input: queuedWith('queued-2', []) })
    await core.changeQueuedSubmissions({
      type: 'edit',
      input: { sessionId, submissionId: 'queued-1', text: 'Actually, make this clearer' }
    })
    await core.changeQueuedSubmissions({
      type: 'move',
      input: { sessionId, submissionId: 'queued-1', direction: 'later' }
    })

    core = makeCore()
    await core.changeQueuedSubmissions({ type: 'resume', sessionId })
    // The reordered item is second, so drain past the one before it.
    await core.nextQueuedSubmission(sessionId)
    await core.observeQueuedSubmissionLaunch({
      sessionId,
      submissionId: 'queued-2',
      outcome: 'started'
    })
    const plan = await core.nextQueuedSubmission(sessionId)

    expect(plan?.item.reviewAttachments).toEqual([attached])
    // The Harness is told the prose and the snapshot; the Conversation keeps
    // only the prose.
    expect(plan?.prompt).toContain('Actually, make this clearer')
    expect(plan?.prompt).toContain('<reviewed-code count="1">')
    expect(plan?.prompt).toContain('+const greeting = "goodbye"')
    const admitted = messages((await core.getConversation(sessionId)).entries).find(
      (entry) => entry.submissionId === 'queued-1'
    )
    expect(admitted?.text).toBe('Actually, make this clearer')
    expect(admitted?.reviewAttachments).toEqual([attached])
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

  it('positions a live event immediately before the durable snapshot that contains it', async () => {
    const runId = await startRun('Track the event cursor', 'submission-1')
    const before = await core.getConversation(sessionId)

    const journalPosition = await core.applyHarnessEvent({
      sessionId,
      runId,
      event: { type: 'assistant-message', id: 'cursor-message', text: 'Settled', complete: true }
    })
    const after = await core.getConversation(sessionId)

    expect(journalPosition).toBe(before.journalPosition)
    expect(after.journalPosition).toBeGreaterThan(journalPosition)
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
    await finishRun({
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
    await finishRun({
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
    await finishRun({
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
    await finishRun({
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
    await finishRun({
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
    await finishRun({
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
    await finishRun({
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
    await finishRun({
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
    await finishRun({
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
    await finishRun({
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
    await finishRun({
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
    await finishRun({
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
    await finishRun({
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
    const opened = await core.openRunLifecycle({
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
    await core.recordRunEvent({
      sessionId,
      runId: opened.run.id,
      status: 'starting',
      kind: 'lifecycle',
      summary: 'Starting the Harness'
    })
    await core.recordRunEvent({
      sessionId,
      runId: opened.run.id,
      status: 'running',
      kind: 'lifecycle',
      summary: 'Harness process running'
    })
    const runId = opened.run.id
    const seen = await core.ingestHarnessOutput({
      sessionId,
      runId,
      harness: 'claude',
      chunk:
        '{"type":"system","subtype":"init","session_id":"thread-1","model":"claude-sonnet-4-5"}\n{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"What decision is blocking this Session?"}],"usage":{"input_tokens":10,"output_tokens":7}}}\n{"type":"result","subtype":"success","is_error":false,"result":"What decision is blocking this Session?","usage":{"input_tokens":10,"output_tokens":7}}\n'
    })
    expect(seen.events.at(-1)).toEqual({ type: 'completed' })
    await finishRun({
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
    await finishRun({
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
    await finishRun({
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
    await finishRun({
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
    await finishRun({
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
    await finishRun({
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

  it('adds what the Checkout comparison found and nobody reported', async () => {
    const runId = await startRun('Run the codemod', 'submission-codemod')
    await core.applyHarnessEvent({
      sessionId,
      runId,
      event: {
        type: 'file-change',
        path: `${projectRoot}/reported.ts`,
        hunks: [hunk(['+const a = 1'])]
      }
    })
    // What a shell command did: the Harness said nothing about either file.
    await finishRun(
      {
        sessionId,
        runId,
        outcome: 'completed',
        category: null,
        summary: 'Harness process completed'
      },
      [
        {
          path: 'reported.ts',
          changeKind: 'changed',
          diff: 'diff --git a/reported.ts b/reported.ts\n@@ -1 +1 @@\n-const a = 0\n+const a = 1'
        },
        {
          path: 'codemodded.ts',
          changeKind: 'added',
          diff: 'diff --git a/codemodded.ts b/codemodded.ts\n@@ -0,0 +1,2 @@\n+const b = 2\n+const c = 3'
        }
      ]
    )

    const changed = (await makeCore().getConversation(sessionId)).changedFiles
    expect(changed).toMatchObject([
      // Reported once by the agent, and not counted a second time for being
      // seen again on disk.
      { path: 'reported.ts', changes: 1, added: 1, removed: 0, reported: true },
      { path: 'codemodded.ts', changes: 1, added: 2, removed: 0, reported: false }
    ])
  })

  it('records the same comparison twice as once', async () => {
    // A crash between recording a comparison and cleaning up after it means
    // the next start makes the same comparison again (ticket 12e).
    const runId = await startRun('Run the codemod', 'submission-twice')
    const files = [
      {
        path: 'quiet.ts',
        changeKind: 'changed' as const,
        diff: 'diff --git a/quiet.ts b/quiet.ts\n@@ -1 +1 @@\n-const a = 0\n+const a = 1'
      }
    ]
    const completion = {
      sessionId,
      runId,
      outcome: 'completed' as const,
      category: null,
      summary: 'Harness process completed'
    }
    await finishRun(completion, files)
    await finishRun(completion, files)

    const changed = (await makeCore().getConversation(sessionId)).changedFiles
    expect(changed).toMatchObject([{ path: 'quiet.ts', changes: 1, added: 1, removed: 1 }])
  })

  it('tells a change with no text apart from one whose diff was not kept', async () => {
    const runId = await startRun('Add the logo', 'submission-binary')
    await finishRun(
      {
        sessionId,
        runId,
        outcome: 'completed',
        category: null,
        summary: 'Harness process completed'
      },
      [
        // A binary file: git named it and its patch says nothing about lines.
        {
          path: 'logo.png',
          changeKind: 'added',
          diff: 'diff --git a/logo.png b/logo.png\nBinary files /dev/null and b/logo.png differ'
        },
        // A change git named and could not hand back a patch for.
        { path: 'huge.ts', changeKind: 'changed', diff: '' }
      ]
    )

    const changed = (await makeCore().getConversation(sessionId)).changedFiles
    expect(changed).toMatchObject([
      { path: 'logo.png', added: 0, removed: 0, shortened: false },
      { path: 'huge.ts', added: 0, removed: 0, shortened: true }
    ])
  })

  it('takes the Harness at its word about what it did to a file', async () => {
    const runId = await startRun('Delete the old one', 'submission-harness-kind')
    await core.applyHarnessEvent({
      sessionId,
      runId,
      event: {
        type: 'file-change',
        path: `${projectRoot}/old.ts`,
        changeKind: 'deleted',
        hunks: [hunk(['-const old = true'])]
      }
    })

    const [file] = (await makeCore().getConversation(sessionId)).changedFiles
    expect(file).toMatchObject({ path: 'old.ts', changeKind: 'deleted' })
  })

  it('says a file is gone rather than showing it as changed', async () => {
    const runId = await startRun('Remove the old one', 'submission-delete')
    await finishRun(
      {
        sessionId,
        runId,
        outcome: 'completed',
        category: null,
        summary: 'Harness process completed'
      },
      [
        {
          path: 'doomed.ts',
          changeKind: 'deleted',
          diff: 'diff --git a/doomed.ts b/doomed.ts\n@@ -1 +0,0 @@\n-const gone = true'
        }
      ]
    )

    const [file] = (await makeCore().getConversation(sessionId)).changedFiles
    expect(file).toMatchObject({ path: 'doomed.ts', changeKind: 'deleted', removed: 1, added: 0 })
  })

  it('says when the diff it kept is only the start of the one that happened', async () => {
    const runId = await startRun('Rewrite it all', 'submission-clipped')
    await core.applyHarnessEvent({
      sessionId,
      runId,
      event: {
        type: 'file-change',
        path: `${projectRoot}/generated.ts`,
        hunks: [hunk(Array.from({ length: 500 }, (_, index) => `+line ${String(index)}`))]
      }
    })
    await core.applyHarnessEvent({
      sessionId,
      runId,
      event: {
        type: 'file-change',
        path: `${projectRoot}/small.ts`,
        hunks: [hunk(['+one line'])]
      }
    })

    const changed = (await makeCore().getConversation(sessionId)).changedFiles
    expect(changed).toMatchObject([
      { path: 'generated.ts', added: 500, shortened: true },
      { path: 'small.ts', added: 1, shortened: false }
    ])
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

describe('undoing a Run in the record', () => {
  const hunk = (lines: string[]): DiffHunk => ({
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: lines.length,
    lines
  })

  /** One Run that changed two files, which is what an undo has to speak about. */
  async function ranAndChangedTwo(): Promise<string> {
    const runId = await startRun('Do the thing', 'submission-undo')
    for (const path of ['kept.ts', 'putback.ts']) {
      await core.applyHarnessEvent({
        sessionId,
        runId,
        event: {
          type: 'file-change',
          path: `${projectRoot}/${path}`,
          hunks: [hunk(['+const a = 1'])]
        }
      })
    }
    return runId
  }

  it('appends what the app did without rewriting the Run it undid', async () => {
    const runId = await ranAndChangedTwo()
    const before = (await core.getConversation(sessionId)).entries.filter(
      (entry) => entry.kind === 'file-change'
    )

    await core.recordAppAction({
      sessionId,
      operationId: 'operation-1',
      action: 'run-undo',
      sourceRunId: runId,
      outcomes: [
        { path: 'putback.ts', outcome: 'restored' },
        { path: 'kept.ts', outcome: 'skipped-diverged' }
      ]
    })

    const snapshot = await makeCore().getConversation(sessionId)
    // The Run, its steps and its diffs are exactly as they were written.
    expect(snapshot.entries.filter((entry) => entry.kind === 'file-change')).toEqual(before)
    expect(snapshot.entries.filter((entry) => entry.kind === 'app-action')).toMatchObject([
      {
        action: 'run-undo',
        sourceRunId: runId,
        outcomes: [
          { path: 'putback.ts', outcome: 'restored' },
          { path: 'kept.ts', outcome: 'skipped-diverged' }
        ],
        unlisted: 0
      }
    ])
  })

  it('marks the restored rows in the Files projection and leaves the rest alone', async () => {
    const runId = await ranAndChangedTwo()

    await core.recordAppAction({
      sessionId,
      operationId: 'operation-1',
      action: 'run-undo',
      sourceRunId: runId,
      outcomes: [
        { path: 'putback.ts', outcome: 'restored' },
        { path: 'kept.ts', outcome: 'skipped-diverged' }
      ]
    })

    expect((await makeCore().getConversation(sessionId)).changedFiles).toMatchObject([
      { path: 'kept.ts', restored: false, changes: 1 },
      { path: 'putback.ts', restored: true, changes: 1 }
    ])
  })

  it('stops calling a file restored once something changes it again', async () => {
    const runId = await ranAndChangedTwo()
    await core.recordAppAction({
      sessionId,
      operationId: 'operation-1',
      action: 'run-undo',
      sourceRunId: runId,
      outcomes: [{ path: 'putback.ts', outcome: 'restored' }]
    })

    const later = await startRun('Do it again', 'submission-again')
    await core.applyHarnessEvent({
      sessionId,
      runId: later,
      event: {
        type: 'file-change',
        path: `${projectRoot}/putback.ts`,
        hunks: [hunk(['+const b = 2'])]
      }
    })

    const changed = (await makeCore().getConversation(sessionId)).changedFiles
    expect(changed.find((file) => file.path === 'putback.ts')).toMatchObject({ restored: false })
  })

  it('writes one entry however many times the same restoration is recorded', async () => {
    const runId = await ranAndChangedTwo()
    const input = {
      sessionId,
      operationId: 'operation-1',
      action: 'run-undo' as const,
      sourceRunId: runId,
      outcomes: [{ path: 'putback.ts', outcome: 'restored' as const }]
    }

    await core.recordAppAction(input)
    await core.recordAppAction(input)

    expect(
      (await makeCore().getConversation(sessionId)).entries.filter(
        (entry) => entry.kind === 'app-action'
      )
    ).toHaveLength(1)
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
        running: false,
        exitCode: null,
        durationMs: null
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

describe('what a command step records', () => {
  it('keeps the exit code and duration the Harness reported', async () => {
    const runId = await startRun('Run the tests', 'submission-exit')
    await core.applyHarnessEvent({
      sessionId,
      runId,
      event: {
        type: 'command',
        id: 'toolu_1',
        command: 'npx jest hooks --watchAll=false',
        output: '1 failed',
        failed: true,
        running: false,
        exitCode: 1,
        durationMs: 8_200
      }
    })

    const reloaded = await makeCore().getConversation(sessionId)
    const commands = reloaded.entries.filter((entry) => entry.kind === 'command')
    expect(commands).toMatchObject([{ failed: true, exitCode: 1, durationMs: 8_200 }])
  })

  it('measures the duration itself when the Harness reports none', async () => {
    const runId = await startRun('Run the tests', 'submission-measured')
    const command = (running: boolean) =>
      core.applyHarnessEvent({
        sessionId,
        runId,
        event: {
          type: 'command',
          id: 'toolu_1',
          command: 'pnpm test',
          output: '',
          failed: false,
          running,
          exitCode: null,
          durationMs: null
        }
      })

    await command(true)
    await command(false)

    const reloaded = await makeCore().getConversation(sessionId)
    const [only] = reloaded.entries.filter((entry) => entry.kind === 'command')
    if (only?.kind !== 'command') throw new Error('expected a command entry')
    // The clock ticks one second per reading, so between the start the
    // Conversation saw and the finish there is a measurable gap.
    expect(only.durationMs).toBeGreaterThan(0)
  })

  it('keeps one subagent, dated from its dispatch, however often it reports', async () => {
    const runId = await startRun('Review the diff', 'submission-subagent')
    const report = (
      status: SubagentStatus,
      rest: { activity?: string; result?: string; steps?: number } = {}
    ) =>
      core.applyHarnessEvent({
        sessionId,
        runId,
        event: {
          type: 'subagent',
          id: 'toolu_agent_1',
          name: 'Standards review',
          role: 'Reviewer',
          brief: 'Review the diff against the repository standards',
          status,
          steps: rest.steps ?? null,
          durationMs: null,
          ...(rest.activity !== undefined ? { activity: rest.activity } : {}),
          ...(rest.result !== undefined ? { result: rest.result } : {})
        }
      })

    await report('working')
    await report('working', { activity: 'Read docs/agents/code-style.md', steps: 1 })
    // Claude ends a subagent twice: once to say it finished, and again to say
    // what it found. The second must still be dated from the dispatch.
    await report('done', { steps: 3 })
    await report('done', { result: 'No findings.', steps: 3 })

    const reloaded = await makeCore().getConversation(sessionId)
    const subagents = reloaded.entries.filter((entry) => entry.kind === 'subagent')
    // Three reports, one subagent: the dock draws a fleet, not a log.
    expect(subagents).toHaveLength(1)
    const [only] = subagents
    if (only?.kind !== 'subagent') throw new Error('expected a subagent entry')
    expect(only).toMatchObject({
      runId,
      dispatchId: 'toolu_agent_1',
      name: 'Standards review',
      role: 'Reviewer',
      status: 'done',
      result: 'No findings.',
      steps: 3
    })
    // Dated from the dispatch rather than from its last word, so the time it
    // took is the time it took.
    expect(Date.parse(only.startedAt)).toBeLessThan(Date.parse(only.at))
    expect(only.durationMs).toBeGreaterThan(0)
    const dispatchedAt = only.startedAt

    // And the same holds after a restart, when the projection is rebuilt.
    const restarted = makeCore()
    await restarted.applyHarnessEvent({
      sessionId,
      runId,
      event: {
        type: 'subagent',
        id: 'toolu_agent_1',
        name: 'Standards review',
        status: 'done',
        result: 'No findings.',
        steps: 3,
        durationMs: null
      }
    })
    const [reread] = (await makeCore().getConversation(sessionId)).entries.filter(
      (entry) => entry.kind === 'subagent'
    )
    if (reread?.kind !== 'subagent') throw new Error('expected a subagent entry')
    expect(reread.startedAt).toBe(dispatchedAt)
  })

  it('leaves a subagent that reported nothing back without a result or a duration', async () => {
    const runId = await startRun('Review the diff', 'submission-subagent-open')
    await core.applyHarnessEvent({
      sessionId,
      runId,
      event: {
        type: 'subagent',
        id: 'toolu_agent_2',
        name: 'Fixture sweep',
        status: 'working',
        steps: null,
        durationMs: null
      }
    })

    const reloaded = await makeCore().getConversation(sessionId)
    const [only] = reloaded.entries.filter((entry) => entry.kind === 'subagent')
    if (only?.kind !== 'subagent') throw new Error('expected a subagent entry')
    expect(only).toMatchObject({ status: 'working', result: null, durationMs: null, brief: null })
  })

  it('keeps one Plan per Run, dated from when it first appeared, however often it is rewritten', async () => {
    const runId = await startRun('Wire the checklist through', 'submission-plan')
    const plan = (steps: PlanStep[], explanation: string | null = null) =>
      core.applyHarnessEvent({
        sessionId,
        runId,
        event: { type: 'plan', explanation, steps }
      })

    await plan([
      { step: 'Map the seams', activeForm: 'Mapping the seams', status: 'in-progress' },
      { step: 'Record a fixture', activeForm: null, status: 'pending' }
    ])
    // The agent revises the list: a step is inserted and the first is done.
    await plan(
      [
        { step: 'Map the seams', activeForm: 'Mapping the seams', status: 'completed' },
        { step: 'Read the Task tools', activeForm: null, status: 'in-progress' },
        { step: 'Record a fixture', activeForm: null, status: 'pending' }
      ],
      'The Claude side needs its own step.'
    )

    const reloaded = await makeCore().getConversation(sessionId)
    const plans = reloaded.entries.filter((entry) => entry.kind === 'plan')
    // Two rewrites, one Plan: the transcript holds a checklist, not a diff log.
    expect(plans).toHaveLength(1)
    const [only] = plans
    if (only?.kind !== 'plan') throw new Error('expected a plan entry')
    expect(only).toMatchObject({
      runId,
      explanation: 'The Claude side needs its own step.',
      steps: [
        { step: 'Map the seams', status: 'completed' },
        { step: 'Read the Task tools', status: 'in-progress' },
        { step: 'Record a fixture', status: 'pending' }
      ]
    })
    // Dated from the first sighting rather than from the newest rewrite, so a
    // Plan written early and revised late does not read as one just thought of.
    expect(Date.parse(only.startedAt)).toBeLessThan(Date.parse(only.at))
    const firstSeen = only.startedAt

    // And the same holds after a restart, when the projection is rebuilt.
    const restarted = makeCore()
    await restarted.applyHarnessEvent({
      sessionId,
      runId,
      event: {
        type: 'plan',
        explanation: null,
        steps: [
          { step: 'Map the seams', activeForm: null, status: 'completed' },
          { step: 'Read the Task tools', activeForm: null, status: 'completed' },
          { step: 'Record a fixture', activeForm: null, status: 'completed' }
        ]
      }
    })
    const [reread] = (await makeCore().getConversation(sessionId)).entries.filter(
      (entry) => entry.kind === 'plan'
    )
    if (reread?.kind !== 'plan') throw new Error('expected a plan entry')
    expect(reread.startedAt).toBe(firstSeen)
  })

  it('gives each Run its own Plan rather than carrying one across them', async () => {
    const first = await startRun('First ask', 'submission-plan-first')
    await core.applyHarnessEvent({
      sessionId,
      runId: first,
      event: {
        type: 'plan',
        explanation: null,
        steps: [{ step: 'Map the seams', activeForm: null, status: 'completed' }]
      }
    })
    const second = await startRun('Second ask', 'submission-plan-second')
    await core.applyHarnessEvent({
      sessionId,
      runId: second,
      event: {
        type: 'plan',
        explanation: null,
        steps: [{ step: 'Draw the indicator', activeForm: null, status: 'in-progress' }]
      }
    })

    const reloaded = await makeCore().getConversation(sessionId)
    expect(reloaded.entries.filter((entry) => entry.kind === 'plan')).toMatchObject([
      { runId: first, steps: [{ step: 'Map the seams' }] },
      { runId: second, steps: [{ step: 'Draw the indicator' }] }
    ])
  })

  it('measures no duration for an interrupted command, whose result never arrived', async () => {
    const runId = await startRun('Run the tests', 'submission-interrupted')
    const command = (patch: { running: boolean; interrupted?: boolean }) =>
      core.applyHarnessEvent({
        sessionId,
        runId,
        event: {
          type: 'command',
          id: 'toolu_1',
          command: 'pnpm test',
          output: '',
          failed: false,
          running: patch.running,
          ...(patch.interrupted ? { interrupted: true } : {}),
          exitCode: null,
          durationMs: null
        }
      })

    await command({ running: true })
    // The Run stopped mid-command: the Adapter flushes it as interrupted.
    await command({ running: false, interrupted: true })

    const reloaded = await makeCore().getConversation(sessionId)
    // An interrupted command must not read back as a clean, measured finish.
    expect(reloaded.entries.filter((entry) => entry.kind === 'command')).toMatchObject([
      { running: false, interrupted: true, durationMs: null }
    ])
  })

  it('leaves the duration unknown for a command never seen starting', async () => {
    const runId = await startRun('Run the tests', 'submission-unseen')
    await core.applyHarnessEvent({
      sessionId,
      runId,
      event: {
        type: 'command',
        id: 'toolu_1',
        command: 'pnpm test',
        output: 'done',
        failed: false,
        running: false,
        exitCode: null,
        durationMs: null
      }
    })

    const reloaded = await makeCore().getConversation(sessionId)
    expect(reloaded.entries.filter((entry) => entry.kind === 'command')).toMatchObject([
      { durationMs: null }
    ])
  })
})

describe('what a Run read', () => {
  it('records a read with its path kept relative to the Checkout', async () => {
    const runId = await startRun('Look around', 'submission-read')
    await core.applyHarnessEvent({
      sessionId,
      runId,
      event: {
        type: 'tool',
        name: 'Read',
        summary: 'Called Claude tool Read',
        path: join(projectRoot, 'hooks/useLocation.ts')
      }
    })

    const reloaded = await makeCore().getConversation(sessionId)
    const reads = reloaded.entries.filter((entry) => entry.kind === 'read')
    // An absolute path is this machine's, not this Conversation's.
    expect(reads).toMatchObject([{ runId, path: './hooks/useLocation.ts' }])
  })

  it('keeps dropping tool calls that name no file', async () => {
    const runId = await startRun('Look around', 'submission-tool')
    await core.applyHarnessEvent({
      sessionId,
      runId,
      event: { type: 'tool', name: 'WebSearch', summary: 'Called Claude tool WebSearch' }
    })

    const reloaded = await makeCore().getConversation(sessionId)
    expect(reloaded.entries.filter((entry) => entry.kind === 'read')).toHaveLength(0)
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
          running: patch.running,
          exitCode: null,
          durationMs: null
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

    await finishRun({
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

describe('surviving the context window', () => {
  /** A Conversation long enough to have something a summary could stand in for. */
  async function longConversation(turns = 12, era = 'a'): Promise<string> {
    let runId = ''
    for (let turn = 1; turn <= turns; turn++) {
      runId = await startRun(`Turn ${era}${String(turn)}`, `submission-turn-${era}${String(turn)}`)
      await stream(runId, [
        {
          type: 'assistant-message',
          id: `m${era}${String(turn)}`,
          text: `Answer ${era}${String(turn)}`,
          complete: true
        }
      ])
      await finishRun({
        sessionId,
        runId,
        outcome: 'completed',
        category: null,
        summary: 'Harness completed the turn'
      })
    }
    return runId
  }

  /** Compacts the Session the way Main does: ask Core for the plan, write the summary back. */
  async function compact(summary: string, operationId = 'compaction-1') {
    const plan = await core.planCompaction(sessionId)
    return {
      plan,
      snapshot: await core.compactConversation({
        sessionId,
        operationId,
        runId: plan.runId,
        summary,
        tailFromEntryId: plan.tailFromEntryId
      })
    }
  }

  it('leaves every message, command and output exactly where it was', async () => {
    const runId = await startRun('Run the tests', 'submission-compact-whole')
    await stream(runId, [
      {
        type: 'command',
        id: 'toolu_1',
        command: 'pnpm test',
        output: 'all green',
        failed: false,
        running: false,
        exitCode: 0,
        durationMs: 12
      }
    ])
    await finishRun({
      sessionId,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Harness completed the turn'
    })
    await longConversation()
    const before = await core.getConversation(sessionId)

    const { snapshot } = await compact('The Session set up receipts and got the tests green.')

    // Nothing is hidden and nothing is lost: compaction changes what the agent
    // remembers, never what the person can read.
    for (const entry of before.entries) {
      expect(snapshot.entries.some((kept) => kept.id === entry.id)).toBe(true)
    }
    expect(snapshot.entries.filter((entry) => entry.kind === 'command')).toMatchObject([
      { command: 'pnpm test', output: 'all green' }
    ])
    // And the journal on disk still holds every original entry.
    const stored = await readFile(
      join(stateDir, 'sessions', sessionId, 'conversation.jsonl'),
      'utf8'
    )
    expect(stored).toContain('all green')
    expect(stored).toContain(STARTING_MESSAGE)
  })

  it('records the summary it is carrying and where the untouched tail begins', async () => {
    await longConversation()

    const { plan, snapshot } = await compact('Receipts work offline; the tests are green.')

    const boundary = snapshot.entries.findLast(
      (entry) => entry.kind === 'boundary' && entry.boundary === 'compacted'
    )
    if (boundary?.kind !== 'boundary') throw new Error('expected a compaction boundary')
    expect(boundary.compaction).toMatchObject({
      summary: 'Receipts work offline; the tests are green.',
      tailFromEntryId: plan.tailFromEntryId,
      native: false
    })
    // The tail names an entry the person can actually see.
    expect(snapshot.entries.some((entry) => entry.id === plan.tailFromEntryId)).toBe(true)
  })

  it('hands the previous summary over as material, so a second compaction does not nest', async () => {
    await longConversation()
    await compact('First: receipts render offline.')
    await longConversation(12, 'b')

    const plan = await core.planCompaction(sessionId)

    expect(plan.previousSummary).toBe('First: receipts render offline.')
    // The turns the first summary already accounts for are not read again.
    expect(plan.material).not.toContain('Answer a1')
    expect(plan.material).toContain('Answer b1')
    await core.compactConversation({
      sessionId,
      operationId: 'compaction-2',
      runId: plan.runId,
      summary: 'Receipts render offline and the tests are green.',
      tailFromEntryId: plan.tailFromEntryId
    })

    const snapshot = await core.getConversation(sessionId)
    const summaries = snapshot.entries.flatMap((entry) =>
      entry.kind === 'boundary' && entry.compaction ? [entry.compaction.summary] : []
    )
    // Both compactions are in the record, and the one in force is one summary.
    expect(summaries).toHaveLength(2)
    expect(summaries.at(-1)).toBe('Receipts render offline and the tests are green.')
    expect(summaries.at(-1)).not.toContain('First: receipts render offline.')
  })

  it('still accounts for every turn a Harness summarized only for itself', async () => {
    await longConversation()
    const runId = await startRun('Keep going', 'submission-native-then-app')
    await stream(runId, [{ type: 'context-compacted', summary: 'What Codex kept.' }])
    await finishRun({
      sessionId,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Harness completed the turn'
    })

    const plan = await core.planCompaction(sessionId)

    // What a Harness kept is inside that Harness and cannot be read, so it is
    // no summary this app can rewrite — and the turns behind it are still the
    // app's own to account for.
    expect(plan.previousSummary).toBeNull()
    expect(plan.material).toContain('Answer a1')
  })

  it('refuses to run inside a Run blocked on an Approval Request', async () => {
    await longConversation()
    const runId = await startRun('Delete the build', 'submission-compact-blocked')
    await stream(runId, [
      {
        type: 'approval-request',
        id: 'toolu_block',
        tool: 'Command',
        summary: 'rm -rf build',
        detail: '{}',
        proposedRule: null
      }
    ])

    await expect(core.planCompaction(sessionId)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('refuses a Session with nothing yet a summary could stand in for', async () => {
    await expect(core.planCompaction(sessionId)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('records a Harness that compacted itself, rather than failing on protocol', async () => {
    const runId = await startRun('Keep going', 'submission-native-compaction')
    await stream(runId, [
      { type: 'assistant-message', id: 'm1', text: 'Still here', complete: true },
      { type: 'context-compacted', summary: 'Kept the file layout and the conventions.' }
    ])

    const snapshot = await core.getConversation(sessionId)
    const boundary = snapshot.entries.findLast(
      (entry) => entry.kind === 'boundary' && entry.boundary === 'compacted'
    )
    if (boundary?.kind !== 'boundary') throw new Error('expected a compaction boundary')
    expect(boundary.compaction).toMatchObject({
      summary: 'Kept the file layout and the conventions.',
      native: true
    })
    // The Harness still holds its Thread, so the Run is still the Run.
    expect(snapshot.activeRunId).toBe(runId)
    expect(snapshot.recovery).toBeNull()
  })

  it('is written once however many times the same compaction is recorded', async () => {
    await longConversation()
    await compact('Receipts work offline.')
    await compact('Receipts work offline.')

    const snapshot = await core.getConversation(sessionId)
    expect(
      snapshot.entries.filter(
        (entry) => entry.kind === 'boundary' && entry.boundary === 'compacted'
      )
    ).toHaveLength(1)
  })

  it('reads back the same way when the projection disagrees with the journal', async () => {
    await longConversation()
    await compact('Receipts work offline.')
    const trusted = await core.getConversation(sessionId)

    // A projection that fell behind — a crash between the two writes — is
    // repaired from the journal rather than believed.
    await writeFile(
      join(stateDir, 'sessions', sessionId, 'state.json'),
      JSON.stringify({
        activeRunId: 'run-that-never-was',
        openApprovals: [],
        lastMessage: null,
        recentMessageIds: [],
        recovery: null,
        runningCommands: {},
        subagentDispatchedAt: {},
        runSteps: { read: 0, 'file-change': 0 },
        journalBytes: 1
      })
    )

    const rebuilt = await makeCore().getConversation(sessionId)
    expect(rebuilt.activeRunId).toBe(trusted.activeRunId)
    expect(rebuilt.entries.map((entry) => entry.id)).toEqual(
      trusted.entries.map((entry) => entry.id)
    )
  })
})
