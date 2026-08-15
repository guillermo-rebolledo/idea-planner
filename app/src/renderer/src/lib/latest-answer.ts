/**
 * "The newest answer wins", for a read that can be asked again before the
 * last one has answered — a refresh driven by events and by the window coming
 * back, where two asks are routinely in flight at once.
 *
 * Answers are ordered by when they were *asked*, not by when they arrive, so
 * an older one landing late cannot overwrite a newer one that already landed.
 * What it deliberately does not do is require the newest ask to be the one
 * that answers: an ask that fails simply never wins, and the best answer
 * anybody actually got stays. Insisting on the newest would throw away a good
 * answer because a later one failed, and leave the reader showing something
 * older than both.
 */
export class LatestAnswer {
  private asked = 0
  private adopted = 0

  /** Takes a ticket for an ask about to be made. */
  ask(): number {
    return ++this.asked
  }

  /** Whether this ticket's answer is the newest anybody has come back with. */
  wins(ticket: number): boolean {
    if (ticket <= this.adopted) return false
    this.adopted = ticket
    return true
  }
}
