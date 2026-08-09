import { z } from 'zod'
import { redactCredentials } from './redaction'

/**
 * A Review Attachment: the exact code a person pointed at while reading a
 * Session's changes, kept as it read at that moment.
 *
 * The snapshot is copied, never referenced. A file the agent edits again
 * afterwards leaves the attachment untouched, so a message that says "change
 * this" always says it about the code the person actually reviewed rather
 * than about whatever happens to be on that line by the time it is sent.
 *
 * Deliberately smaller than a review system: no threads, no replies, no
 * resolved or outdated status, nothing synchronized anywhere. One selection,
 * one snapshot, attached to one message.
 */

/** How many selections one message may carry before it stops being a message. */
export const MAX_REVIEW_ATTACHMENTS = 10

/** How many diff lines one selection keeps. */
export const MAX_REVIEW_ATTACHMENT_LINES = 200

/** How much serialized attachment text one Harness prompt may carry. */
export const MAX_REVIEW_ATTACHMENTS_CHARACTERS = 24_000

/** What the person selected: a whole recorded write, one hunk, or lines of one. */
export const reviewAttachmentScopeSchema = z.enum(['file', 'hunk', 'lines'])
export type ReviewAttachmentScope = z.infer<typeof reviewAttachmentScopeSchema>

export const reviewAttachmentSchema = z.object({
  /** Stable across every replacement of the message carrying it. */
  id: z.string().min(1).max(300),
  /** Relative to the Checkout, exactly as the Conversation recorded it. */
  path: z.string().min(1).max(1_000),
  /** The Run whose recorded change this was read from. */
  runId: z.string().min(1).max(200).nullable().default(null),
  /** The file-change entry the snapshot was taken from, for provenance. */
  entryId: z.string().min(1).max(200).nullable().default(null),
  scope: reviewAttachmentScopeSchema,
  /** Which recorded hunk, for a hunk or line selection. */
  hunkIndex: z.number().int().nonnegative().nullable().default(null),
  /** The new-file line range the selection covers, when it names one. */
  startLine: z.number().int().nonnegative().nullable().default(null),
  endLine: z.number().int().nonnegative().nullable().default(null),
  /** The reviewed patch lines, redacted, exactly as they read at capture. */
  lines: z.array(z.string().max(2_000)).max(MAX_REVIEW_ATTACHMENT_LINES),
  /** True when the selection was longer than what is kept, and was cut. */
  shortened: z.boolean().default(false),
  capturedAt: z.string().datetime()
})
export type ReviewAttachment = z.infer<typeof reviewAttachmentSchema>

/** Submission identity includes the exact reviewed-code snapshots, in order. */
export function sameReviewAttachments(
  left: ReviewAttachment[],
  right: ReviewAttachment[]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** One recorded hunk, structurally the Conversation's own `DiffHunk`. */
export interface ReviewHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

/** The recorded write a selection is read from. */
export interface ReviewAttachmentSource {
  /** Relative to the Checkout, as the Conversation recorded it. */
  path: string
  runId: string | null
  /** The file-change entry's durable id. */
  entryId: string
  hunks: ReviewHunk[]
}

/** What the person picked out of that write. */
export type ReviewSelection =
  | { scope: 'file' }
  | { scope: 'hunk'; hunkIndex: number }
  /** Indexes into the hunk's own lines; the kept range is their span. */
  | { scope: 'lines'; hunkIndex: number; lineIndexes: number[] }

/**
 * Which line of the new file each patch line is, one per patch line. A
 * removed line has no line in the new file, so it takes the number of the
 * line it sat before — which is what a person reading the diff would point
 * at. Stated once here, so what an attachment records and what the diff on
 * screen says a line is cannot disagree.
 */
export function newFileLines(hunk: ReviewHunk): number[] {
  let cursor = hunk.newStart
  return hunk.lines.map((line) => {
    if (line.startsWith('-')) return cursor
    const at = cursor
    cursor += 1
    return at
  })
}

/**
 * Takes the snapshot. Everything about it is decided here and now: the lines
 * are copied, redacted and bounded, and the id says exactly what was picked,
 * so selecting the same thing twice is the same attachment rather than a
 * second copy of it.
 */
export function captureReviewAttachment(
  source: ReviewAttachmentSource,
  selection: ReviewSelection,
  capturedAt: string
): ReviewAttachment {
  const hunks = selection.scope === 'file' ? source.hunks : [source.hunks[selection.hunkIndex]]
  const chosen = hunks.filter((hunk): hunk is ReviewHunk => hunk !== undefined)
  const picked = chosen.flatMap((hunk) => {
    const numbers = newFileLines(hunk)
    const indexes =
      selection.scope === 'lines'
        ? rangeOf(selection.lineIndexes, hunk.lines.length)
        : hunk.lines.map((_line, index) => index)
    return indexes.map((index) => ({
      text: hunk.lines[index] ?? '',
      line: numbers[index] ?? hunk.newStart
    }))
  })
  const kept = picked.slice(0, MAX_REVIEW_ATTACHMENT_LINES)
  const startLine = picked[0]?.line ?? null
  const endLine = picked.at(-1)?.line ?? null
  return reviewAttachmentSchema.parse({
    id: selectionId(source, selection),
    path: source.path,
    runId: source.runId,
    entryId: source.entryId,
    scope: selection.scope,
    hunkIndex: selection.scope === 'file' ? null : selection.hunkIndex,
    startLine,
    endLine,
    lines: kept.map((line) => redactCredentials(line.text).slice(0, 2_000)),
    // Said out loud: a selection that stops early looks exactly like one that
    // was that short, and the agent would answer about the wrong code.
    shortened: kept.length < picked.length,
    capturedAt
  })
}

/** The contiguous span the person selected, however they arrived at it. */
function rangeOf(lineIndexes: number[], length: number): number[] {
  const usable = lineIndexes.filter((index) => index >= 0 && index < length)
  if (usable.length === 0) return []
  const first = Math.min(...usable)
  const last = Math.max(...usable)
  return Array.from({ length: last - first + 1 }, (_value, offset) => first + offset)
}

/**
 * What was picked, said exactly enough to tell two picks apart. Line
 * selections are keyed by their rows in the recorded hunk rather than by
 * new-file numbers: a removed line and the line replacing it share a number,
 * and two different selections under one id would silently be one.
 */
function selectionId(source: ReviewAttachmentSource, selection: ReviewSelection): string {
  if (selection.scope === 'file') return `${source.entryId}:file`
  const where = `${source.entryId}:hunk-${String(selection.hunkIndex)}`
  if (selection.scope === 'hunk') return where
  const rows = rangeOf(selection.lineIndexes, source.hunks[selection.hunkIndex]?.lines.length ?? 0)
  return `${where}:rows-${String(rows[0] ?? 0)}-${String(rows.at(-1) ?? 0)}`
}

/** What the attachment is called wherever it is shown or announced. */
export function reviewAttachmentLabel(attachment: ReviewAttachment): string {
  if (attachment.scope === 'file') return `${attachment.path} — whole change`
  if (attachment.startLine === null || attachment.endLine === null) {
    return `${attachment.path} — hunk ${String((attachment.hunkIndex ?? 0) + 1)}`
  }
  const span =
    attachment.startLine === attachment.endLine
      ? `line ${String(attachment.startLine)}`
      : `lines ${String(attachment.startLine)}–${String(attachment.endLine)}`
  return attachment.scope === 'hunk'
    ? `${attachment.path} — hunk ${String((attachment.hunkIndex ?? 0) + 1)}, ${span}`
    : `${attachment.path} — ${span}`
}

/**
 * The attachments as the Harness reads them: one delimited block, in the
 * order they were attached, deterministic for the same input. Relative paths
 * only — an absolute path is this machine's, not this Conversation's.
 */
export function serializeReviewAttachments(attachments: ReviewAttachment[]): string {
  if (attachments.length === 0) return ''
  const blocks = attachments.map((attachment) => {
    const attributes = [
      `path="${quoted(attachment.path)}"`,
      `scope="${attachment.scope}"`,
      ...(attachment.startLine !== null && attachment.endLine !== null
        ? [`lines="${String(attachment.startLine)}-${String(attachment.endLine)}"`]
        : []),
      `captured="${quoted(attachment.capturedAt)}"`,
      ...(attachment.shortened ? ['shortened="true"'] : [])
    ].join(' ')
    // Every patch line keeps its ' ', '+' or '-' prefix, so no line of the
    // reviewed code can ever read as this block's own closing delimiter.
    return `<selection ${attributes}>\n${attachment.lines.join('\n')}\n</selection>`
  })
  return [
    `<reviewed-code count="${String(attachments.length)}">`,
    "Code the person selected while reading this Session's changes, copied when they",
    'selected it. It is historical context: the files may have changed since.',
    ...blocks,
    '</reviewed-code>'
  ].join('\n')
}

/** An attribute value that cannot end its own attribute. */
function quoted(value: string): string {
  return value.replaceAll('"', '&quot;')
}

/**
 * The exact Harness prompt for a message carrying attachments. The person's
 * own words come first and unchanged; the Conversation keeps only those.
 */
export function harnessPromptWithReviewAttachments(
  text: string,
  attachments: ReviewAttachment[]
): string {
  if (attachments.length === 0) return text
  return `${text}\n\n${serializeReviewAttachments(attachments)}`
}

/**
 * Why this set of attachments cannot be sent, or null when it can. Answered
 * before a message is committed anywhere: a selection silently cut after the
 * send is one the person never agreed to.
 */
export function reviewAttachmentsRefusal(attachments: ReviewAttachment[]): string | null {
  if (attachments.length > MAX_REVIEW_ATTACHMENTS) {
    return `A message carries at most ${String(MAX_REVIEW_ATTACHMENTS)} attached selections.`
  }
  // The per-selection line limit is not restated here: capture applies it,
  // says so with `shortened`, and the schema refuses anything longer — so a
  // check on a parsed attachment could only ever be dead code.
  if (serializeReviewAttachments(attachments).length > MAX_REVIEW_ATTACHMENTS_CHARACTERS) {
    return 'These selections are too large to send together. Remove one and try again.'
  }
  return null
}
