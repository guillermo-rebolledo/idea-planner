# ADR 0010: A Project already being worked in hands the next Session a Checkout of its own

Status: accepted
Date: 2026-08-10

Amends [ADR 0004](./0004-in-place-primary-checkout.md).

## Context

Two Sessions can edit one Project's working copy at the same time. Both agents can write the same
file, each measuring its changes against a tree the other is moving underneath it, and neither the
app nor the person is told. The diff each Session reports is then partly somebody else's work, which
is the one thing the per-Session changed-files record exists to prevent.

Two isolated Checkouts cannot collide, because they are different directories. So the question this
answers is which Checkout a Session is given by default — not how to detect the collision and narrate
it once both writes have landed.

The baseline this changes is deliberate and still right. ADR 0004 rejected isolation on three
grounds: the person's editor is open on the primary checkout, so an agent's work is invisible where
they are looking; a fresh worktree has no `node_modules`, `.env`, or build cache, so the first test
run either fails or costs a full install; and a running dev server points at the primary checkout, so
the agent can never observe its own change take effect. It closed by saying isolation _"earns its
keep when running many agents in parallel, which is not the baseline."_ Running several Sessions
against one Project is now the situation the product is being built for.

The second ground has been dismantled. [MEM-97](https://linear.app/memoji-inc/issue/MEM-97) carries
the Project's ignored configuration into an isolated Checkout, and
[MEM-132](https://linear.app/memoji-inc/issue/MEM-132) clones its ignored directories
copy-on-write — dependencies and build caches included, at approximately no cost. Defaulting anybody
into isolation used to trade a rare collision for a certain full install; it no longer does.

The first and third grounds survive untouched — but only for the **first** Session. A person has one
editor and one dev server, and both point at the primary checkout. A second Session running at the
same time cannot have either, so nothing is lost by isolating it. What is lost by _not_ isolating it
is the collision above: the working copy the person is looking at is one an agent is already writing
to, and a second agent joining it is not "where the person works", it is two writers and no lock.

## Decision

- **The default depends on what is running.** Starting a Session on a Project with no active Local
  Run defaults to **Local**, exactly as ADR 0004 argues. Starting one while that Project has a Run
  working in its Local Checkout defaults to an **isolated** Checkout.
- **The picker says why, in one line.** A Checkout the person did not ask for and cannot see a reason
  for reads as a bug rather than as a decision. The reason travels on the chip as well as inside the
  popover, because somebody who never opens the popover is exactly the person it is for.
- **Nothing is refused.** The person overrides in either direction and Argos argues with neither.
  Overriding to Local while a Local Run is active is allowed and is not warned about: the collision
  it risks is theirs to accept, and a default that scolds you for declining it is a rule wearing a
  suggestion's clothes.
- **A choice already made is never replaced.** The default decides what is _proposed_. Once the
  person has picked, the proposal is gone for that Project — a Run starting or ending afterwards
  moves nothing.
- **Three things have a say, in a fixed order, and none of them is stored as another.** What the app
  proposed, what the person picked, and what the last look at Git found to cut a worktree from. A
  pick outranks a proposal. An observation outranks neither: a Project with no branch to cut from
  falls back to Local so Send stays live, but that fallback is derived rather than recorded, so a
  later look that finds a branch puts the isolated ask straight back. An observation quietly filed as
  somebody's choice would be a choice nobody made and nobody could undo — and the Session it sent
  into an occupied working copy would be exactly the collision this ADR exists to prevent.
- **Not knowing yet is not the same as nothing running.** Both propose Local, and only one of them is
  safe to act on. The composer opens before it has been told what is running, so until the answer
  lands the proposal is marked provisional and Send waits on it — the same way it already waits for
  an isolated ask to be given a base. It is a moment, and it is exactly the moment in which a Session
  would otherwise be started in a working copy the app was about to say was occupied. A Checkout the
  person picked waits for nothing, because the answer it was waiting for is one they have already
  given. A look that fails is not waited on either: it settles to the baseline, since refusing to let
  somebody start work because a read failed is the worse of the two failures.
- **What is running is observed, never stored.** The Projects with an active Local Run are read from
  the same Conversation projection the inbox reads, on first ask and again on every Run boundary. So
  it covers Runs this window did not start, and it stops applying the moment they end. A Run blocked
  on an Approval Request counts: it stopped asking for permission, it did not stop owning the
  working copy.
- **This displaces the "whatever the last Session used" rule only when something is running.** With
  the working copy free, that rule is still the default, so a person who always works isolated still
  gets isolated.
- **A Checkout is still fixed at creation.** Nothing here moves a Session's Checkout after it exists.
  This is a decision about the one moment there is anything to decide.

## Considered options

- **Detect the collision and narrate it.** Rejected. It reports the damage rather than preventing it:
  by the time two Sessions have written the same file, the person has two diffs that each contain
  part of the other's work, and no tool in the app can separate them. Watching for it is also a
  standing cost on every write for an event that a directory makes impossible.
- **Reverse the baseline outright — isolated always.** Rejected, for the reasons ADR 0004 gave and
  still holds to. Isolation is right when nobody is watching; locally it fights the person's own
  toolchain, and their dev server cannot observe a change made somewhere else. Making it the rule
  would cost that on every Session to answer a case that only arises on the second concurrent one.
- **Refuse the second Local Session, or warn about it.** Rejected. The person may well know exactly
  what they are doing — two agents on unrelated corners of one repository is a real way to work — and
  an app that blocks it has decided it knows better than somebody looking at their own machine.
- **Lock the working copy for the duration of a Run.** Rejected: it makes the person a second-class
  writer in their own repository, which ADR 0004 exists to refuse.

## Consequences

- A second concurrent Session is an isolated one unless somebody says otherwise, so the app's default
  posture stops depending on the person noticing what else is running.
- The default is a function of observed state, which means it can change while the composer is open —
  a Run ending flips an untouched proposal back to Local. That is intended and is why the person's
  pick is held separately: only the proposal moves.
- Sessions in Projects with nothing running are entirely unaffected, which is most of them.
- Isolated Checkouts are created far more often, which makes their accumulation a problem the app
  must offer to solve — [MEM-133](https://linear.app/memoji-inc/issue/MEM-133) is that offer. It
  stays an offer: nothing sweeps, and neither Archive nor Delete reclaims anything.
- Making the default reachable required fixing a Run in an isolated Checkout being refused outright:
  Core compared a Run's Checkout against its Session's _Project root_ rather than against the
  Session's own Checkout, so no Run could ever start in a worktree. Defaulting people into a Checkout
  no Run could start in would have been the regression, not the fix.
