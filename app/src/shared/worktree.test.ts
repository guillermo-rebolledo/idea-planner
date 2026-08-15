import { describe, expect, it } from 'vitest'
import { describeDiskSize, removeWorktreesInputSchema, worktreeRemovalSchema } from './worktree'

describe('describing what a Worktree costs', () => {
  it('reads in the units a developer already thinks in', () => {
    expect(describeDiskSize(0)).toBe('0 bytes')
    expect(describeDiskSize(512)).toBe('512 bytes')
    expect(describeDiskSize(1024)).toBe('1.0 KB')
    expect(describeDiskSize(1024 * 1024 * 1.5)).toBe('1.5 MB')
    // Past ten the decimal is noise; below it, it is the difference between
    // "1 GB" and the 1.4 GB actually being reclaimed.
    expect(describeDiskSize(1024 ** 3 * 1.4)).toBe('1.4 GB')
    expect(describeDiskSize(1024 ** 3 * 42)).toBe('42 GB')
  })

  it('never reports a negative figure', () => {
    expect(describeDiskSize(-1)).toBe('0 bytes')
  })
})

describe('the reclaim contract', () => {
  it('refuses a removal that names nothing, so "remove" can never mean "all"', () => {
    expect(removeWorktreesInputSchema.safeParse({ projectRoot: '/p', paths: [] }).success).toBe(
      false
    )
    expect(
      removeWorktreesInputSchema.safeParse({ projectRoot: '/p', paths: ['/p/one'] }).success
    ).toBe(true)
  })

  it('carries no explanation for an outcome that needs none', () => {
    expect(worktreeRemovalSchema.parse({ path: '/p/one', outcome: 'removed' }).detail).toBeNull()
  })
})
