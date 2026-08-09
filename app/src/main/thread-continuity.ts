import type { Compaction, ConversationEntry, ConversationSnapshot } from '@shared/conversation'
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
  shape: 'handoff' | 'compaction'
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
  handoff: (conversation, request) => handoffSeed(conversation, request.skill),
  compaction: (conversation, request) => compactionSeed(conversation, request.skill)
}

/** The Skill in force and the turns immediately before the new Thread. */
function handoffSeed(conversation: ConversationSnapshot, skill: string | null): string {
  const recent = turns(
    conversation.entries.filter((entry) => entry.kind === 'message').slice(-HANDOFF_TURNS)
  )
  return [...(skill ? [`Skill: ${skill}`] : []), 'Recent turns:', recent || '(none)'].join('\n')
}

/**
 * The summary this Session is carrying, and the turns it deliberately did not
 * summarize. This is what makes a compaction a continuation rather than a
 * fresh start: the agent begins again knowing what was already established,
 * and reads the last few turns in the person's own words.
 *
 * With no compaction to read this degrades to a handoff, which is the same
 * seed without the summary — the honest answer when there is no summary.
 */
function compactionSeed(conversation: ConversationSnapshot, skill: string | null): string {
  const compaction = latestCompaction(conversation)
  if (!compaction) return handoffSeed(conversation, skill)
  const from = conversation.entries.findIndex((entry) => entry.id === compaction.tailFromEntryId)
  const tail = turns(
    (from === -1 ? conversation.entries : conversation.entries.slice(from)).filter(
      (entry) => entry.kind === 'message'
    )
  )
  return [
    ...(skill ? [`Skill: ${skill}`] : []),
    'Summary of this Conversation up to the turns below:',
    compaction.summary,
    'Recent turns:',
    tail || '(none)'
  ].join('\n')
}

/**
 * The compaction in force, when one is: the newest the app performed itself.
 * A Harness that compacted its own Thread left nothing to seed — it still has
 * the Thread — so its record is not one of these.
 */
export function latestCompaction(conversation: ConversationSnapshot): Compaction | null {
  const boundary = conversation.entries.findLast(
    (entry) =>
      entry.kind === 'boundary' && entry.compaction !== undefined && !entry.compaction.native
  )
  return boundary?.kind === 'boundary' ? (boundary.compaction ?? null) : null
}

/** Message entries as the two speakers, one per line. */
function turns(entries: ConversationEntry[]): string {
  return entries
    .flatMap((entry) =>
      entry.kind === 'message'
        ? [`${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.text}`]
        : []
    )
    .join('\n')
}

/** A boundary entry, which is the only kind that can declare a break. */
type BoundaryEntry = Extract<ConversationEntry, { kind: 'boundary' }>

/** Whether one boundary makes the Harness Thread behind it unusable. */
export type ContinuityBreak = (entry: BoundaryEntry) => boolean

/**
 * The Conversation facts after which a saved Harness Thread must not be
 * reused, whatever the configuration says.
 *
 * A compaction is one, because the whole of it is a refusal to resume: the
 * Thread is left where it is and a fresh one is started from the summary and
 * the tail. A compaction the *Harness* performed is not, and the distinction
 * is not a detail — that Thread was never abandoned, it summarized itself and
 * carried on, and declining to resume it would throw away the very thing
 * compacting it was for.
 */
export const breaksContinuity: ContinuityBreak = (entry) =>
  entry.boundary === 'compacted' && entry.compaction?.native !== true

/**
 * The Run a Harness can only have produced this entry while answering in, or
 * null for everything the app records on its own behalf.
 *
 * How a Run ended says nothing about whether it had a Thread: a Run stopped or
 * failed during startup never heard back from the Harness, and reading either
 * ending as proof of a Thread would let such a Run bury a break the
 * Conversation declared before it. What the Harness itself produced is proof,
 * because a Harness names its Thread before it says anything else. A user's
 * own message is not — it is written as the Run opens — and a change found by
 * comparing the Checkout is not either, since the person's own edits are seen
 * the same way.
 */
function answeringRun(entry: ConversationEntry): string | null {
  switch (entry.kind) {
    case 'message':
      return entry.role === 'assistant' ? entry.runId : null
    case 'command':
    case 'read':
    case 'approval':
    case 'subagent':
    case 'plan':
      return entry.runId
    case 'file-change':
      return entry.source === 'harness' ? entry.runId : null
    case 'boundary':
    case 'usage':
    case 'thread':
    case 'app-action':
    case 'queued-submission':
    case 'steer-disposition':
    case 'queue-state':
    case 'queue-outcome':
      return null
  }
}

/**
 * Whether a fact in the Conversation forbids reusing this Harness's saved
 * Thread. Compatibility is otherwise decided from configuration alone — the
 * Skill, the model, and whether the Harness still holds the rollout — which
 * cannot express a break the Conversation itself declared.
 *
 * The saved Thread is placed by the last Run of this Harness the Harness
 * itself answered in, because that Run is what wrote it: the `thread` entries
 * themselves do not survive the Conversation projection, which folds them into
 * `harnessThreads` with no position of their own. A break recorded after that
 * Run is a break the Thread cannot have been told about; anything before it,
 * the Thread already outlived and is entitled to.
 *
 * When no Run can be found to place it — none since the break heard back from
 * the Harness, or the openings predate this journal — the whole Conversation
 * is read instead, so
 * an unplaceable Thread is refused rather than assumed innocent. The cost of
 * refusing wrongly is one re-seeded Thread; the cost of allowing wrongly is a
 * Harness answering from turns the Conversation no longer has.
 *
 * `breaking` is injectable so the rule can be exercised while the vocabulary
 * it reads is still empty.
 */
export function threadReuseVetoed(
  conversation: ConversationSnapshot,
  harness: HarnessId,
  breaking: ContinuityBreak = breaksContinuity
): boolean {
  const answered = new Set(conversation.entries.flatMap((entry) => answeringRun(entry) ?? []))
  const savedAt = conversation.entries.findLastIndex(
    (entry) =>
      entry.kind === 'boundary' &&
      entry.harness === harness &&
      !breaking(entry) &&
      answered.has(entry.runId)
  )
  // No such Run leaves `savedAt` at -1, which reads the Conversation whole.
  return conversation.entries
    .slice(savedAt + 1)
    .some((entry) => entry.kind === 'boundary' && breaking(entry))
}
