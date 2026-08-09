import type { ConversationBoundaryKind, ConversationSnapshot } from '@shared/conversation'
import type { HarnessId } from '@shared/readiness'

/** How many message turns a handoff seed carries across to a new Harness Thread. */
const HANDOFF_TURNS = 8

/**
 * What a caller wants seeded into a new Harness Thread. A Run that cannot reuse
 * the saved thread has to say what the Harness should start from, and there is
 * more than one honest answer: today the handoff — the Skill in force and the
 * turns immediately before it — and, as the Session learns to survive its
 * context window and to be rewound, a summary with an untouched tail, and a
 * tail alone. Asking by shape keeps every one of them on the same path.
 */
export interface ConversationSeedRequest {
  shape: 'handoff'
  /** The Skill in force for the Run being seeded, or null when there is none. */
  skill: string | null
}

/**
 * What a new Harness Thread needs to continue the Conversation, in the shape
 * the caller asked for.
 */
export function conversationSeed(
  conversation: ConversationSnapshot,
  request: ConversationSeedRequest
): string {
  const recent = conversation.entries
    .filter((entry) => entry.kind === 'message')
    .slice(-HANDOFF_TURNS)
    .map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.text}`)
    .join('\n')
  return [
    ...(request.skill ? [`Skill: ${request.skill}`] : []),
    'Recent turns:',
    recent || '(none)'
  ].join('\n')
}

/**
 * The Conversation boundaries after which a saved Harness Thread must not be
 * reused, whatever the configuration says. Empty today: nothing a Conversation
 * can currently record breaks the thread behind it. Compaction and rewind each
 * add one — a Harness that still remembers turns the person rewound past is a
 * Harness answering from a Conversation that no longer exists.
 */
export const CONTINUITY_BREAKING_BOUNDARIES: ReadonlySet<ConversationBoundaryKind> = new Set()

/**
 * Whether a fact in the Conversation forbids reusing this Harness's saved
 * Thread. Compatibility is otherwise decided from configuration alone — the
 * Skill, the model, and whether the Harness still holds the rollout — which
 * cannot express a break the Conversation itself declared. Only facts recorded
 * after the Thread was last saved can veto it; anything the Thread already
 * outlived is history it is entitled to.
 */
export function threadReuseVetoed(
  conversation: ConversationSnapshot,
  harness: HarnessId,
  breaking: ReadonlySet<ConversationBoundaryKind> = CONTINUITY_BREAKING_BOUNDARIES
): boolean {
  const savedAt = conversation.entries.findLastIndex(
    (entry) => entry.kind === 'thread' && entry.harness === harness
  )
  if (savedAt === -1) return false
  return conversation.entries
    .slice(savedAt + 1)
    .some((entry) => entry.kind === 'boundary' && breaking.has(entry.boundary))
}
