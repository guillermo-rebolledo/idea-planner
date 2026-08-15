import { describe, expect, it } from 'vitest'
import {
  describeDiskSize,
  holdsUnshownWork,
  removeWorktreesInputSchema,
  worktreeRemovalSchema
} from './worktree'

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
    const operationId = '00000000-0000-4000-8000-000000000000'
    expect(
      removeWorktreesInputSchema.safeParse({ projectRoot: '/p', operationId, paths: [] }).success
    ).toBe(false)
    expect(
      removeWorktreesInputSchema.safeParse({ projectRoot: '/p', operationId, paths: ['/p/one'] })
        .success
    ).toBe(true)
    // And never without naming the list it answers.
    expect(
      removeWorktreesInputSchema.safeParse({ projectRoot: '/p', paths: ['/p/one'] }).success
    ).toBe(false)
  })

  it('refuses only what has gained something since the person read it', () => {
    const observed = {
      status: 'observed',
      uncommittedChanges: false,
      commitsOnlyHere: false,
      ignoredWork: { onlyHere: false, complete: true }
    } as const
    const clean = observed
    const dirty = { ...observed, uncommittedChanges: true } as const
    const unique = { ...observed, commitsOnlyHere: true } as const
    const secret = { ...observed, ignoredWork: { onlyHere: true, complete: true } } as const
    const partial = { ...observed, ignoredWork: { onlyHere: false, complete: false } } as const
    const unknown = { status: 'unreadable' } as const

    expect(holdsUnshownWork(clean, dirty)).toBe(true)
    expect(holdsUnshownWork(clean, unique)).toBe(true)
    // The one with no undo anywhere counts exactly like the other two.
    expect(holdsUnshownWork(clean, secret)).toBe(true)
    expect(holdsUnshownWork(secret, secret)).toBe(false)
    expect(holdsUnshownWork(secret, clean)).toBe(false)
    expect(holdsUnshownWork(secret, unknown)).toBe(false)
    // Seeing less than the row that was confirmed is its own reason to stop.
    expect(holdsUnshownWork(clean, partial)).toBe(true)
    expect(holdsUnshownWork(partial, partial)).toBe(false)
    expect(holdsUnshownWork(partial, clean)).toBe(false)
    // Could not be checked, and the list said there was nothing to lose.
    expect(holdsUnshownWork(clean, unknown)).toBe(true)

    // Warned about, and confirmed anyway: still theirs to remove.
    expect(holdsUnshownWork(dirty, dirty)).toBe(false)
    expect(holdsUnshownWork(dirty, unknown)).toBe(false)
    expect(holdsUnshownWork(unknown, dirty)).toBe(false)
    // Safer than the row that was confirmed is never a reason to refuse.
    expect(holdsUnshownWork(dirty, clean)).toBe(false)
    expect(holdsUnshownWork(unique, clean)).toBe(false)
  })

  it('carries no explanation for an outcome that needs none', () => {
    expect(worktreeRemovalSchema.parse({ path: '/p/one', outcome: 'removed' }).detail).toBeNull()
  })
})
