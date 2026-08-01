import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConversationEntry, HarnessEvent } from '@shared/conversation'
import { createCore, type Core } from './core'

/**
 * Developing an Idea through the permanent Conversation, observed at the Core
 * interface: what the person submits, what streams back, and what survives a
 * Stop, a failure, or a crash.
 */

let libraryDir: string
let core: Core
let relativePath: string

function makeCore(): Core {
  let tick = 0
  return createCore({
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
    relativePath,
    prompt,
    configuration: {
      provider: 'codex',
      executable: '/usr/local/bin/codex',
      executableHash: 'a'.repeat(64),
      providerVersion: 'codex-cli 0.146.0',
      model: 'gpt-5-codex',
      effort: 'medium',
      workflow: 'grilling',
      skill: { name: 'grilling', path: '/home/.agents/skills/grilling', hash: 'b'.repeat(64) },
      environment: {},
      workingDirectory: join(libraryDir, relativePath),
      permissionMode: 'ask',
      permissionProfile: 'planning-v1'
    }
  })
  await core.beginConversationRun({
    relativePath,
    runId: run.id,
    submissionId,
    provider: 'codex',
    workflow: 'grilling',
    model: 'gpt-5-codex'
  })
  return run.id
}

async function stream(runId: string, events: HarnessEvent[]): Promise<void> {
  for (const event of events) {
    await core.applyHarnessEvent({ relativePath, runId, event })
  }
}

function messages(entries: ConversationEntry[]): Extract<ConversationEntry, { kind: 'message' }>[] {
  return entries.filter((entry) => entry.kind === 'message')
}

beforeEach(async () => {
  libraryDir = await mkdtemp(join(tmpdir(), 'idea-conversation-'))
  core = makeCore()
  await core.openLibrary(libraryDir)
  const idea = await core.captureIdea({ kind: 'software', title: 'Offline receipts', notes: '' })
  relativePath = idea.relativePath
})

afterEach(async () => {
  await rm(libraryDir, { recursive: true, force: true })
})

describe('submitting to the Conversation', () => {
  it('starts empty for a newly captured Idea', async () => {
    const snapshot = await core.getConversation(relativePath)
    expect(snapshot.entries).toEqual([])
    expect(snapshot.activeRunId).toBeNull()
    expect(snapshot.usage.idea.totalTokens).toBe(0)
  })

  it('accepts the user message locally before any provider is contacted', async () => {
    const snapshot = await core.submitConversationMessage({
      relativePath,
      submissionId: 'submission-1',
      text: 'Grill me about this idea',
      source: 'composer'
    })
    expect(messages(snapshot.entries)).toMatchObject([
      {
        role: 'user',
        text: 'Grill me about this idea',
        completeness: 'complete',
        source: 'composer',
        submissionId: 'submission-1'
      }
    ])
    expect(snapshot.activeRunId).toBeNull()
  })

  it('records a Suggested Response as an ordinary readable user message', async () => {
    const snapshot = await core.submitConversationMessage({
      relativePath,
      submissionId: 'submission-1',
      text: 'Solo freelancers who invoice a handful of clients.',
      source: 'suggested-response'
    })
    expect(messages(snapshot.entries)).toMatchObject([
      {
        role: 'user',
        text: 'Solo freelancers who invoice a handful of clients.',
        source: 'suggested-response'
      }
    ])
  })

  it('is idempotent for a resent submission id', async () => {
    const input = {
      relativePath,
      submissionId: 'submission-1',
      text: 'Grill me',
      source: 'composer' as const
    }
    await core.submitConversationMessage(input)
    const snapshot = await core.submitConversationMessage(input)
    expect(messages(snapshot.entries)).toHaveLength(1)
  })

  it('rejects reusing a submission id for different content', async () => {
    await core.submitConversationMessage({
      relativePath,
      submissionId: 'submission-1',
      text: 'Grill me',
      source: 'composer'
    })
    await expect(
      core.submitConversationMessage({
        relativePath,
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
      relativePath,
      submissionId: 'submission-1',
      text: 'Grill me',
      source: 'composer'
    })
  })

  it('marks the Run boundary and reports the Run as active', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    const snapshot = await core.getConversation(relativePath)
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
      relativePath,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Provider process completed'
    })
    const snapshot = await core.getConversation(relativePath)
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
      relativePath,
      runId,
      outcome: 'stopped',
      category: null,
      summary: 'Run stopped by user'
    })
    const snapshot = await core.getConversation(relativePath)
    expect(messages(snapshot.entries).at(-1)).toMatchObject({
      role: 'assistant',
      text: 'Who is this f',
      completeness: 'partial'
    })
    expect(snapshot.recovery).toMatchObject({ category: 'stopped' })
  })

  it('attaches provider-native structured choices as Suggested Responses', async () => {
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
      relativePath,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Provider process completed'
    })
    const snapshot = await core.getConversation(relativePath)
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
      relativePath,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Provider process completed'
    })
    const last = messages((await core.getConversation(relativePath)).entries).at(-1)
    expect(last?.suggestedResponses).toEqual([])
    expect(last?.plainOptions).toBe(true)
  })

  it('keeps reasoning summaries and tool activity out of portable Conversation content', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await stream(runId, [
      { type: 'reasoning', summary: 'Reading the Idea first.' },
      { type: 'tool', name: 'planning.read_file', summary: 'Read file idea.md' },
      { type: 'assistant-message', id: 'item_0', text: 'Who is this for?', complete: true }
    ])
    await core.finalizeConversationRun({
      relativePath,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Provider process completed'
    })
    const markdown = await readFile(
      join(libraryDir, relativePath, 'planning', 'conversation.md'),
      'utf8'
    )
    expect(markdown).toContain('Who is this for?')
    expect(markdown).not.toContain('Reading the Idea first.')
    expect(markdown).not.toContain('read_file')
  })

  it('keeps every assistant message a Run produced, in order', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await stream(runId, [
      { type: 'assistant-message', id: 'item_0', text: 'Let me read the Idea.', complete: true },
      { type: 'assistant-message', id: 'item_2', text: 'Who is this for?', complete: true }
    ])
    await core.finalizeConversationRun({
      relativePath,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Provider process completed'
    })
    const assistant = messages((await core.getConversation(relativePath)).entries).filter(
      (entry) => entry.role === 'assistant'
    )
    expect(assistant.map((entry) => entry.text)).toEqual([
      'Let me read the Idea.',
      'Who is this for?'
    ])
  })

  it('attaches structured choices to the newest message of the Run', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await stream(runId, [
      { type: 'assistant-message', id: 'item_0', text: 'Let me read the Idea.', complete: true },
      { type: 'assistant-message', id: 'item_2', text: 'Who is this for?', complete: true },
      {
        type: 'choices',
        question: 'Who is this for?',
        options: [{ id: 'option-1', label: 'Solo freelancers', value: 'Solo freelancers.' }]
      }
    ])
    await core.finalizeConversationRun({
      relativePath,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Provider process completed'
    })
    const assistant = messages((await core.getConversation(relativePath)).entries).filter(
      (entry) => entry.role === 'assistant'
    )
    expect(assistant.at(-1)?.suggestedResponses).toHaveLength(1)
    expect(assistant.at(0)?.suggestedResponses).toEqual([])
  })

  it('reports provider usage per Run and per Idea as informational totals', async () => {
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
      relativePath,
      runId: first,
      outcome: 'completed',
      category: null,
      summary: 'Provider process completed'
    })
    await core.submitConversationMessage({
      relativePath,
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
    const snapshot = await core.getConversation(relativePath)
    expect(snapshot.usage.run).toMatchObject({ totalTokens: 340, contextUsed: 340 })
    expect(snapshot.usage.idea).toMatchObject({ totalTokens: 460, contextWindow: 272_000 })
  })

  it('keeps provider continuity and workflow completion as separate durable state', async () => {
    const runId = await startRun('Develop this', 'submission-1')
    await stream(runId, [
      {
        type: 'session-ready',
        provider: 'codex',
        sessionId: 'session-1',
        model: 'gpt-5-codex'
      },
      { type: 'completed' }
    ])
    let snapshot = await core.getConversation(relativePath)
    expect(snapshot.providerSessions).toEqual({ codex: 'session-1' })
    expect(snapshot.workflowCompletionSuggested).toBe(false)

    await stream(runId, [{ type: 'workflow-completion-suggested' }])
    snapshot = await core.getConversation(relativePath)
    expect(snapshot.workflowCompletionSuggested).toBe(true)
  })
})

describe('ingesting raw provider output', () => {
  beforeEach(async () => {
    await core.submitConversationMessage({
      relativePath,
      submissionId: 'submission-1',
      text: 'Grill me',
      source: 'composer'
    })
  })

  it('turns Codex protocol into Conversation content across split chunks', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    const lines = [
      '{"type":"item.updated","item":{"id":"item_0","type":"agent_message","text":"Who is "}}\n{"type":"item.comp',
      'leted","item":{"id":"item_0","type":"agent_message","text":"Who is this for?"}}\n{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}\n'
    ]
    const seen = []
    for (const chunk of lines) {
      seen.push(
        ...(await core.ingestProviderOutput({ relativePath, runId, provider: 'codex', chunk }))
      )
    }
    expect(seen.at(-1)).toEqual({ type: 'completed' })
    await core.finalizeConversationRun({
      relativePath,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Provider process completed'
    })
    expect(messages((await core.getConversation(relativePath)).entries).at(-1)).toMatchObject({
      role: 'assistant',
      text: 'Who is this for?',
      completeness: 'complete'
    })
  })

  it('says the provider spoke unreadably rather than showing an empty Conversation', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    // A provider whose protocol this app does not model: the process is
    // perfectly happy and exits zero, but nothing usable ever arrives.
    await core.ingestProviderOutput({
      relativePath,
      runId,
      provider: 'codex',
      chunk: '{"type":"some.future.event"}\n{"type":"another.one"}\n'
    })
    await core.finalizeConversationRun({
      relativePath,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Provider process completed'
    })
    expect((await core.getConversation(relativePath)).recovery).toMatchObject({
      category: 'protocol-unsupported'
    })
  })

  it('stays silent when a Run it could read completes normally', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await core.ingestProviderOutput({
      relativePath,
      runId,
      provider: 'codex',
      chunk:
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Who is this for?"}}\n'
    })
    await core.finalizeConversationRun({
      relativePath,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Provider process completed'
    })
    expect((await core.getConversation(relativePath)).recovery).toBeNull()
  })

  it('reports what the provider said rather than blaming its protocol', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    // Unmodelled protocol arrived, but the provider also said why it failed.
    // The stated cause is the one the person can act on.
    await core.ingestProviderOutput({
      relativePath,
      runId,
      provider: 'codex',
      chunk: '{"type":"some.future.event"}\n'
    })
    await core.finalizeConversationRun({
      relativePath,
      runId,
      outcome: 'failed',
      category: 'authentication',
      summary: 'The provider reports it is no longer signed in'
    })
    expect((await core.getConversation(relativePath)).recovery).toMatchObject({
      category: 'authentication'
    })
  })

  it('keeps a stop a stop, whatever protocol arrived first', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await core.ingestProviderOutput({
      relativePath,
      runId,
      provider: 'codex',
      chunk: '{"type":"some.future.event"}\n'
    })
    await core.finalizeConversationRun({
      relativePath,
      runId,
      outcome: 'stopped',
      category: null,
      summary: 'Run stopped by user'
    })
    expect((await core.getConversation(relativePath)).recovery).toMatchObject({
      category: 'stopped'
    })
  })

  it('gives Claude the same durable Conversation behavior as Codex', async () => {
    const run = await core.acceptRun({
      submissionId: 'submission-1',
      relativePath,
      prompt: 'Develop this',
      configuration: {
        provider: 'claude',
        executable: '/usr/local/bin/claude',
        executableHash: 'a'.repeat(64),
        providerVersion: '2.1.220',
        model: 'claude-sonnet-4-5',
        effort: 'medium',
        workflow: 'wayfinder',
        skill: { name: 'wayfinder', path: '/home/.claude/skills/wayfinder', hash: 'b'.repeat(64) },
        environment: {},
        workingDirectory: join(libraryDir, relativePath),
        permissionMode: 'ask',
        permissionProfile: 'planning-v1'
      }
    })
    await core.beginConversationRun({
      relativePath,
      runId: run.id,
      submissionId: 'submission-1',
      provider: 'claude',
      workflow: 'wayfinder',
      model: 'claude-sonnet-4-5'
    })
    const runId = run.id
    const seen = await core.ingestProviderOutput({
      relativePath,
      runId,
      provider: 'claude',
      chunk:
        '{"type":"system","subtype":"init","session_id":"session-1","model":"claude-sonnet-4-5"}\n{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"What decision is blocking this idea?"}],"usage":{"input_tokens":10,"output_tokens":7}}}\n{"type":"result","subtype":"success","is_error":false,"result":"What decision is blocking this idea?","usage":{"input_tokens":10,"output_tokens":7}}\n'
    })
    expect(seen.at(-1)).toEqual({ type: 'completed' })
    await core.finalizeConversationRun({
      relativePath,
      runId,
      outcome: 'completed',
      category: null,
      summary: 'Provider process completed'
    })
    expect(messages((await core.getConversation(relativePath)).entries).at(-1)).toMatchObject({
      role: 'assistant',
      text: 'What decision is blocking this idea?',
      completeness: 'complete'
    })
  })
})

describe('recovering from a Run that ended badly', () => {
  beforeEach(async () => {
    await core.submitConversationMessage({
      relativePath,
      submissionId: 'submission-1',
      text: 'Grill me',
      source: 'composer'
    })
  })

  it('offers a safe resend after authentication loss', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await stream(runId, [{ type: 'assistant-message', id: 'item_0', text: 'Who', complete: false }])
    await core.finalizeConversationRun({
      relativePath,
      runId,
      outcome: 'failed',
      category: 'authentication',
      summary: 'The provider reports it is no longer signed in'
    })
    const snapshot = await core.getConversation(relativePath)
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
      relativePath,
      runId,
      outcome: 'failed',
      category: 'context-exhausted',
      summary: 'The Run ran out of context'
    })
    expect((await core.getConversation(relativePath)).recovery).toMatchObject({
      category: 'context-exhausted',
      resumableSubmissionId: null
    })
  })

  it('calls a failure with no provider output an uncertain submission', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await core.finalizeConversationRun({
      relativePath,
      runId,
      outcome: 'failed',
      category: 'process-crash',
      summary: 'Provider process failed'
    })
    expect((await core.getConversation(relativePath)).recovery).toMatchObject({
      category: 'uncertain-submission',
      resumableSubmissionId: 'submission-1'
    })
  })

  it('clears the previous recovery once the next Run starts', async () => {
    const first = await startRun('Grill me', 'submission-1')
    await core.finalizeConversationRun({
      relativePath,
      runId: first,
      outcome: 'failed',
      category: 'rate-limit',
      summary: 'The provider is rate limiting this account'
    })
    await core.submitConversationMessage({
      relativePath,
      submissionId: 'submission-2',
      text: 'Try again',
      source: 'composer'
    })
    await startRun('Try again', 'submission-2')
    expect((await core.getConversation(relativePath)).recovery).toBeNull()
  })

  it('keeps history readable after a crash mid-stream', async () => {
    const runId = await startRun('Grill me', 'submission-1')
    await stream(runId, [
      { type: 'assistant-message', id: 'item_0', text: 'Who is this f', complete: false }
    ])
    // A crash means nothing finalizes the Run: a fresh Core must still read
    // the durable history and see the interrupted work labelled.
    const restarted = makeCore()
    await restarted.openLibrary(libraryDir)
    const snapshot = await restarted.getConversation(relativePath)
    expect(messages(snapshot.entries).at(-1)).toMatchObject({
      role: 'assistant',
      text: 'Who is this f',
      completeness: 'partial'
    })
    expect(snapshot.activeRunId).toBe(runId)
  })
})
