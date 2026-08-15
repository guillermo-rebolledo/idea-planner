import { describe, expect, it } from 'vitest'
import { defaultCheckout } from './checkout'

/**
 * Which Checkout a new Session is offered when the person has not said
 * (ADR 0010). Nothing here refuses anything: it decides a proposal, and the
 * composer keeps a proposal and a choice apart.
 */
describe('the New Session Checkout default', () => {
  it('is the working copy when nothing is running and nothing came before', () => {
    expect(defaultCheckout({ localRunActive: false, lastUsed: null })).toEqual({
      kind: 'local',
      reason: null
    })
  })

  it('is whatever the Project’s most recent Session used, while nothing is running', () => {
    expect(defaultCheckout({ localRunActive: false, lastUsed: 'worktree' })).toEqual({
      kind: 'isolated',
      reason: null
    })
    expect(defaultCheckout({ localRunActive: false, lastUsed: 'local' })).toEqual({
      kind: 'local',
      reason: null
    })
  })

  it('is an isolated Checkout while a Run is working in the working copy, and says why', () => {
    expect(defaultCheckout({ localRunActive: true, lastUsed: 'local' })).toEqual({
      kind: 'isolated',
      reason: 'local-run-active'
    })
  })

  it('carries no reason to state when the working copy is free', () => {
    // The line is the explanation for a default that moved. A Project that
    // always works isolated did not move, and being told why every time is
    // how an explanation turns into noise.
    expect(defaultCheckout({ localRunActive: false, lastUsed: 'worktree' }).reason).toBeNull()
  })
})
