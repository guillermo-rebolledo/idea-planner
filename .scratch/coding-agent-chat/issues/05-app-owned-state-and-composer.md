# 05 — App-owned Session state and a composer that starts work

**What to build:** The app opens on a chat. The user types, picks or accepts a Project, sends, and a Session exists. There is no Idea Library, no folder to choose before the app is usable, and no user-visible Markdown — Sessions, Conversations, and Runs are app-owned state in application support, per [ADR 0002](../../../docs/adr/0002-app-owned-session-state.md).

Home *is* a new chat. A **New chat** action sits above everything in the sidebar and returns to the same surface. Selecting an existing Session opens it. The target Project is prominently displayed in the composer rather than tucked into a subtle dropdown, because after [ADR 0004](../../../docs/adr/0004-in-place-primary-checkout.md) sending to the wrong Project means real edits in the wrong place.

Onboarding is reduced accordingly: it asks the user to add their first Project, not to choose a library.

## A regression this ticket must close

Ticket 01 removed transactional staging, so multi-document writes became several sequential file writes with no atomicity. It removed the safety net in the same change: a partially written Idea no longer parses, and the summary reader returns nothing for it, so **the Idea disappears from the inbox without a word**.

That was accepted deliberately rather than repaired, because the file-per-Idea model this ticket replaces was about to stop existing — rebuilding transactional Markdown writes would have been work thrown away. It is recorded here so the acceptance of app-owned state is also the moment the durability hole closes.

Whatever store this ticket introduces must make a write either land or not land, and must never silently drop a Session because its state was written halfway.

**Blocked by:** 03, 04

**Status:** ready-for-agent

- [ ] A partially completed write never results in a Session vanishing or being silently skipped
- [ ] Sessions, Conversations, and Runs persist as app-owned state and survive restart
- [ ] The launch surface is a composer with a Project selector defaulting to the last used
- [ ] A Session is created on send, not before, and appears in the sidebar
- [ ] The `+` on a Project row opens the same composer pre-bound to it
- [ ] The target Project is unmissable in the composer
- [ ] Onboarding asks for a first Project; no library path is requested anywhere
- [ ] Losing application support data loses history but never loses work, since work lives in the user's repository under git
- [ ] `pnpm verify` passes and the packaged-shell acceptance suite covers restart
