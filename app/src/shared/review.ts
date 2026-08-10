import { z } from 'zod'
import { harnessIdSchema } from './readiness'
import { redactCredentials } from './redaction'

/**
 * A Review is what a Harness says about the code a Session changed, asked for
 * once and answered as Findings rather than as prose to re-locate by hand.
 *
 * It is a detached thread, not a Run: it appends nothing to the Conversation
 * and spends none of the Session's context, which is what makes it worth
 * having in exactly the long Sessions where a check is most useful. Nothing
 * here can be accepted or rejected, for the same reason a changed file cannot
 * be: the code is already on disk and git decides what to keep.
 */

/** How urgent the reviewer said a Finding is, in its own words. */
export const findingPrioritySchema = z.enum(['P0', 'P1', 'P2', 'P3'])
export type FindingPriority = z.infer<typeof findingPrioritySchema>

/** How many Findings one Review keeps. A list beyond this is not one anybody reads. */
export const MAX_FINDINGS = 50
export const MAX_FINDING_BODY = 4_000
export const MAX_REVIEW_ASSESSMENT = 4_000

/**
 * One thing the reviewer found, anchored to the place it is about. The line
 * range is in the file as it stands now — the same numbering the recorded
 * diffs use — so acting on a Finding is opening where it points.
 */
export const findingSchema = z.object({
  /** Stable within one Review, so a surface can key and focus on it. */
  id: z.string().min(1).max(100),
  /** Null when the reviewer graded nothing, which is allowed to happen. */
  priority: findingPrioritySchema.nullable().default(null),
  title: z.string().min(1).max(200),
  body: z.string().max(MAX_FINDING_BODY).default(''),
  /** Repository-relative, as the reviewer cited it. */
  path: z.string().min(1).max(500),
  startLine: z.number().int().positive(),
  /** The same as `startLine` when the reviewer cited a single line. */
  endLine: z.number().int().positive()
})
export type Finding = z.infer<typeof findingSchema>

export const reviewSchema = z.object({
  sessionId: z.string().min(1),
  harness: harnessIdSchema,
  /** When the Review was asked for and when it answered. */
  requestedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  findings: z.array(findingSchema).max(MAX_FINDINGS),
  /**
   * What the reviewer said beyond the Findings — the overall read, and the
   * gaps it wants named. Empty when it said nothing but Findings.
   */
  assessment: z.string().max(MAX_REVIEW_ASSESSMENT).default('')
})
export type Review = z.infer<typeof reviewSchema>

/**
 * What the changed-files surface knows about reviewing this Session: whether
 * this Harness can be asked at all, whether one is running, the last one that
 * answered, and why the last one did not. A Harness with no review capability
 * is stated here rather than left out, so the surface can say so instead of
 * quietly offering nothing.
 */
export const reviewStateSchema = z.object({
  /** The Harness a Review would be asked of; null when none has answered yet. */
  harness: harnessIdSchema.nullable(),
  supported: z.boolean(),
  running: z.boolean(),
  review: reviewSchema.nullable(),
  /** Why the last attempt did not answer. The Session is otherwise untouched. */
  failure: z.string().max(500).nullable().default(null)
})
export type ReviewState = z.infer<typeof reviewStateSchema>

/**
 * What a review Adapter needs to open one. The Checkout is all of it: a review
 * is about the code a Session changed, and the Session's own Harness Thread is
 * deliberately not part of the request.
 */
export const reviewLaunchSchema = z.object({ cwd: z.string().min(1) })
export type ReviewLaunch = z.infer<typeof reviewLaunchSchema>

/** One thing a review Adapter has learned from the Harness's own protocol. */
export const reviewEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('review-completed'),
    findings: z.array(findingSchema).max(MAX_FINDINGS),
    assessment: z.string().max(MAX_REVIEW_ASSESSMENT).default('')
  }),
  z.object({ type: z.literal('review-failed'), summary: z.string().min(1).max(500) })
])
export type ReviewEvent = z.infer<typeof reviewEventSchema>

/** What a review Adapter produced from one chunk: events, and frames it owes. */
export const reviewStreamSchema = z.object({
  events: z.array(reviewEventSchema),
  outgoing: z.array(z.string())
})
export type ReviewStream = z.infer<typeof reviewStreamSchema>

/**
 * One Finding heading, as the reviewer writes it:
 *
 *   [P2] Preserve support for non-string names — greeting.js:2
 *
 * The priority tag and the cited range are the two things worth insisting on;
 * everything else about the line is decoration a model may add — a bullet, a
 * heading marker, bold — and is stripped rather than required. The dash before
 * the path is written em, en, or plain depending on the model and the moment.
 */
const HEADING =
  /^\s*(?:[-*+]\s*)?(?:#{1,6}\s*)?(?:\*\*)?\s*\[?(P[0-3])\]?[:.]?\s*(.+?)\s*(?:\*\*)?\s*[—–-]\s*`?([^\s`:]+?)`?:(\d+)(?:\s*[-–—]\s*(\d+))?\s*(?:\*\*)?\s*$/u

/** What the reviewer says when it found nothing, which is a real answer. */
const NOTHING_FOUND = /^\s*no findings\.?\s*$/iu

interface ParsedReview {
  findings: Finding[]
  assessment: string
}

/**
 * Turns one review report into located Findings.
 *
 * The report is prose, because that is what the reviewer writes — but prose in
 * a shape it is instructed to keep: findings first, one heading each, one short
 * paragraph under it, then a brief overall assessment. So a heading starts a
 * Finding, the paragraph under it is its body, and whatever the reviewer added
 * after the last Finding's paragraph is the assessment rather than more of that
 * Finding. Anything written before the first heading is assessment too: it is
 * about the review, not about a place in the code.
 *
 * A line that names no place is not a Finding here, however it is written.
 * Losing one is better than drawing a row that points nowhere, which is the
 * wall of prose this surface exists to replace.
 */
export function parseReviewReport(report: string): ParsedReview {
  const lines = redactCredentials(report).split('\n')
  const preamble: string[] = []
  const blocks: { finding: Omit<Finding, 'body'>; lines: string[] }[] = []
  for (const line of lines) {
    const heading = blocks.length < MAX_FINDINGS ? HEADING.exec(line) : null
    if (heading) {
      // Every group but the second line number is required by the pattern, so
      // a match has them; the fallbacks are what the type demands, not a case.
      const [, priority = 'P3', title = '', path = '', start = '1', end] = heading
      const startLine = Number(start)
      const endLine = end === undefined ? startLine : Number(end)
      blocks.push({
        finding: {
          id: `finding-${String(blocks.length + 1)}`,
          priority: findingPrioritySchema.parse(priority),
          title:
            title
              .replaceAll(/\*\*|`/gu, '')
              .trim()
              .slice(0, 200) || path.slice(0, 200),
          path: path.slice(0, 500),
          // A reviewer that cites 12-4 has said 4-12; a range is a range.
          startLine: Math.max(1, Math.min(startLine, endLine)),
          endLine: Math.max(1, Math.max(startLine, endLine))
        },
        lines: []
      })
      continue
    }
    ;(blocks.at(-1)?.lines ?? preamble).push(line)
  }
  const trailing: string[] = [...paragraphs(preamble)]
  const findings = blocks.map(({ finding, lines: body }, index) => {
    const parts = paragraphs(body)
    // One paragraph is the documented shape. Anything the reviewer added after
    // the last Finding is the overall read it was asked for, not that Finding.
    const kept = index === blocks.length - 1 ? parts.slice(0, 1) : parts
    if (index === blocks.length - 1) trailing.push(...parts.slice(1))
    return findingSchema.parse({ ...finding, body: kept.join('\n\n').slice(0, MAX_FINDING_BODY) })
  })
  const assessment = trailing
    .filter((paragraph) => !NOTHING_FOUND.test(paragraph))
    .join('\n\n')
    .slice(0, MAX_REVIEW_ASSESSMENT)
  return { findings, assessment }
}

/** Blank-line-separated blocks of text, with nothing empty kept. */
function paragraphs(lines: string[]): string[] {
  return lines
    .join('\n')
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
}

/**
 * Whether a Finding's range overlaps a diff hunk's line numbers, which is how
 * a Finding is shown against the change it is about. Both are counted in the
 * file as it stands now.
 */
export function overlapsLines(
  finding: Pick<Finding, 'startLine' | 'endLine'>,
  numbers: number[]
): boolean {
  return numbers.some((number) => number >= finding.startLine && number <= finding.endLine)
}
