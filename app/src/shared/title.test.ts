import { describe, expect, it } from 'vitest'
import { suggestSessionTitle } from './title'

describe('suggestSessionTitle', () => {
  it('uses the first meaningful line', () => {
    expect(suggestSessionTitle('\n\nAn app for gardeners\nMore details here')).toBe(
      'An app for gardeners'
    )
  })

  it('strips markdown markers', () => {
    expect(suggestSessionTitle('# **Bold** heading with `code`')).toBe('Bold heading with code')
    expect(suggestSessionTitle('- a list item')).toBe('a list item')
    expect(suggestSessionTitle('> a quote')).toBe('a quote')
  })

  it('collapses internal whitespace', () => {
    expect(suggestSessionTitle('too    many\tspaces')).toBe('too many spaces')
  })

  it('cuts long lines at a word boundary without trailing punctuation', () => {
    const long =
      'A very long session description that keeps going well beyond sixty characters in total'
    const title = suggestSessionTitle(long)
    expect(title.length).toBeLessThanOrEqual(60)
    expect(long.startsWith(title)).toBe(true)
    expect(title.endsWith(' ')).toBe(false)
  })

  it('is deterministic', () => {
    expect(suggestSessionTitle('same input')).toBe(suggestSessionTitle('same input'))
  })

  it('falls back for empty input', () => {
    expect(suggestSessionTitle('')).toBe('Untitled Session')
    expect(suggestSessionTitle('   \n \n')).toBe('Untitled Session')
  })
})
