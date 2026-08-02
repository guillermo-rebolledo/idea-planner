# 12 — The inbox

**What to build:** The sidebar becomes the working surface of the app. **New chat** sits above everything, then Projects, then a flat list of Sessions across every Project, grouped by **pinned / needs-attention / running / recent / archived**.

The list is flat and cross-repository on purpose. The highest-value question this app answers is "is anything waiting for me, anywhere" — an agent blocked on an approval in one repo while another is still running. Nesting Sessions under Projects buries that behind a choice the user has to make first. Project is a filter, never a container.

`needs-attention` means the agent is mid-Run and cannot proceed: an outstanding approval, or a structured question. A Session whose agent simply replied and stopped is `recent`. Getting this wrong puts every idle Session in needs-attention and makes the group worthless.

The changed-files panel this ticket originally carried is now [12b](12b-changed-files-panel.md). It needs a per-Session record of what the agent changed, which is a change to what a Run writes rather than to how Sessions are listed.

Sessions never complete. Archiving is how a Session leaves the list.

Session status arrives here rather than in ticket 03, which deliberately declined to introduce a four-value status while only one value was reachable. This ticket is where `running`, `blocked`, `idle`, and `failed` all become producible, with pinned and archived as separate user flags.

**Blocked by:** 07b, 11

**Status:** done

- [x] The sidebar shows New chat, then Projects, then a flat Session list grouped by pinned, needs-attention, running, recent, and archived
- [x] Groups are populated across all Projects at once
- [x] Clicking a Project filters the Session list without navigating into it
- [x] needs-attention contains only Sessions blocked on an approval or a structured question
- [x] Search, pin, archive, and restore work across the flat list
- [x] The collapsed rail state still surfaces needs-attention and running
- [x] `pnpm verify` passes and the packaged-shell acceptance suite covers grouping and archive
- [ ] The changed-files panel — split out as [12b](12b-changed-files-panel.md) and not built here

## Answer — where status comes from

Status is derived from the Conversation when the inbox is read, never stored beside the Session: a stored status is one that can disagree with the Conversation it describes, and the Conversation is the truth. `blocked` is an outstanding Approval Request or an unanswered structured question — the last thing anybody *said* being an assistant message that offered choices. A Run's own ending is written after that message, which is why the rule reads the last message rather than the last entry.

A Session whose agent replied and stopped is `idle` and lands in Recent. A failed Run is `failed` and also lands in Recent: nothing is waiting on an answer, so nothing is asking for attention, and putting failures in the group would dilute it the same way idle Sessions would.

## Answer — the inbox has to stay true

Status derived at read time is only as true as the last read. The inbox now refreshes on Conversation events, so a Session moves between groups as it happens rather than at the next search keystroke. That is not a checkbox the ticket wrote, but a group that is right only until something happens is not a group anybody can trust.

A stopped Run is `idle`, not `failed`: the person asked for it to stop and got what they asked for. A Run that really failed says so on its own row, which is what earns keeping failures out of Needs attention.

## Answer — the rail drops what it cannot show

Collapsing the inbox hides the search box and the Project filter, so the rail asks for every active Session and ignores both. A rail narrowed by a filter nobody can see would answer "is anything waiting for me, anywhere" with a list that leaves things out. Expanding restores the filters untouched.

## Answer — Project is a filter

Clicking a Project row toggles a filter over the flat list and nothing else — no navigation, no container. The filter is stated above the list with a way out of it, and the snapshot still reports how many Sessions are in view, so a narrowed inbox can be told apart from an empty one.

## Answer — what the shell suite proves

The packaged shell covers grouping across two Projects (a Session that has never been developed is Recent, developing one moves it to Running), the Project filter, archive and restore, and the rail naming a running Session. `needs-attention` itself is proven in the Core tests, where the rule lives: driving a real Approval Request through the packaged shell would need a fake Harness that speaks this app's MCP capability socket, which tests the fake more than the app.
