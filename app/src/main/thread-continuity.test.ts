import { describe, expect, it } from 'vitest'
import {
  conversationBoundarySchema,
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
    harnessThreads: { claude: 'saved-thread' },
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

/**
 * A Run opening, which is the only boundary that names its Harness — and so
 * the only place the saved Harness Thread can be placed in the Conversation.
 */
function opened(id: string, harness: 'codex' | 'claude'): ConversationEntry {
  return {
    kind: 'boundary',
    id,
    at: '2026-08-09T12:00:00.000Z',
    runId: 'run-1',
    boundary: 'run-started',
    summary: 'Wayfinder',
    submissionId: null,
    recovery: null,
    harness
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

describe('what a new Harness Thread is seeded with', () => {
  it('hands off the Skill in force and the last eight turns, byte for byte', () => {
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

  it('leaves out the Skill line when no Skill is in force', () => {
    expect(
      conversationSeed(conversation([message('hello')]), { shape: 'handoff', skill: null })
    ).toBe('Recent turns:\nUser: hello')
  })

  it('says so when the Conversation has no turns to hand off', () => {
    expect(
      conversationSeed(conversation([opened('boundary:1', 'claude')]), {
        shape: 'handoff',
        skill: null
      })
    ).toBe('Recent turns:\n(none)')
  })

  it('reads only the turns, never the rest of the Conversation', () => {
    const entries = [
      message('what changed?'),
      boundary('boundary:1', 'run-completed'),
      message('this and that', 'assistant')
    ]
    expect(conversationSeed(conversation(entries), { shape: 'handoff', skill: null })).toBe(
      'Recent turns:\nUser: what changed?\nAssistant: this and that'
    )
  })
})

describe('a Conversation fact that vetoes Harness Thread reuse', () => {
  it('is not among the boundaries a Conversation can record today', () => {
    expect([...CONTINUITY_BREAKING_BOUNDARIES]).toEqual([])
  })

  it('is found nowhere in a Conversation of ordinary Runs', () => {
    const entries = [
      message('hello'),
      opened('boundary:1', 'claude'),
      boundary('boundary:2', 'run-completed'),
      boundary('boundary:3', 'configuration'),
      message('and again')
    ]
    for (const kind of conversationBoundarySchema.options) {
      expect(
        threadReuseVetoed(conversation([...entries, boundary('boundary:4', kind)]), 'claude')
      ).toBe(false)
    }
  })

  it('vetoes reuse when it follows the Run that saved the Thread', () => {
    const entries = [opened('boundary:1', 'claude'), boundary('boundary:2', 'configuration')]
    expect(threadReuseVetoed(conversation(entries), 'claude', new Set(['configuration']))).toBe(
      true
    )
  })

  it('leaves a Thread saved after the break alone', () => {
    const entries = [boundary('boundary:1', 'configuration'), opened('boundary:2', 'claude')]
    expect(threadReuseVetoed(conversation(entries), 'claude', new Set(['configuration']))).toBe(
      false
    )
  })

  it('is read per Harness, not across all of them', () => {
    const entries = [
      opened('boundary:1', 'claude'),
      boundary('boundary:2', 'configuration'),
      opened('boundary:3', 'codex')
    ]
    const breaking: ReadonlySet<ConversationBoundaryKind> = new Set(['configuration'])
    expect(threadReuseVetoed(conversation(entries), 'claude', breaking)).toBe(true)
    expect(threadReuseVetoed(conversation(entries), 'codex', breaking)).toBe(false)
  })

  it('leaves a Conversation this Harness has never run in alone', () => {
    expect(
      threadReuseVetoed(conversation([message('hello')]), 'codex', new Set(['configuration']))
    ).toBe(false)
  })
})
