import { describe, expect, it } from 'vitest'
import { LatestAnswer } from '../renderer/src/lib/latest-answer'

/**
 * The ordering rule behind the composer's Local Run observation, which is
 * asked on Run boundaries and again when the window comes back — so two asks
 * overlapping is ordinary rather than exotic, and what the composer offers as
 * a Checkout rests on which of them it believes.
 */
describe('the newest answer', () => {
  it('wins when it is the only one', () => {
    const answers = new LatestAnswer()
    expect(answers.wins(answers.ask())).toBe(true)
  })

  it('drops an older answer that arrives after a newer one', () => {
    const answers = new LatestAnswer()
    const first = answers.ask()
    const second = answers.ask()

    expect(answers.wins(second)).toBe(true)
    // The world has already moved past what this one was asked about; letting
    // it land would offer Local while a Run is working in the working copy.
    expect(answers.wins(first)).toBe(false)
  })

  it('keeps an earlier answer when the ask after it never answers', () => {
    const answers = new LatestAnswer()
    const first = answers.ask()
    answers.ask()

    // The second ask failed, so it never comes back to win. The first is then
    // the newest anybody actually has, and discarding it for having been
    // superseded by a question nobody got an answer to would leave the
    // composer on something older than both.
    expect(answers.wins(first)).toBe(true)
  })

  it('lets the next successful ask take over again', () => {
    const answers = new LatestAnswer()
    expect(answers.wins(answers.ask())).toBe(true)
    expect(answers.wins(answers.ask())).toBe(true)
  })

  it('refuses the same answer twice', () => {
    const answers = new LatestAnswer()
    const only = answers.ask()

    expect(answers.wins(only)).toBe(true)
    expect(answers.wins(only)).toBe(false)
  })
})
