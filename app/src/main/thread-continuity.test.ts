import { describe, expect, it } from 'vitest'
import {
  emptyUsage,
  type ConversationBoundaryKind,
  type ConversationEntry,
  type ConversationSnapshot
} from '@shared/conversation'
import {
  CONTINUITY_BREAKING_BOUNDARIES,
  conversationSeed,
  threadReuseVetoed
} from './thread-continuity'

function conversation(entries: ConversationEntry[]): ConversationSnapshot {
  return {
    sessionId: 'session',
    entries,
    usage: { run: null, session: emptyUsage() },
    recovery: null,
    harnessThreads: {},
    changedFiles: [],
    activeRunId: null,
    pendingApprovalId: null,
    queue: { paused: true, items: [], outcome: null }
  }
}

function message(text: string, role: 'user' | 'assistant' = 'user'): ConversationEntry {
  return {
    kind: 'message',
    id: `message:${text}`,
    at: '2026-08-09T12:00:00.000Z',
    runId: null,
    role,
    text,
    completeness: 'complete',
    source: 'composer',
    submissionId: null,
    reviewAttachments: [],
    suggestedResponses: [],
    plainOptions: false
  }
}

function boundary(id: string, boundaryKind: ConversationBoundaryKind): ConversationEntry {
  return {
    kind: 'boundary',
    id,
    at: '2026-08-09T12:00:00.000Z',
    runId: 'run-1',
    boundary: boundaryKind,
    summary: 'Boundary',
    submissionId: null,
    recovery: null
  }
}

function thread(id: string, harness: 'codex' | 'claude'): ConversationEntry {
  return {
    kind: 'thread',
    id,
    at: '2026-08-09T12:00:00.000Z',
    runId: 'run-1',
    harness,
    threadId: 'saved-thread',
    model: 'claude-sonnet-4-5'
  }
}

describe('conversationSeed', () => {
  it('seeds a handoff with the Skill in force and the last eight turns, byte for byte', () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      message(`turn ${String(index + 1)}`, index % 2 === 0 ? 'user' : 'assistant')
    )
    expect(conversationSeed(conversation(entries), { shape: 'handoff', skill: 'wayfinder' })).toBe(
      [
        'Skill: wayfinder',
        'Recent turns:',
        'User: turn 3',
        'Assistant: turn 4',
        'User: turn 5',
        'Assistant: turn 6',
        'User: turn 7',
        'Assistant: turn 8',
        'User: turn 9',
        'Assistant: turn 10'
      ].join('\n')
    )
  })

  it('omits the Skill line when no Skill is in force', () => {
    expect(
      conversationSeed(conversation([message('hello')]), { shape: 'handoff', skill: null })
    ).toBe('Recent turns:\nUser: hello')
  })

  it('says so when the Conversation has no turns to hand off', () => {
    expect(
      conversationSeed(conversation([boundary('boundary:1', 'run-started')]), {
        shape: 'handoff',
        skill: null
      })
    ).toBe('Recent turns:\n(none)')
  })
})

describe('threadReuseVetoed', () => {
  it('knows no fact a Conversation can record today that vetoes Harness Thread reuse', () => {
    expect([...CONTINUITY_BREAKING_BOUNDARIES]).toEqual([])
  })

  it('finds no veto in a Conversation that has only run and configuration boundaries', () => {
    const entries = [
      message('hello'),
      thread('thread:1', 'claude'),
      boundary('boundary:1', 'run-completed'),
      boundary('boundary:2', 'configuration'),
      message('and again')
    ]
    expect(threadReuseVetoed(conversation(entries), 'claude')).toBe(false)
  })

  it('vetoes reuse when a continuity-breaking boundary follows the saved Harness Thread', () => {
    const entries = [thread('thread:1', 'claude'), boundary('boundary:1', 'configuration')]
    expect(threadReuseVetoed(conversation(entries), 'claude', new Set(['configuration']))).toBe(
      true
    )
  })

  it('leaves a boundary the saved Harness Thread already outlived alone', () => {
    const entries = [boundary('boundary:1', 'configuration'), thread('thread:1', 'claude')]
    expect(threadReuseVetoed(conversation(entries), 'claude', new Set(['configuration']))).toBe(
      false
    )
  })

  it('reads the vetoing fact per Harness, not across all of them', () => {
    const entries = [
      thread('thread:1', 'claude'),
      boundary('boundary:1', 'configuration'),
      thread('thread:2', 'codex')
    ]
    const breaking: ReadonlySet<ConversationBoundaryKind> = new Set(['configuration'])
    expect(threadReuseVetoed(conversation(entries), 'claude', breaking)).toBe(true)
    expect(threadReuseVetoed(conversation(entries), 'codex', breaking)).toBe(false)
  })

  it('leaves a Conversation with no Harness Thread of its own alone', () => {
    expect(
      threadReuseVetoed(conversation([message('hello')]), 'codex', new Set(['configuration']))
    ).toBe(false)
  })
})
