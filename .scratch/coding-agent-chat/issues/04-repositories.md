# 04 — Repositories

**What to build:** The user can add a Repository and see it in the sidebar. Adding a plain folder is refused with an offer to `git init` it, because every safety property of this product cashes out to git ([ADR 0004](../../../docs/adr/0004-in-place-primary-checkout.md)).

A Repository is identified by the resolved path of its root, so two clones of the same remote are two Repositories with independent trust and approvals. Each row carries a `+` that starts a new chat already bound to it, and clicking the row *filters* the Session list rather than navigating into a container — Repositories are launchers, not containers.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] A native picker adds a Repository, with the exact path confirmed before anything is written
- [ ] A folder that is not a git repository is refused, with an offer to run `git init` — the only Git mutation the app performs
- [ ] Repositories are identified by resolved root path; adding the same path twice is idempotent
- [ ] A Repository whose path has disappeared is shown as unavailable and is removable, without taking the app down
- [ ] The sidebar shows a Repositories section, each row with an always-visible `+`
- [ ] Removing a Repository from the app never touches the directory on disk
- [ ] `pnpm verify` passes
