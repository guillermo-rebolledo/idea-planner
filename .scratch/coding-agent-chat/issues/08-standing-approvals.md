# 08 — Standing Approvals

**What to build:** An approval prompt offers "always allow". Choosing it records a Standing Approval for that Project, and the same action never prompts again — in this Session or any future one. The user can see and revoke them.

Standing Approvals are expressed natively as permission rules in the staged settings file, not enforced by the app. Verification confirmed that these rules are consulted *before* the permission prompt tool, so an approved call never reaches the app at all.

That result carries the main design risk of this ticket: **because rules short-circuit, a too-broad approval has no runtime interception point left.** Breadth must therefore be constrained at creation. Synthesise narrow rules — the specific command prefix, not its whole family — and show the user the literal rule being stored before they accept it.

The app must synthesise those rule strings itself; the documented mechanism for having the CLI suggest them does not fire in non-interactive runs.

Two shapes are needed: a command approval, and blanket edit permission for the Project — which is what makes Ask mode livable and is why there is no separate auto-edit mode.

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] An approval prompt offers "always allow" alongside allow and deny
- [ ] Accepting stores a Standing Approval scoped to the Session's Project
- [ ] The literal rule being stored is shown before the user accepts it, and is narrow by construction
- [ ] Repo-wide edit approval is expressible and makes subsequent edits stop prompting
- [ ] Standing Approvals are listed per Project and individually revocable
- [ ] Approvals never leak across Projects, including between two clones of the same remote
- [ ] The app writes no rules into the user's own provider configuration
- [ ] `pnpm verify` passes
