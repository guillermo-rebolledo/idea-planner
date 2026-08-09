import { describe, expect, it } from 'vitest'
import {
  isSupportedGitRemote,
  projectCloneInputSchema,
  projectDisplayName,
  projectNameFromRemote
} from './project'

describe('Project source contract', () => {
  it('names Projects from POSIX and Windows roots', () => {
    expect(projectDisplayName('/Users/person/Code/argos')).toBe('argos')
    expect(projectDisplayName('C:\\Users\\person\\Code\\argos')).toBe('argos')
  })

  it('bounds and validates remote clone requests before Main receives them', () => {
    expect(
      projectCloneInputSchema.safeParse({
        source: 'github',
        repository: 'owner/repository',
        destination: 'C:\\Users\\person\\Code\\repository'
      }).success
    ).toBe(true)
    expect(
      projectCloneInputSchema.safeParse({
        source: 'github',
        repository: '--upload-pack=surprise',
        destination: '/projects/repository'
      }).success
    ).toBe(false)
  })

  it('accepts supported remotes and derives a safe destination name', () => {
    expect(isSupportedGitRemote('https://github.com/example/project.git')).toBe(true)
    expect(isSupportedGitRemote('git@github.com:example/project.git')).toBe(true)
    expect(isSupportedGitRemote('https://token@github.com/example/project.git')).toBe(false)
    expect(isSupportedGitRemote('file:///tmp/project')).toBe(false)
    expect(projectNameFromRemote('ssh://git@github.com/example/project.git')).toBe('project')
    expect(projectNameFromRemote('not a remote')).toBeNull()
  })
})
