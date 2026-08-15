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
      reason: null,
      provisional: false
    })
  })

  it('is whatever the Project’s most recent Session used, while nothing is running', () => {
    expect(defaultCheckout({ localRunActive: false, lastUsed: 'worktree' })).toEqual({
      kind: 'isolated',
      reason: null,
      provisional: false
    })
    expect(defaultCheckout({ localRunActive: false, lastUsed: 'local' })).toEqual({
      kind: 'local',
      reason: null,
      provisional: false
    })
  })

  it('is an isolated Checkout while a Run is working in the working copy, and says why', () => {
    expect(defaultCheckout({ localRunActive: true, lastUsed: 'local' })).toEqual({
      kind: 'isolated',
      reason: 'local-run-active',
      provisional: false
    })
  })

  it('carries no reason to state when the working copy is free', () => {
    // The line is the explanation for a default that moved. A Project that
    // always works isolated did not move, and being told why every time is
    // how an explanation turns into noise.
    expect(defaultCheckout({ localRunActive: false, lastUsed: 'worktree' }).reason).toBeNull()
  })

  it('marks itself provisional while nobody has looked at what is running', () => {
    // It reads the same as a Project with nothing running, and it is not the
    // same thing. Only one of the two is safe to start a Session on.
    expect(defaultCheckout({ localRunActive: 'unknown', lastUsed: null })).toEqual({
      kind: 'local',
      reason: null,
      provisional: true
    })
  })

  it('says it could not check rather than claiming nobody is working', () => {
    // A look that came back unable to say has no answer coming, so it is not
    // waited on — but the baseline it settles for is not evidence of anything,
    // and the person is the one who may well know what the app could not find
    // out. So it is stated, and Isolated is one click away.
    expect(defaultCheckout({ localRunActive: 'unreadable', lastUsed: null })).toEqual({
      kind: 'local',
      reason: 'local-runs-unreadable',
      provisional: false
    })
  })
})

describe('what the Checkout chip ends up asking for', () => {
  const occupied = defaultCheckout({ localRunActive: true, lastUsed: 'local' })
  const free = defaultCheckout({ localRunActive: false, lastUsed: 'local' })

  it('asks for the proposal, on the base the last look found', () => {
    expect(resolveCheckout({ proposed: occupied, base: 'trunk' })).toEqual({
      checkout: { kind: 'isolated', baseBranch: 'trunk' },
      reason: 'local-run-active',
      sendable: true
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
      reason: null,
      sendable: true
    })
    expect(resolveCheckout({ proposed: free, chosenKind: 'isolated', base: 'trunk' })).toEqual({
      checkout: { kind: 'isolated', baseBranch: 'trunk' },
      reason: null,
      sendable: true
    })
  })

  it('falls back to Local when there is nothing to cut from, and says nothing it cannot', () => {
    expect(resolveCheckout({ proposed: occupied, base: null })).toEqual({
      checkout: { kind: 'local' },
      // The Checkout the reason described is not the Checkout being offered,
      // so stating it would explain something that did not happen.
      reason: null,
      // Nothing is outstanding — this is the answer, not a placeholder for one.
      sendable: true
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

describe('starting a Session on a Checkout that is still being decided', () => {
  const unlooked = defaultCheckout({ localRunActive: 'unknown', lastUsed: null })
  const free = defaultCheckout({ localRunActive: false, lastUsed: null })
  const occupied = defaultCheckout({ localRunActive: true, lastUsed: 'local' })

  it('waits while the proposal is standing in for an answer', () => {
    // The composer opens on Local because that is the baseline, and the one
    // thing that would have said otherwise has not come back. Sending here is
    // the collision itself: a second Session in a working copy already being
    // written to, started in the window before the app could say so.
    expect(resolveCheckout({ proposed: unlooked, base: 'trunk' }).sendable).toBe(false)
  })

  it('goes as soon as the answer lands, either way', () => {
    expect(resolveCheckout({ proposed: free, base: 'trunk' }).sendable).toBe(true)
    expect(resolveCheckout({ proposed: occupied, base: 'trunk' }).sendable).toBe(true)
  })

  it('never waits on a Checkout the person picked themselves', () => {
    // They have answered the question the look was going to answer. Holding
    // Send would be waiting for permission to do what they already said.
    expect(resolveCheckout({ proposed: unlooked, chosenKind: 'local' }).sendable).toBe(true)
    expect(
      resolveCheckout({ proposed: unlooked, chosenKind: 'isolated', base: 'trunk' }).sendable
    ).toBe(true)
  })

  it('waits for a base an isolated ask has not been given yet', () => {
    expect(resolveCheckout({ proposed: occupied, base: undefined }).sendable).toBe(false)
    expect(
      resolveCheckout({ proposed: free, chosenKind: 'isolated', base: undefined }).sendable
    ).toBe(false)
  })
})

describe('a look that came back unable to say', () => {
  const unreadable = defaultCheckout({ localRunActive: 'unreadable', lastUsed: null })

  it('lets the person work rather than holding Send for an answer that is not coming', () => {
    // The alternative is a composer that quietly refuses to start any Session
    // at all because a projection read failed, with nothing on screen saying
    // why. That is a worse day than the collision it would be guarding.
    expect(resolveCheckout({ proposed: unreadable }).sendable).toBe(true)
    expect(resolveCheckout({ proposed: unreadable }).checkout).toEqual({ kind: 'local' })
  })

  it('carries the line saying so, so the Checkout is not read as a finding', () => {
    expect(resolveCheckout({ proposed: unreadable }).reason).toBe('local-runs-unreadable')
  })

  it('says nothing once the person has picked for themselves', () => {
    expect(resolveCheckout({ proposed: unreadable, chosenKind: 'local' }).reason).toBeNull()
    expect(
      resolveCheckout({ proposed: unreadable, chosenKind: 'isolated', base: 'trunk' }).reason
    ).toBeNull()
  })

  it('is replaced outright by a later look that can say', () => {
    // Recovery is the ordinary refresh: the next Run boundary or the window
    // coming back asks again, and a real answer takes over from this one.
    const answered = defaultCheckout({ localRunActive: true, lastUsed: null })
    expect(resolveCheckout({ proposed: answered, base: 'trunk' })).toEqual({
      checkout: { kind: 'isolated', baseBranch: 'trunk' },
      reason: 'local-run-active',
      sendable: true
    })
  })
})
