# 12b — The changed-files panel

**What to build:** Each Session summarises what it has done to the Project: the files the agent changed, and a read-only diff for each one.

Inline diffs in the Conversation answer "what is happening". This answers "what is the state of this work" when the person comes back tomorrow, without scrolling a chat log.

Because [ADR 0004](../../../docs/adr/0004-in-place-primary-checkout.md) edits the primary checkout in place, `git diff` conflates the person's own edits with the agent's. A Project that was already dirty when the Session started would have the person's work attributed to the agent — so the panel is built from a per-Session record of what the agent changed, not from repository state.

The app offers no accept or reject. It reports what happened; git is what decides what to keep.

Split out of ticket 12, which shipped the inbox itself. The panel is a per-Session record the app does not yet keep, and building it is a change to what a Run writes rather than to how Sessions are listed.

**Blocked by:** 12

**Status:** ready-for-agent

- [ ] Each Session shows the files the agent changed, derived from a per-Session record rather than repository state
- [ ] The changed-files panel is correct when the Project was already dirty at Session start
- [ ] Opening a changed file shows a read-only diff; the app offers no accept or reject
- [ ] `pnpm verify` passes
