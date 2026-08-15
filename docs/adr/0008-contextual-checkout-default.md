# ADR 0008: A Project's second concurrent Session is isolated by default

Status: accepted
Date: 2026-08-09

Amends [ADR 0004](./0004-in-place-primary-checkout.md).

## Context

[ADR 0004](./0004-in-place-primary-checkout.md) rejected isolated checkouts as the
baseline on three grounds: the person's editor is open on the primary checkout, so
an agent's work is invisible where they are looking; a fresh worktree has no
`node_modules`, `.env`, or build cache, so the first test run either fails or costs
a full install; and a running dev server points at the primary checkout, so the
agent can never observe its own change take effect. It closed by saying isolation
_"earns its keep when running many agents in parallel, which is not the baseline."_

Running several Sessions against one Project is now the situation the product is
being built for, and the second ground has been dismantled: MEM-97 carries the
Project's ignored configuration into an isolated Checkout, and cloning ignored
directories carries its dependencies and build caches at approximately no cost.

The first and third grounds survive — but only for the **first** Session. A person
has one editor and one dev server, and both point at the primary checkout. A second
Session running at the same time cannot have either, so nothing is lost by isolating
it.

What is lost by _not_ isolating it is specific: two Sessions editing one working copy
can write the same file, and neither the app nor the person is told.

## Decision

**The Checkout default is contextual.** A Session started on a Project with no active
Local Run defaults to **Local**, exactly as ADR 0004 argues. A Session started while
that Project has an active Local Run defaults to an **isolated** Checkout, and the
picker states the reason.

The person may override in either direction. Nothing is refused, and no Checkout is
changed after a Session exists — a Checkout is still fixed at creation.

This displaces the composer's existing rule that a Project's default is whatever its
most recent Session used. That rule remains as the fallback when nothing is running.

## Considered options

- **Detect collisions between Local Sessions and report them.** Rejected. Two
  isolated Checkouts cannot collide, so a collision is a consequence of the default
  rather than a fact needing observation. Worse, detection is necessarily
  after-the-fact: by the time the app can see that two Sessions wrote one file, both
  writes have happened. A default prevents what a subsystem could only narrate.
- **Isolated checkouts as the baseline for every Session,** reversing ADR 0004 now
  that the install cost is gone. Rejected: two of ADR 0004's three grounds stand
  untouched, and they are precisely about the first Session — the one the person is
  watching.
- **Keep Local always and accept the collisions.** Rejected: it makes the situation
  the product is for — several Sessions on one Project — the situation it is least
  safe in.

## Consequences

- The default now depends on observed state, so the composer can offer a different
  Checkout on two visits with nothing having been chosen in between. The picker must
  state its reason, or the change reads as a bug.
- The app must know whether a Project has an active Local Run at the moment a Session
  is being composed, including Runs it did not start in this window.
- Overriding to Local while a Local Run is active remains allowed, and collisions
  remain possible there. Argos does not refuse it and does not detect it — the person
  chose it deliberately, and ADR 0004's accepted cost is the same cost.
- Isolated Checkouts are created far more often, which makes their accumulation a
  problem the app must offer to solve. It stays an offer: nothing sweeps.
