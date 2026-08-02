# 12 — The inbox

**What to build:** The sidebar becomes the working surface of the app. **New chat** sits above everything, then Repositories, then a flat list of Sessions across every Repository, grouped by **pinned / needs-attention / running / recent / archived**.

The list is flat and cross-repository on purpose. The highest-value question this app answers is "is anything waiting for me, anywhere" — an agent blocked on an approval in one repo while another is still running. Nesting Sessions under Repositories buries that behind a choice the user has to make first. Repository is a filter, never a container.

`needs-attention` means the agent is mid-Run and cannot proceed: an outstanding approval, or a structured question. A Session whose agent simply replied and stopped is `recent`. Getting this wrong puts every idle Session in needs-attention and makes the group worthless.

Each Session also carries a **changed-files panel** summarising what it has done to the Repository. Inline diffs answer "what is happening"; the panel answers "what is the state of this work" when the user returns tomorrow, without scrolling a chat log. Because [ADR 0004](../../../docs/adr/0004-in-place-primary-checkout.md) edits the primary checkout in place, a dirty starting tree means `git diff` conflates the user's edits with the agent's — so the panel is built from a per-Session record of what the agent changed, not from repository state.

Sessions never complete. Archiving is how a Session leaves the list.

**Blocked by:** 07, 11

**Status:** ready-for-agent

- [ ] The sidebar shows New chat, then Repositories, then a flat Session list grouped by pinned, needs-attention, running, recent, and archived
- [ ] Groups are populated across all Repositories at once
- [ ] Clicking a Repository filters the Session list without navigating into it
- [ ] needs-attention contains only Sessions blocked on an approval or a structured question
- [ ] Search, pin, archive, and restore work across the flat list
- [ ] Each Session shows the files the agent changed, derived from a per-Session record rather than repository state
- [ ] The changed-files panel is correct when the Repository was already dirty at Session start
- [ ] Opening a changed file shows a read-only diff; the app offers no accept or reject
- [ ] The collapsed rail state still surfaces needs-attention and running
- [ ] `pnpm verify` passes and the packaged-shell acceptance suite covers grouping and archive
