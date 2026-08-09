import type { ConversationBoundaryKind, ConversationSnapshot } from '@shared/conversation'
import type { HarnessId } from '@shared/readiness'

/**
 * What carries a Conversation across a break in its Harness Thread: the seed a
 * new Thread is started from, and the rule that decides a saved Thread must
 * not be reused at all. They live together because they answer the same
 * question from two sides — this Conversation cannot simply be resumed, so
 * what does the Harness get instead.
 */

/** How many message turns a handoff seed carries across to a new Harness Thread. */
const HANDOFF_TURNS = 8

/**
 * What a caller wants seeded into a new Harness Thread. A Run that cannot
 * reuse the saved Thread has to say what the Harness should start from, and
 * there is more than one honest answer: today the handoff — the Skill in force
 * and the turns immediately before it — and, as the Session learns to survive
 * its context window and to be rewound, a summary with an untouched tail, and
 * a tail alone. Asking by shape keeps every one of them on the same path.
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
  return SEEDS[request.shape](conversation, request)
}

/**
 * One answer per shape. Keyed by the shape itself, so a shape added to the
 * request and left unanswered here is a type error rather than a Harness
 * quietly seeded with the wrong thing.
 */
const SEEDS: Record<
  ConversationSeedRequest['shape'],
  (conversation: ConversationSnapshot, request: ConversationSeedRequest) => string
> = {
  handoff: (conversation, request) => handoffSeed(conversation, request.skill)
}

/** The Skill in force and the turns immediately before the new Thread. */
function handoffSeed(conversation: ConversationSnapshot, skill: string | null): string {
  const recent = conversation.entries
    .filter((entry) => entry.kind === 'message')
    .slice(-HANDOFF_TURNS)
    .map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.text}`)
    .join('\n')
  return [...(skill ? [`Skill: ${skill}`] : []), 'Recent turns:', recent || '(none)'].join('\n')
}

/**
 * The Conversation boundaries after which a saved Harness Thread must not be
 * reused, whatever the configuration says. Empty today: nothing a Conversation
 * can currently record breaks the Thread behind it. Compaction and rewind each
 * add one — a Harness that still remembers turns the person rewound past is a
 * Harness answering from a Conversation that no longer exists.
 */
export const CONTINUITY_BREAKING_BOUNDARIES: ReadonlySet<ConversationBoundaryKind> = new Set()

/**
 * Whether a fact in the Conversation forbids reusing this Harness's saved
 * Thread. Compatibility is otherwise decided from configuration alone — the
 * Skill, the model, and whether the Harness still holds the rollout — which
 * cannot express a break the Conversation itself declared.
 *
 * The saved Thread is placed by the last Run this Harness opened, because that
 * Run is what wrote it: the `thread` entries themselves do not survive the
 * Conversation projection, which folds them into `harnessThreads` with no
 * position of their own. A break recorded after that Run is a break the Thread
 * cannot have been told about; anything before it, the Thread already outlived
 * and is entitled to.
 *
 * `breaking` is injectable so the rule can be exercised while the vocabulary
 * it reads is still empty.
 */
export function threadReuseVetoed(
  conversation: ConversationSnapshot,
  harness: HarnessId,
  breaking: ReadonlySet<ConversationBoundaryKind> = CONTINUITY_BREAKING_BOUNDARIES
): boolean {
  const openedAt = conversation.entries.findLastIndex(
    (entry) =>
      entry.kind === 'boundary' && entry.harness === harness && !breaking.has(entry.boundary)
  )
  if (openedAt === -1) return false
  return conversation.entries
    .slice(openedAt + 1)
    .some((entry) => entry.kind === 'boundary' && breaking.has(entry.boundary))
}
