# ADR 0004: Sessions edit the primary checkout in place

Status: accepted
Date: 2026-08-01

## Context

A Session operates on a **Checkout** (see `CONTEXT.md`), which is either the
Project's own working directory — the **primary checkout** — or an
**isolated checkout**, a linked git worktree created from a chosen base branch.

Codex's cloud product isolates work in a worktree. A codebase as containment-
conscious as this one would be expected to do the same, so the opposite choice
needs recording.

## Decision

Sessions edit the **primary checkout in place**. Isolated checkouts are modelled
in the domain from the start. (Since MEM-72 the contract carries a Session's
Checkout and Runs execute in it; since MEM-74 the New Session composer's
Checkout chip asks for one, and the app creates the linked worktree itself —
in its own state directory, on a branch derived from the starting message,
cut from the chosen base branch.)

A Project must be a **git repository**. A plain folder cannot become one; the
app offers `git init` instead.

**Git is the only undo.** The app keeps no version history of the user's source
(see [ADR 0002](./0002-app-owned-session-state.md)), and does not gate changes
per hunk.

Amended by [ADR 0006](./0006-app-owned-git-snapshots-and-guarded-undo.md): Git
is still the mechanism, but Argos retains Session-owned Git objects for each
Run's before/after trees and applies guarded inverse patches from them. Per-hunk
application stays rejected.

Amended by [ADR 0010](./0010-contextual-checkout-default.md): the primary
checkout is still the baseline for the _first_ Session on a Project, but a
Session started while that Project has an active Local Run is isolated by
default. The install cost cited below no longer applies. The reasons below are
why that is a default and not a rule — the person overrides it in either
direction.

## Considered options

- **Isolated checkouts as the baseline.** Rejected for a _local_ app. Isolation
  is right for Codex cloud because nobody is watching, so the sandbox is the only
  guardrail. Locally it fights the user's own toolchain: their editor is open on
  the primary checkout, so the agent's work is invisible where they are looking;
  a fresh worktree has no `node_modules`, `.env`, or build cache, so the first
  test run either fails or costs a full install; and a running dev server points
  at the primary checkout, so the agent can never observe its own change take
  effect. Isolation earns its keep when running many agents in parallel, which is
  not the baseline.
- **Per-hunk accept/reject before changes land.** Rejected: it duplicates what
  the user's editor and `git add -p` already do well, and it contradicts allowing
  a single Standing Approval to let edits flow.

## Consequences

- An agent can rewrite the working tree while the user's editor is open on it.
  This is the accepted cost of working where the user works.
- Because changes land before they are reviewed, the app must make them
  immediately legible: diffs render inline in the Conversation as the agent
  works, and each Session carries a changed-files summary for when the user
  returns to it later.
- If the repository is dirty when a Session starts, `git diff` conflates the
  user's edits with the agent's. The fix is a per-Session record of changed
  files, not an isolation mechanism.
- Deferring isolation is safe only because the Checkout concept already carries
  both modes. Adding it later is a new mode, not a retrofit.
