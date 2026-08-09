import { describe, expect, it } from 'vitest'
import {
  conversationBoundarySchema,
  emptyUsage,
  type ConversationBoundaryKind,
  type ConversationEntry,
  type ConversationSnapshot
} from '@shared/conversation'
import {
  breaksContinuity,
  conversationSeed,
  threadReuseVetoed,
  type ContinuityBreak
} from './thread-continuity'

/**
 * A break the Conversation cannot really declare, so the rule can be exercised
 * apart from the one fact that does declare one.
 */
const configurationBreak: ContinuityBreak = (entry) => entry.boundary === 'configuration'

type BoundaryEntry = Extract<ConversationEntry, { kind: 'boundary' }>

function conversation(entries: ConversationEntry[]): ConversationSnapshot {
  return {
    sessionId: 'session',
    journalPosition: 0,
    entries,
    usage: { run: null, session: emptyUsage() },
    recovery: null,
    harnessThreads: { claude: 'saved-thread' },
    changedFiles: [],
    activeRunId: null,
    pendingApprovalIds: [],
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
function opened(runId: string, harness: 'codex' | 'claude'): BoundaryEntry {
  return {
    kind: 'boundary',
    id: `boundary:${runId}:started`,
    at: '2026-08-09T12:00:00.000Z',
    runId,
    boundary: 'run-started',
    summary: 'Wayfinder',
    submissionId: null,
    recovery: null,
    harness
  }
}

/** How that Run ended, which is where the Harness is no longer named. */
function ended(runId: string, boundaryKind: ConversationBoundaryKind): BoundaryEntry {
  return {
    kind: 'boundary',
    id: `boundary:${runId}:ended`,
    at: '2026-08-09T12:00:00.000Z',
    runId,
    boundary: boundaryKind,
    summary: 'Boundary',
    submissionId: null,
    recovery: null
  }
}

/** What only the Harness could have written, and only once it had a Thread. */
function answered(runId: string): ConversationEntry {
  return {
    kind: 'message',
    id: `message:${runId}`,
    at: '2026-08-09T12:00:00.000Z',
    runId,
    role: 'assistant',
    text: 'Here is where we got to',
    completeness: 'complete',
    source: 'harness',
    submissionId: null,
    reviewAttachments: [],
    suggestedResponses: [],
    plainOptions: false
  }
}

/** What the person asked, which is written as the Run opens. */
function asked(runId: string): ConversationEntry {
  return {
    kind: 'message',
    id: `message:asked:${runId}`,
    at: '2026-08-09T12:00:00.000Z',
    runId,
    role: 'user',
    text: 'Where did we get to?',
    completeness: 'complete',
    source: 'composer',
    submissionId: null,
    reviewAttachments: [],
    suggestedResponses: [],
    plainOptions: false
  }
}

/** A Run of this Harness that ran, answered, and saved its Thread. */
function ranAndSaved(runId: string, harness: 'codex' | 'claude'): ConversationEntry[] {
  return [opened(runId, harness), answered(runId), ended(runId, 'run-completed')]
}

/** The record of a compaction, by the app or by the Harness itself. */
function compacted(
  runId: string,
  compaction: { summary: string; tailFromEntryId: string; native?: boolean }
): BoundaryEntry {
  return {
    kind: 'boundary',
    id: `boundary:compacted:${runId}`,
    at: '2026-08-09T12:00:00.000Z',
    runId,
    boundary: 'compacted',
    summary: 'Compacted',
    submissionId: null,
    recovery: null,
    compaction: { native: false, ...compaction }
  }
}

function rewound(runId: string, target: string, tail: string): BoundaryEntry {
  return {
    kind: 'boundary',
    id: `boundary:rewound:${runId}`,
    at: '2026-08-09T12:00:00.000Z',
    runId,
    boundary: 'rewound',
    summary: 'Rewound',
    submissionId: null,
    recovery: null,
    rewind: { rewoundToEntryId: target, tailFromEntryId: tail }
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
      conversationSeed(conversation([opened('run-1', 'claude')]), {
        shape: 'handoff',
        skill: null
      })
    ).toBe('Recent turns:\n(none)')
  })

  it('carries the summary in force and the turns it deliberately kept whole', () => {
    const entries = [
      message('set up receipts'),
      message('done', 'assistant'),
      compacted('run-1', {
        summary: 'Receipts render offline; the tests are green.',
        tailFromEntryId: 'message:now what?'
      }),
      message('now what?'),
      message('ship it', 'assistant')
    ]
    expect(
      conversationSeed(conversation(entries), { shape: 'compaction', skill: 'wayfinder' })
    ).toBe(
      [
        'Skill: wayfinder',
        'Summary of this Conversation up to the turns below:',
        'Receipts render offline; the tests are green.',
        'Recent turns:',
        'User: now what?',
        'Assistant: ship it'
      ].join('\n')
    )
  })

  it('carries no summary the Harness kept for itself, because that Thread was never left', () => {
    const entries = [
      message('set up receipts'),
      compacted('run-1', {
        summary: 'What the Harness kept',
        tailFromEntryId: 'message:set up receipts',
        native: true
      }),
      message('now what?')
    ]
    // Degrades to the handoff: there is no summary of this app's making, and
    // inventing one from the Harness's own would seed a Thread with a summary
    // the Harness already holds.
    expect(conversationSeed(conversation(entries), { shape: 'compaction', skill: null })).toBe(
      'Recent turns:\nUser: set up receipts\nUser: now what?'
    )
  })

  it('reads only the turns, never the rest of the Conversation', () => {
    const entries = [
      message('what changed?'),
      ended('run-1', 'run-completed'),
      message('this and that', 'assistant')
    ]
    expect(conversationSeed(conversation(entries), { shape: 'handoff', skill: null })).toBe(
      'Recent turns:\nUser: what changed?\nAssistant: this and that'
    )
  })

  it('carries only the untouched tail after a rewind', () => {
    const entries = [
      message('old context'),
      message('kept question'),
      message('kept answer', 'assistant'),
      rewound('run-2', 'message:bad prompt', 'message:kept question')
    ]
    expect(conversationSeed(conversation(entries), { shape: 'rewind', skill: 'wayfinder' })).toBe(
      ['Skill: wayfinder', 'Recent turns:', 'User: kept question', 'Assistant: kept answer'].join(
        '\n'
      )
    )
  })

  it('does not duplicate the current prompt that the adapter receives separately', () => {
    const current = message('replacement prompt')
    if (current.kind !== 'message') throw new Error('message helper returned a non-message')
    current.id = 'user:replacement'
    current.submissionId = 'replacement'
    const entries = [
      message('kept question'),
      message('kept answer', 'assistant'),
      rewound('run-2', 'message:bad prompt', 'message:kept question'),
      current
    ]
    expect(
      conversationSeed(conversation(entries), {
        shape: 'rewind',
        skill: null,
        excludeSubmissionId: 'replacement'
      })
    ).toBe('Recent turns:\nUser: kept question\nAssistant: kept answer')
  })
})

describe('a Conversation fact that vetoes Harness Thread reuse', () => {
  it('is a compaction this app performed, and only that', () => {
    for (const kind of conversationBoundarySchema.options) {
      expect(breaksContinuity({ ...ended('run-1', kind), boundary: kind })).toBe(
        kind === 'compacted' || kind === 'rewound'
      )
    }
    expect(
      breaksContinuity(
        compacted('run-1', { summary: 'kept', tailFromEntryId: 'message:x', native: true })
      )
    ).toBe(false)
  })

  it('vetoes the Thread whose later turns were rewound', () => {
    const entries = [
      ...ranAndSaved('run-1', 'claude'),
      rewound('run-1', 'message:bad prompt', 'message:run-1')
    ]
    expect(threadReuseVetoed(conversation(entries), 'claude')).toBe(true)
  })

  it('vetoes reuse of the Thread the compaction declined to resume', () => {
    const entries = [
      ...ranAndSaved('run-1', 'claude'),
      compacted('run-1', { summary: 'Receipts render offline.', tailFromEntryId: 'message:run-1' })
    ]
    expect(threadReuseVetoed(conversation(entries), 'claude')).toBe(true)
  })

  it('leaves a natively compacted Thread alone, because the Harness still holds it', () => {
    const entries = [
      ...ranAndSaved('run-1', 'claude'),
      compacted('run-1', {
        summary: 'What the Harness kept',
        tailFromEntryId: 'message:run-1',
        native: true
      })
    ]
    expect(threadReuseVetoed(conversation(entries), 'claude')).toBe(false)
  })

  it('is lifted once a Run has answered on the Thread the compaction seeded', () => {
    const entries = [
      ...ranAndSaved('run-1', 'claude'),
      compacted('run-1', { summary: 'Receipts render offline.', tailFromEntryId: 'message:run-1' }),
      ...ranAndSaved('run-2', 'claude')
    ]
    expect(threadReuseVetoed(conversation(entries), 'claude')).toBe(false)
  })

  it('is found nowhere in a Conversation of ordinary Runs', () => {
    const entries = [message('hello'), ...ranAndSaved('run-1', 'claude'), message('and again')]
    for (const kind of conversationBoundarySchema.options) {
      if (kind === 'compacted' || kind === 'rewound') continue
      expect(threadReuseVetoed(conversation([...entries, ended('run-2', kind)]), 'claude')).toBe(
        false
      )
    }
  })

  it('vetoes reuse when it follows the Run that saved the Thread', () => {
    const entries = [...ranAndSaved('run-1', 'claude'), ended('run-2', 'configuration')]
    expect(threadReuseVetoed(conversation(entries), 'claude', configurationBreak)).toBe(true)
  })

  it('leaves a Thread saved after the break alone', () => {
    const entries = [ended('run-1', 'configuration'), ...ranAndSaved('run-2', 'claude')]
    expect(threadReuseVetoed(conversation(entries), 'claude', configurationBreak)).toBe(false)
  })

  it('stands until a Run of this Harness actually saves a Thread past it', () => {
    // Neither Run after the break heard back from the Harness, so the Thread
    // behind this Conversation is still the one the break invalidated —
    // however each of them ended.
    for (const ending of ['run-failed', 'run-stopped'] as const) {
      const entries = [
        ...ranAndSaved('run-1', 'claude'),
        ended('run-2', 'configuration'),
        opened('run-3', 'claude'),
        ended('run-3', ending)
      ]
      expect(threadReuseVetoed(conversation(entries), 'claude', configurationBreak)).toBe(true)
    }
  })

  it('is lifted by a Run the person stopped once the Harness had answered in it', () => {
    const entries = [
      ...ranAndSaved('run-1', 'claude'),
      ended('run-2', 'configuration'),
      opened('run-3', 'claude'),
      answered('run-3'),
      ended('run-3', 'run-stopped')
    ]
    expect(threadReuseVetoed(conversation(entries), 'claude', configurationBreak)).toBe(false)
  })

  it('is not lifted by the person’s own message, which is written as the Run opens', () => {
    const entries = [
      ...ranAndSaved('run-1', 'claude'),
      ended('run-2', 'configuration'),
      opened('run-3', 'claude'),
      asked('run-3')
    ]
    expect(threadReuseVetoed(conversation(entries), 'claude', configurationBreak)).toBe(true)
  })

  it('is read per Harness, not across all of them', () => {
    const entries = [
      ...ranAndSaved('run-1', 'claude'),
      ended('run-2', 'configuration'),
      ...ranAndSaved('run-3', 'codex')
    ]
    const breaking = configurationBreak
    expect(threadReuseVetoed(conversation(entries), 'claude', breaking)).toBe(true)
    expect(threadReuseVetoed(conversation(entries), 'codex', breaking)).toBe(false)
  })

  it('refuses a Thread it cannot place at all rather than assuming it innocent', () => {
    const unplaceable = [message('hello'), ended('run-1', 'configuration')]
    expect(threadReuseVetoed(conversation(unplaceable), 'codex', configurationBreak)).toBe(true)
    expect(threadReuseVetoed(conversation([message('hello')]), 'codex', configurationBreak)).toBe(
      false
    )
  })
})
