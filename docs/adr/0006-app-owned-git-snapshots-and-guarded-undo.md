# ADR 0006: Run undo restores from app-owned Git snapshots

Status: accepted
Date: 2026-08-07

Amends [ADR 0004](./0004-in-place-primary-checkout.md) and extends
[ADR 0002](./0002-app-owned-session-state.md).

## Context

ADR 0004 said **git is the only undo**, and that is still the shape of the
answer: nothing here invents a second version-control system. What it did not
say is who holds the Git objects.

A Session edits the Checkout in place. When a Run finishes, the person can read
what it did — but the only way to put a Run back is `git checkout --` against
whatever is committed, which throws away the person's own uncommitted work
alongside the agent's, or a hand-written `git apply -R` nobody is going to
write. Between "read the diff" and "revert the whole tree" there is nothing.

Since ticket 12c the app already takes a Git tree of the Checkout before every
Run, into an app-owned object directory, precisely so a change made by a shell
command can still be seen. That snapshot is thrown away the moment the Run is
compared. It is the exact material an undo needs, deleted seconds after it was
made.

## Decision

**Git remains the undo mechanism. Argos retains the Git objects.**

- The before/after trees of every Run are kept in a **per-Session
  content-addressed object store** in application support, alongside per-Run
  metadata naming the two trees and the Checkout they describe.
- Undo is expressed as a **Git patch inverting the Run**, applied with
  `git apply`. The app writes no commits, no refs, and no new mechanism.
- Snapshot data follows **Session lifetime**: Archive retains it, and deleting a
  Session removes it. This is app-owned state under ADR 0002, and losing it
  loses undo, never work.
- The user's repository is **never written into**. Snapshots are staged through
  a **fresh temporary index** per capture and the Project's own object directory
  is added only as a **read-only alternate**, so every object the app writes
  lands in app-owned state.
- Undo is **guarded, never automatic**:
  - An **isolated checkout** may be restored directly, and only when _every_
    affected path still holds exactly what the Run left there and the Checkout
    State permits it. Any divergence downgrades the whole operation to review.
  - The **primary checkout** always shows a reviewed inverse patch first,
    because it is where the person's own editor is open.
  - Review classifies each path as **safe**, **diverged**, or **already
    restored**. One confirmation applies every safe path; diverged paths are
    left untouched. Per-hunk application stays out of scope — ADR 0004 rejected
    it and this does not reopen it.
  - A reviewed patch is bound to an opaque operation id and a digest of the tree
    it was computed against, revalidated immediately before applying. A stale
    review is refused without touching a file.
- Undo **never rewrites the Conversation**. It appends an app-action entry
  naming its source Run and what actually happened to each path.
- Undo is **not bound to ambient ⌘Z**. It is a destructive operation against
  source files, and a keystroke people press reflexively is the wrong door.

## Considered options

- **Keep throwing the snapshots away and tell people to use git.** Rejected: it
  is the status quo, and it only works for people who committed before the Run.
  The agent edits in place precisely so the work is visible where the person
  works, which is exactly where uncommitted state lives.
- **Write the snapshots into the user's repository as private refs.** Rejected
  for the same reason ADR 0002 rejected transcripts in the repository: the app
  would leave objects in every repository it touched, and `git gc`, `git fsck`,
  and the person's own tooling would all have opinions about them.
- **Commit before every Run.** Rejected: it rewrites the person's history for
  the app's convenience, and a Session that started mid-edit would commit work
  the person was not finished with.
- **Automatic undo on the primary checkout when the tree looks unchanged.**
  Rejected: "looks unchanged" is measured seconds before an editor with unsaved
  buffers writes over it. The primary checkout always asks.

## Consequences

- Application support grows with Session history. It grows in Git objects,
  which are compressed and deduplicated by content, and it is bounded by
  Session lifetime rather than by time.
- Undo is unavailable for Runs from before this shipped, and says so rather
  than offering something it cannot do.
- A Checkout State that is not clean blocks undo with the exact state named
  (MEM-93), rather than applying a patch into a half-finished merge.
- Because the app applies patches with `git apply` and never `--index`, the
  person's staging area survives an undo untouched.
