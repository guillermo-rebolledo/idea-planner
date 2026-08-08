# ADR 0007: User-triggered publishing may commit a reviewed Checkout

Status: accepted
Date: 2026-08-07
Amended: 2026-08-07

Amends [ADR 0006](./0006-app-owned-git-snapshots-and-guarded-undo.md).

## Context

A GitHub Pull Request needs a commit on a pushed branch. Argos already creates a branch for an
isolated Worktree Session, but ADR 0006 says the app writes no commits or refs. That decision keeps
automatic Run snapshots and undo out of the person's repository. Publishing is different: it is an
explicit request to turn reviewed Session work into shared Git history.

GitHub authentication also presents a choice between app-owned credentials and the person's existing
GitHub CLI authentication.

## Decision

- Argos may commit and push only when the person presses **Commit, push & create PR** after reviewing
  the title and description.
- Publishing is available for Worktree and Local Checkouts. A Worktree may commit all of its changes.
  A Local Checkout may commit only when its first app-owned Session snapshot equals the current HEAD
  tree, its real index has no staged paths, and the tree staged at confirmation exactly matches the
  tree the person reviewed. A missing baseline, pre-existing dirty state, staged work, branch movement,
  or post-review edit fails closed without committing.
- The sequence is explicit and fixed: commit the reviewed Checkout changes when present, push the current
  branch (setting its `origin` upstream when absent), then invoke `gh pr create`.
- Pull Request descriptions are passed through a mode-`0600` temporary `--body-file`, removed on every
  outcome. They are never placed in process arguments.
- GitHub authentication remains owned by `gh`. Argos stores no GitHub token and names missing CLI and
  missing authentication as different repairable conditions.
- Argos persists only the resulting PR number, URL, title, and state. This app-owned record follows
  Session lifetime: Archive retains it and Delete removes it. Main owns this external source-control
  association beside the native `gh` process; it is not a durable Conversation fact owned by Core.
- Remote state is a nullable mailbox adornment, separate from the Conversation-derived Session status.
  It refreshes only for PRs created through Argos, on mailbox demand and window focus. Successful open
  reads are cached for two minutes; failures back off from 20 seconds to 15 minutes and retain the last
  known state; merged and closed PRs are terminal.

## Consequences

- ADR 0006 still governs snapshots and undo: those mechanisms write no commits or refs and never place
  their objects in the person's repository. This ADR adds one narrow, user-triggered publishing
  exception.
- A failed publish can leave a local commit or a pushed branch even when no PR was created. The failure
  is reported plainly; those completed Git steps are not rolled back.
- `gh` must be installed and authenticated independently. Argos never installs it or signs in for the
  person.
- Local publishing is intentionally conservative. Existing work must be committed or unstaged by the
  person first; Argos does not guess which pre-existing or staged changes belong to a Session.
- Merging, review comments, CI/check status, stored credentials, and speculative repository-wide PR
  discovery remain out of scope.
