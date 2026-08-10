import { useEffect, useState } from 'react'
import type { UpdateAvailability } from '@shared/contract'

/**
 * Whether a newer Argos has been published, for a surface that says so.
 *
 * There are two ways of learning the same thing, and both are needed: what
 * Main already knows, read once, and whatever a later check finds. A surface
 * can open long after the launch-time check landed, and can be open when the
 * daily one lands.
 *
 * The read never overwrites what a check has already reported. Main answers
 * the read before it sends the announcement, so in practice they arrive that
 * way round — but an answer describing a moment before the check finished is
 * stale whenever it lands, and nothing here should have to know the order two
 * messages were dispatched in to stay correct.
 *
 * Null is the whole of what a failed read says. It is also what "no check has
 * finished" and "this is the newest version" say, which is the point (ADR
 * 0009): there is no state here that owes anybody an error.
 */
export function useUpdateAvailability(): UpdateAvailability | null {
  const [availability, setAvailability] = useState<UpdateAvailability | null>(null)

  useEffect(() => {
    void window.shell.getUpdate().then(
      (known) => setAvailability((reported) => reported ?? known),
      () => undefined
    )
    return window.shell.onUpdateAvailable(setAvailability)
  }, [])

  return availability
}
