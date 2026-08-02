# 05 — App-owned Session state and a composer that starts work

**What to build:** The app opens on a chat. The user types, picks or accepts a Repository, sends, and a Session exists. There is no Idea Library, no folder to choose before the app is usable, and no user-visible Markdown — Sessions, Conversations, and Runs are app-owned state in application support, per [ADR 0002](../../../docs/adr/0002-app-owned-session-state.md).

Home *is* a new chat. A **New chat** action sits above everything in the sidebar and returns to the same surface. Selecting an existing Session opens it. The target Repository is prominently displayed in the composer rather than tucked into a subtle dropdown, because after [ADR 0004](../../../docs/adr/0004-in-place-primary-checkout.md) sending to the wrong Repository means real edits in the wrong place.

Onboarding is reduced accordingly: it asks the user to add their first Repository, not to choose a library.

**Blocked by:** 03, 04

**Status:** ready-for-agent

- [ ] Sessions, Conversations, and Runs persist as app-owned state and survive restart
- [ ] The launch surface is a composer with a Repository selector defaulting to the last used
- [ ] A Session is created on send, not before, and appears in the sidebar
- [ ] The `+` on a Repository row opens the same composer pre-bound to it
- [ ] The target Repository is unmissable in the composer
- [ ] Onboarding asks for a first Repository; no library path is requested anywhere
- [ ] Losing application support data loses history but never loses work, since work lives in the user's repository under git
- [ ] `pnpm verify` passes and the packaged-shell acceptance suite covers restart
