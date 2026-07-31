import { describe, expect, it } from 'vitest'
import { suggestIdeaTitle } from './title'

describe('suggestIdeaTitle', () => {
  it('uses the first meaningful line', () => {
    expect(suggestIdeaTitle('\n\nAn app for gardeners\nMore details here')).toBe(
      'An app for gardeners'
    )
  })

  it('strips markdown markers', () => {
    expect(suggestIdeaTitle('# **Bold** heading with `code`')).toBe('Bold heading with code')
    expect(suggestIdeaTitle('- a list item')).toBe('a list item')
    expect(suggestIdeaTitle('> a quote')).toBe('a quote')
  })

  it('collapses internal whitespace', () => {
    expect(suggestIdeaTitle('too    many\tspaces')).toBe('too many spaces')
  })

  it('cuts long lines at a word boundary without trailing punctuation', () => {
    const long =
      'A very long idea description that keeps going well beyond sixty characters in total'
    const title = suggestIdeaTitle(long)
    expect(title.length).toBeLessThanOrEqual(60)
    expect(long.startsWith(title)).toBe(true)
    expect(title.endsWith(' ')).toBe(false)
  })

  it('is deterministic', () => {
    expect(suggestIdeaTitle('same input')).toBe(suggestIdeaTitle('same input'))
  })

  it('falls back for empty input', () => {
    expect(suggestIdeaTitle('')).toBe('Untitled Idea')
    expect(suggestIdeaTitle('   \n \n')).toBe('Untitled Idea')
  })
})
