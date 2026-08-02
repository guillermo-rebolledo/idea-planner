# 01 — Strip the planning document machinery

**What to build:** The app keeps working — capture, open, conversation, restart — with the entire user-editable-document apparatus removed. Nothing in the product reconciles, versions, or repairs Markdown the user might have edited behind its back, because after [ADR 0002](../../../docs/adr/0002-app-owned-session-state.md) there is no such Markdown.

This is a prefactor. It ships no new behaviour; it exists so the rename in ticket 03 has a far smaller blast radius. "Make the change easy, then make the easy change."

Removed: Reference Attachments and external-content reconciliation, managed-document versions, conflict and duplicate resolution, multi-document transaction staging, and the center surfaces that presented them (reconciliation, missing, unrecoverable, restore-version).

Retained: the conversation journal, projection and recovery; persist-before-AI; per-Run usage.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Reference Attachments and external-content reconciliation are gone from the contract, Core, and Renderer
- [ ] Managed-document versions, conflicts, and duplicates are gone, along with their commands
- [ ] Transaction staging is gone; remaining writes are direct
- [ ] The reconciliation, missing, unrecoverable, and restore-version surfaces are gone
- [ ] Conversation journal, projection, and recovery are untouched and still covered by their tests
- [ ] Capture, open, converse, and restart still work end to end
- [ ] `pnpm verify` passes and the packaged-shell acceptance suite passes, with tests for deleted behaviour removed rather than skipped
