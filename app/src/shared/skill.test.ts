import { describe, expect, it } from 'vitest'
import { completeSkillQuery, skillFromDraft, type Skill } from './skill'

const skills: Skill[] = [
  {
    name: 'prototype',
    path: '/skills/prototype',
    source: 'global',
    harness: 'codex',
    description: 'Build a throwaway prototype.'
  },
  {
    name: 'code-review',
    path: '/skills/code-review',
    source: 'global',
    harness: 'codex',
    description: 'Review a change.'
  }
]

describe('a Skill named in a draft', () => {
  it('recognizes an available leading token without removing it from the message', () => {
    expect(skillFromDraft(skills, '/prototype')).toBe(skills[0])
    expect(skillFromDraft(skills, '/prototype Help me explore this')).toBe(skills[0])
    expect(skillFromDraft(skills, '/code-review\nReview this branch')).toBe(skills[1])
  })

  it('does not turn paths, prose, partial names, or unavailable names into Skills', () => {
    expect(skillFromDraft(skills, 'Open /prototype/file.ts')).toBeNull()
    expect(skillFromDraft(skills, 'Please use /prototype')).toBeNull()
    expect(skillFromDraft(skills, '/proto')).toBeNull()
    expect(skillFromDraft(skills, '/prototype-extra Help')).toBeNull()
    expect(skillFromDraft(skills, '/research this')).toBeNull()
  })
})

describe('choosing a Skill suggestion', () => {
  it('completes the visible slash query and leaves the caret ready for the prompt', () => {
    expect(completeSkillQuery('/', 'prototype')).toBe('/prototype ')
    expect(completeSkillQuery('/pro', 'prototype')).toBe('/prototype ')
  })

  it('leaves a draft alone when it is no longer a slash query', () => {
    expect(completeSkillQuery('/pro explain this', 'prototype')).toBe('/pro explain this')
  })
})
