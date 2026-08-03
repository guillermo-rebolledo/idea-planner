# 14 — Rename the product to Argos

**What to build:** The application is Argos everywhere a person or the operating system can see it — window title, application menu, About panel, installer, and the folder it keeps its data in.

The product name is Argos, after Odysseus's hound. The bundle identifier is **`com.memojiinc.argos`**, and it is fixed. Everything else here is a display string that can change later; the identifier cannot, because [ADR 0002](../../../docs/adr/0002-app-owned-session-state.md) puts all Session, Conversation, and Run state in the application-support directory keyed by it. Changing it after a build ships orphans every user's history and disturbs code signing and notarization.

Do this before any build is distributed. It is cheap now and expensive later.

Watch the spelling: **Argos**, not Argus.

**Blocked by:** None — can start immediately.

**Status:** done

- [ ] The bundle identifier is `com.memojiinc.argos` in the build configuration, signing, and notarization setup
- [x] The application-support directory derives from that identifier, and its path is asserted by a test
- [ ] Package name, product name, window title, application menu, and About panel all read Argos
- [x] No user-visible string refers to Ideas, the previous product name, or the previous identifier
- [ ] A packaged build installs and launches under the new identity
- [ ] Update-feed and release configuration reference the new identity consistently
- [x] `pnpm verify` passes and the packaged-shell acceptance suite passes

## Answer — the identifier is one string, and the name is only a display string

`app/src/main/identity.ts` holds both, and everything else reads them: the application menu and About panel through `app.setName` and `app.setAboutPanelOptions`, the window through its title, and the state directory through `stateDirectory(appData)`.

Electron would have keyed application support by the *displayed* name, which is exactly the wrong thing: renaming the product later would have quietly started every person over with an empty history. It is keyed by the identifier instead, so the name stays free to change and the identifier stays fixed.

`app/package.json` carries the same pair under `build.appId` and `productName`, which is where electron-builder reads them, and a unit test fails if the module and the manifest ever disagree. So packaging inherits the identity rather than restating it.

## Answer — the test proves the derivation instead of stepping around it

The packaged-shell suite used to substitute the state directory outright, which would have made the new derivation untestable there. It now substitutes the *application-support root*, and the app derives its own directory inside it exactly as in production — so the shell test asserts the real path, `<support>/com.memojiinc.argos`, without ever touching the state of the app installed on the machine.

It also asserts the name macOS titles the menu and About panel with, the window title, and the document title.

## Answer — what was deliberately not renamed

The throwaway prototype under `prototypes/` still says Idea everywhere. It is design evidence from the pre-pivot product (`app/README.md`), and rewording it would falsify a record rather than fix a string. Nothing in it reaches a person using the app.

## Answer — no migration was written

Nothing has shipped, so no one has state under the old name to migrate, and a migration would be permanent code serving zero users. A development machine with history under `~/Library/Application Support/Idea Development` can rename that folder to `com.memojiinc.argos` and keep it.

## Answer — what is unticked, and why

There is no packaging in the repo at all: no builder, no signing or notarization setup, no installer, no update feed. Several boxes were about renaming things that do not exist yet, so they stay unticked and are filed as **14b**:

- **The identifier in build configuration** — it is in `build.appId`, where electron-builder reads it, but there is no signing or notarization setup for it to be in.
- **The application menu** — macOS titles the app menu from the bundle's `CFBundleName`, which only a packaged build has; unpackaged it still reads Electron whatever `app.setName` says. The About panel is set explicitly and does read Argos. Everything else in that line — package name, product name, window title — is done.
- **A packaged build**, and **update-feed and release configuration** — nothing packages, and no update feed exists. An auto-updater is a channel into someone's machine and is a decision of its own, not a consequence of a rename.

The identity all of them will need is fixed and enforced now, which is the part the ticket said was cheap early and expensive later.
