# 04 — Projects

**What to build:** The user can add a Project and see it in the sidebar. Adding a plain folder is refused with an offer to `git init` it, because every safety property of this product cashes out to git ([ADR 0004](../../../docs/adr/0004-in-place-primary-checkout.md)).

A Project is identified by the resolved path of its root, so two clones of the same remote are two Projects with independent trust and approvals. Git decides both whether a folder qualifies and what its root is — see [ADR 0005](../../../docs/adr/0005-git-decides-project-identity.md), which also makes the git binary a required dependency whose absence must be reported as such rather than as "not a repository".

Projects are **launchers and filters, not containers**. That shape matters for later tickets, but nothing in this one depends on it.

## Where Projects live

Projects are canonical product state, so Core validates and persists them, per [ADR 0001](../../../docs/adr/0001-adopt-effect-in-core.md): _"Main never owns canonical state transitions."_ They go in an **app-owned store in userData**, not in the library and not in Main's settings file.

This is the first piece of the store [ADR 0002](../../../docs/adr/0002-app-owned-session-state.md) describes. Ticket 05 extends the same store to Sessions, Conversations, and Runs. Putting Projects in Main's settings file instead would place canonical state in Main and buy a migration two tickets later.

## Deferred out of this ticket

Two things the original ticket asked for were moved, because this ticket does not bind Sessions to Projects — the composer that does is ticket 05.

- **The `+` on a Project row**, which starts a chat bound to that Project, and **clicking a row to filter the Session list**. Sessions have no Project until 05, so the filter would always be empty and the `+` would have nothing to bind. Ticket 05 takes the `+`; ticket 12 takes the filtering.
- **Renaming `workingDirectory` to `checkout`.** Ticket 03 declined this because the field holds a Session's own folder rather than a checkout of anything. That is still true after this ticket. It becomes true in ticket 05, which now carries it.

What remains is honest and complete: **Projects exist, are git-validated, and are visible.**

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] A native picker adds a Project, with the exact path confirmed before anything is written
- [ ] Selecting any folder inside a repository adds that repository, identified by the root git resolves
- [ ] A folder that is not a git repository is refused, with an offer to run `git init` — the only Git mutation the app performs
- [ ] A missing git binary is reported as a missing dependency, never as "not a repository"
- [ ] Adding the same Project twice is idempotent, including via two different paths inside it
- [ ] A Project whose path has disappeared is shown as unavailable and is removable, without taking the app down
- [ ] The sidebar shows a Projects section
- [ ] Removing a Project from the app never touches the directory on disk
- [ ] Projects survive restart, and losing the store never touches a repository
- [ ] `pnpm verify` passes
