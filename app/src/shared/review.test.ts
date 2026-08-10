import { describe, expect, it } from 'vitest'
import { MAX_FINDINGS, overlapsLines, parseReviewReport } from './review'

/**
 * Findings are read out of prose, because prose is what a reviewer writes.
 * What is asserted here is the shape it is instructed to keep — a heading that
 * names a place, a paragraph under it, an overall read at the end — and what
 * happens to everything that does not keep it.
 */
describe('parseReviewReport', () => {
  it('reads a located finding, its body, and the overall read after it', () => {
    const { findings, assessment } = parseReviewReport(
      [
        '[P2] Preserve support for non-string names — greeting.js:2',
        '',
        'Calling `name.toUpperCase()` now throws a `TypeError` for inputs the previous',
        'concatenation accepted.',
        '',
        'Overall, the remaining changes appear sound. There are no tests.'
      ].join('\n')
    )
    expect(findings).toEqual([
      {
        id: 'finding-1',
        priority: 'P2',
        title: 'Preserve support for non-string names',
        body: 'Calling `name.toUpperCase()` now throws a `TypeError` for inputs the previous\nconcatenation accepted.',
        path: 'greeting.js',
        startLine: 2,
        endLine: 2
      }
    ])
    expect(assessment).toBe('Overall, the remaining changes appear sound. There are no tests.')
  })

  it('keeps a cited range, and orders one written backwards', () => {
    const { findings } = parseReviewReport(
      ['[P1] Close the reader — src/io.ts:40-58', '', 'Body.', '', '[P3] Nit — a.ts:9-4'].join('\n')
    )
    expect(findings.map((finding) => [finding.path, finding.startLine, finding.endLine])).toEqual([
      ['src/io.ts', 40, 58],
      ['a.ts', 4, 9]
    ])
  })

  it('reads a heading a model dressed up as markdown', () => {
    const { findings } = parseReviewReport(
      '- **[P0] Guard the null branch — `src/deep/path.tsx`:120**\n\nBody.'
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      priority: 'P0',
      title: 'Guard the null branch',
      path: 'src/deep/path.tsx',
      startLine: 120
    })
  })

  it('keeps every paragraph of a finding that is not the last one', () => {
    const { findings, assessment } = parseReviewReport(
      [
        '[P1] First — a.ts:1',
        '',
        'One.',
        '',
        'Two.',
        '',
        '[P2] Second — b.ts:2',
        '',
        'Three.',
        '',
        'Four.'
      ].join('\n')
    )
    expect(findings[0]?.body).toBe('One.\n\nTwo.')
    expect(findings[1]?.body).toBe('Three.')
    expect(assessment).toBe('Four.')
  })

  it('answers a review that found nothing with no findings at all', () => {
    expect(parseReviewReport('No findings.\n')).toEqual({ findings: [], assessment: '' })
  })

  it('keeps prose that names no place out of the findings', () => {
    const { findings, assessment } = parseReviewReport(
      'The change looks fine to me, though `greet` is now stricter about its input.'
    )
    expect(findings).toEqual([])
    expect(assessment).toContain('stricter about its input')
  })

  it('redacts and bounds what it keeps, like every other stored text', () => {
    const { findings } = parseReviewReport(
      `[P1] Leaked — a.ts:1\n\ntoken: hunter2 ${'x'.repeat(9_000)}`
    )
    expect(findings[0]?.body).toContain('[REDACTED: credential]')
    expect(findings[0]?.body).not.toContain('hunter2')
    expect(findings[0]?.body.length).toBeLessThanOrEqual(4_000)
  })

  it('stops at the bound on how many findings a review keeps', () => {
    const report = Array.from(
      { length: MAX_FINDINGS + 10 },
      (_unused, index) => `[P3] Finding ${String(index)} — a.ts:${String(index + 1)}\n\nBody.\n`
    ).join('\n')
    expect(parseReviewReport(report).findings).toHaveLength(MAX_FINDINGS)
  })
})

describe('overlapsLines', () => {
  it('is true only where a diff carries a line the finding names', () => {
    const finding = { startLine: 10, endLine: 12 }
    expect(overlapsLines(finding, [8, 9, 10])).toBe(true)
    expect(overlapsLines(finding, [13, 14])).toBe(false)
  })
})
