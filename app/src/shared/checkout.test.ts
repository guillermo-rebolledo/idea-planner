import { describe, expect, it } from 'vitest'
import { defaultCheckout, resolveCheckout } from './checkout'

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

describe('what the Checkout chip ends up asking for', () => {
  const occupied = defaultCheckout({ localRunActive: true, lastUsed: 'local' })
  const free = defaultCheckout({ localRunActive: false, lastUsed: 'local' })

  it('asks for the proposal, on the base the last look found', () => {
    expect(resolveCheckout({ proposed: occupied, base: 'trunk' })).toEqual({
      checkout: { kind: 'isolated', baseBranch: 'trunk' },
      reason: 'local-run-active'
    })
  })

  it('waits with no base rather than presuming one nobody has looked for yet', () => {
    // Send stays blocked for exactly as long as this: the ask is real, the
    // branch to cut it from is simply not known yet.
    expect(resolveCheckout({ proposed: occupied, base: undefined }).checkout).toEqual({
      kind: 'isolated',
      baseBranch: ''
    })
  })

  it('lets a pick outrank the proposal, in either direction', () => {
    expect(resolveCheckout({ proposed: occupied, chosenKind: 'local', base: 'trunk' })).toEqual({
      checkout: { kind: 'local' },
      // Taking a suggestion back is allowed and is not argued with: the line
      // explained an offer, and the offer has been answered.
      reason: null
    })
    expect(resolveCheckout({ proposed: free, chosenKind: 'isolated', base: 'trunk' })).toEqual({
      checkout: { kind: 'isolated', baseBranch: 'trunk' },
      reason: null
    })
  })

  it('falls back to Local when there is nothing to cut from, and says nothing it cannot', () => {
    expect(resolveCheckout({ proposed: occupied, base: null })).toEqual({
      checkout: { kind: 'local' },
      // The Checkout the reason described is not the Checkout being offered,
      // so stating it would explain something that did not happen.
      reason: null
    })
  })

  it('puts the ask back when a later look finds a branch', () => {
    // The fallback is what Git said, not what anybody decided. A Project whose
    // branches were unreadable for a moment — or that had none yet — must not
    // be stuck sending its next Session into a working copy already being
    // written to, which is the whole thing this default exists to prevent.
    const looked = resolveCheckout({ proposed: occupied, base: null })
    expect(looked.checkout).toEqual({ kind: 'local' })

    const lookedAgain = resolveCheckout({ proposed: occupied, base: 'trunk' })
    expect(lookedAgain.checkout).toEqual({ kind: 'isolated', baseBranch: 'trunk' })
    expect(lookedAgain.reason).toBe('local-run-active')
  })

  it('keeps a Local pick Local when a branch turns up later', () => {
    // The same later look, against a choice rather than a proposal. Nothing
    // about a branch appearing is an argument with somebody who has answered.
    expect(
      resolveCheckout({ proposed: occupied, chosenKind: 'local', base: null }).checkout
    ).toEqual({ kind: 'local' })
    expect(
      resolveCheckout({ proposed: occupied, chosenKind: 'local', base: 'trunk' }).checkout
    ).toEqual({ kind: 'local' })
  })
})
