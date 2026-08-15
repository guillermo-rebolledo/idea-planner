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
 *
 * This orders answers. It does not promise freshness, and it is not the place
 * to look for it. An answer adopted while a newer ask is still in flight is
 * the newest anybody has, and the pending one replaces it when it lands — the
 * reader only ever moves forward in ask order, never back. That leaves a
 * window in which what is shown predates something that has already happened,
 * and no amount of ordering closes it: an answer is stale the instant it
 * arrives, because the world it describes carried on without waiting. The
 * caller re-asks on the events that matter and shows the newest it has.
 *
 * Refusing to act on an answer merely because another is on its way is a
 * different and worse rule. It is not the same as having no answer at all —
 * which the composer does gate on, since a proposal with no evidence behind
 * it is a placeholder — and a reader that stood down every time a refresh was
 * in flight would spend a busy app unusable, guarding a few hundred
 * milliseconds nobody can observe.
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
