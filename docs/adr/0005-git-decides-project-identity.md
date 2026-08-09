# ADR 0005: Git is a required dependency, and it decides Project identity

Status: accepted
Date: 2026-08-01

Amended: 2026-08-09

## Context

A **Project** is a local git repository the user has added to the app, identified by the resolved path of its root ([ADR 0004](./0004-in-place-primary-checkout.md), `CONTEXT.md`). Two questions follow: how the app decides a folder is a repository, and what "its root" means when the user picks a folder somewhere inside one.

The obvious path is to look for a `.git` entry and walk upwards. It is wrong often enough to matter: in a linked worktree and in a submodule, `.git` is a **file** rather than a directory, and walking up by hand reimplements discovery rules git already owns and occasionally changes.

## Decision

The app **shells out to git**, and treats the git binary as a required external dependency.

A folder becomes a Project only if `git rev-parse --show-toplevel` succeeds, and the path it returns — not the path the user picked — is the Project's root and its identity. Picking any folder inside a repository therefore adds that repository, once.

A folder that is not a repository is refused, with an offer to run `git init`. Cloning is a second
explicit Git mutation: the person chooses a remote and an existing parent, and Main atomically
reserves a new child directory before Git writes into it. Main verifies that Git resolves the result
to exactly that directory before adding it as a Project. Publishing an isolated Checkout is the third
explicit Git mutation; see ADR 0007.

Spawning belongs to Main, per the follow-up decision in [ADR 0001](./0001-adopt-effect-in-core.md). Main runs the probe and hands Core the resolved root; Core validates it, decides identity, and persists. Main does not own the state transition.

## Consequences

- **A missing git binary must be reported as such.** Reporting "not a repository" for a machine with no git would send the user to fix the wrong thing. This is the failure the decision makes possible, so it is the one the app has to name precisely.
- Worktrees, submodules, and subdirectory selection are handled by git rather than by us, and keep working when git changes how it resolves them.
- Two clones of one remote resolve to two roots and stay two Projects, with separate Standing Approvals — the property `CONTEXT.md` relies on.
- Identity is a resolved path, so a Project that is moved on disk is a Project the app can no longer find. It is shown as unavailable and can be removed; re-adding it at the new path is a new Project. Re-attaching a moved Project is not supported, and would need a durable identity git does not give us.
