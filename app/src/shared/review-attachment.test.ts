import { describe, expect, it } from 'vitest'
import {
  MAX_REVIEW_ATTACHMENTS,
  MAX_REVIEW_ATTACHMENT_LINES,
  captureReviewAttachment,
  harnessPromptWithReviewAttachments,
  reviewAttachmentLabel,
  reviewAttachmentsRefusal,
  serializeReviewAttachments,
  type ReviewAttachment,
  type ReviewHunk
} from './review-attachment'

/**
 * Review Attachments: what a person selected while reading a change, copied
 * when they selected it. The snapshot is the whole point — an attachment that
 * moves with the file would ask the agent about code nobody reviewed.
 */

const AT = '2026-08-07T10:00:00.000Z'

const HUNKS: ReviewHunk[] = [
  {
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    lines: [
      ' const greeting = "hi"',
      '-export const farewell = "bye"',
      '+export const farewell = "so long"'
    ]
  },
  {
    oldStart: 20,
    oldLines: 1,
    newStart: 20,
    newLines: 1,
    lines: ['-const token: abc123', '+const value = read()']
  }
]

const source = {
  path: 'src/greeting.ts',
  runId: 'run-1',
  entryId: 'file-change:run-1:1',
  hunks: HUNKS
}

describe('capturing reviewed code', () => {
  it('copies the whole recorded change, with its provenance', () => {
    const attachment = captureReviewAttachment(source, { scope: 'file' }, AT)

    expect(attachment).toMatchObject({
      path: 'src/greeting.ts',
      runId: 'run-1',
      entryId: 'file-change:run-1:1',
      scope: 'file',
      hunkIndex: null,
      shortened: false,
      capturedAt: AT
    })
    expect(attachment.lines).toHaveLength(5)
  })

  it('keeps a snapshot that later writes to the same file cannot move', () => {
    const attachment = captureReviewAttachment(source, { scope: 'hunk', hunkIndex: 0 }, AT)
    const before = JSON.stringify(attachment)

    // The agent writes the file again, and the panel now shows something else.
    HUNKS[0] = {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ['-export const farewell = "so long"', '+export const farewell = "goodbye"']
    }

    expect(JSON.stringify(attachment)).toBe(before)
    expect(attachment.lines).toContain('+export const farewell = "so long"')
  })

  it('numbers a line selection as the reader counted it, and keeps its span', () => {
    const attachment = captureReviewAttachment(
      { ...source, hunks: HUNKS },
      { scope: 'lines', hunkIndex: 1, lineIndexes: [1] },
      AT
    )

    expect(attachment).toMatchObject({ scope: 'lines', hunkIndex: 1, startLine: 20, endLine: 20 })
    expect(reviewAttachmentLabel(attachment)).toBe('src/greeting.ts — line 20')
  })

  it('fills the gap in a selection, because a quotation is contiguous', () => {
    const attachment = captureReviewAttachment(
      { ...source, hunks: HUNKS },
      { scope: 'lines', hunkIndex: 1, lineIndexes: [1, 0] },
      AT
    )

    expect(attachment.lines).toEqual([
      '-const token=[REDACTED: credential]',
      '+const value = read()'
    ])
  })

  it('redacts credentials before anything holds the snapshot', () => {
    const attachment = captureReviewAttachment(
      { ...source, hunks: HUNKS },
      { scope: 'hunk', hunkIndex: 1 },
      AT
    )

    expect(attachment.lines[0]).toBe('-const token=[REDACTED: credential]')
  })

  it('says so out loud when a selection was too long to keep whole', () => {
    const long: ReviewHunk = {
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: MAX_REVIEW_ATTACHMENT_LINES + 10,
      lines: Array.from(
        { length: MAX_REVIEW_ATTACHMENT_LINES + 10 },
        (_v, i) => `+line ${String(i)}`
      )
    }

    const attachment = captureReviewAttachment({ ...source, hunks: [long] }, { scope: 'file' }, AT)

    expect(attachment.lines).toHaveLength(MAX_REVIEW_ATTACHMENT_LINES)
    expect(attachment.shortened).toBe(true)
  })

  it('tells a removed line apart from the line replacing it', () => {
    const pick = (row: number) =>
      captureReviewAttachment(
        { ...source, hunks: HUNKS },
        { scope: 'lines', hunkIndex: 1, lineIndexes: [row] },
        AT
      )
    // Both are line 20 of the new file — the removed one takes the number of
    // the line it sat before — so a number alone would make them one.
    expect(pick(0).startLine).toBe(pick(1).startLine)
    expect(pick(0).id).not.toBe(pick(1).id)
  })

  it('gives the same selection the same identity, so attaching twice is once', () => {
    const first = captureReviewAttachment(
      { ...source, hunks: HUNKS },
      { scope: 'hunk', hunkIndex: 1 },
      AT
    )
    const again = captureReviewAttachment(
      { ...source, hunks: HUNKS },
      { scope: 'hunk', hunkIndex: 1 },
      '2026-08-07T11:00:00.000Z'
    )

    expect(again.id).toBe(first.id)
  })
})

function attachment(overrides: Partial<ReviewAttachment> = {}): ReviewAttachment {
  return {
    id: 'file-change:run-1:1:hunk-0',
    path: 'src/greeting.ts',
    runId: 'run-1',
    entryId: 'file-change:run-1:1',
    scope: 'hunk',
    hunkIndex: 0,
    startLine: 1,
    endLine: 2,
    lines: ['-export const farewell = "bye"', '+export const farewell = "so long"'],
    shortened: false,
    capturedAt: AT,
    ...overrides
  }
}

describe('the Harness prompt', () => {
  it('keeps the person’s own words first and the snapshots in one delimited block', () => {
    const prompt = harnessPromptWithReviewAttachments('Make this shorter', [attachment()])

    expect(prompt.startsWith('Make this shorter\n\n<reviewed-code count="1">')).toBe(true)
    expect(prompt).toContain('<selection path="src/greeting.ts" scope="hunk" lines="1-2"')
    expect(prompt.trimEnd().endsWith('</reviewed-code>')).toBe(true)
  })

  it('is deterministic for the same attachments', () => {
    const attachments = [attachment(), attachment({ id: 'second', path: 'src/other.ts' })]

    expect(serializeReviewAttachments(attachments)).toBe(serializeReviewAttachments(attachments))
  })

  it('carries relative paths only, never this machine’s', () => {
    const prompt = harnessPromptWithReviewAttachments('Fix it', [attachment()])

    expect(prompt).not.toMatch(/\/Users\/|\/home\/|^\//m)
  })

  it('cannot have an attribute closed by the value inside it', () => {
    const prompt = harnessPromptWithReviewAttachments('Fix it', [
      attachment({ path: 'src/say "hi".ts' })
    ])

    expect(prompt).toContain('path="src/say &quot;hi&quot;.ts"')
  })

  it('is the message itself when nothing is attached', () => {
    expect(harnessPromptWithReviewAttachments('Just words', [])).toBe('Just words')
  })
})

describe('bounds', () => {
  it('accepts a set that fits', () => {
    expect(reviewAttachmentsRefusal([attachment()])).toBeNull()
  })

  it('refuses more selections than a message carries', () => {
    const many = Array.from({ length: MAX_REVIEW_ATTACHMENTS + 1 }, (_v, index) =>
      attachment({ id: `attachment-${String(index)}` })
    )

    expect(reviewAttachmentsRefusal(many)).toContain('at most')
  })

  it('refuses a set too large to serialize, rather than cutting it later', () => {
    const wide = Array.from({ length: MAX_REVIEW_ATTACHMENTS }, (_v, index) =>
      attachment({
        id: `attachment-${String(index)}`,
        lines: Array.from({ length: MAX_REVIEW_ATTACHMENT_LINES }, () => '+'.padEnd(200, 'x'))
      })
    )

    expect(reviewAttachmentsRefusal(wide)).toContain('too large')
  })
})
