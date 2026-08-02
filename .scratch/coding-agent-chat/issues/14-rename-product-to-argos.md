# 14 — Rename the product to Argos

**What to build:** The application is Argos everywhere a person or the operating system can see it — window title, application menu, About panel, installer, and the folder it keeps its data in.

The product name is Argos, after Odysseus's hound. The bundle identifier is **`com.memojiinc.argos`**, and it is fixed. Everything else here is a display string that can change later; the identifier cannot, because [ADR 0002](../../../docs/adr/0002-app-owned-session-state.md) puts all Session, Conversation, and Run state in the application-support directory keyed by it. Changing it after a build ships orphans every user's history and disturbs code signing and notarization.

Do this before any build is distributed. It is cheap now and expensive later.

Watch the spelling: **Argos**, not Argus.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] The bundle identifier is `com.memojiinc.argos` in the build configuration, signing, and notarization setup
- [ ] The application-support directory derives from that identifier, and its path is asserted by a test
- [ ] Package name, product name, window title, application menu, and About panel all read Argos
- [ ] No user-visible string refers to Ideas, the previous product name, or the previous identifier
- [ ] A packaged build installs and launches under the new identity
- [ ] Update-feed and release configuration reference the new identity consistently
- [ ] `pnpm verify` passes and the packaged-shell acceptance suite passes
