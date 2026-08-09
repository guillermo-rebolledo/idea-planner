# 14b — Distribution: package, sign, notarize, update

**What to build:** The parts of ticket 14 that have nothing to rename yet, because the repo has no packaging at all. There is no electron-builder (or Forge) configuration, no signing or notarization setup, no installer, and no update feed. `pnpm build` produces `out/`, and the shell suite launches that with the `electron` binary; nothing has ever been packaged.

The identity those things need is already fixed and enforced (14): `app/src/main/identity.ts` holds `com.memojiinc.argos` and `Argos`, and `app/package.json` carries the same pair under `build.appId` and `productName` — which is where electron-builder reads them from, so packaging inherits the identity rather than restating it. A unit test fails if the two ever disagree.

Choices this ticket has to make, none of which the rename could make for it: the builder, the targets, whether distribution is Developer ID outside the App Store or inside it, where notarization credentials come from in CI, and whether there is an update feed at all — an auto-updater is a channel into the user's machine, and ADR 0004 says git is the only undo, so a bad update is not a small thing.

**Blocked by:** None, but pointless until there is something to distribute.

**Status:** resolved — superseded by [MEM-127](https://linear.app/memoji-inc/issue/MEM-127/a-packaged-signed-notarized-argos)

- [x] A packaged build is produced by one command and launches
- [x] It is signed and notarized under `com.memojiinc.argos`, with credentials from the environment and never in the repo
- [x] The packaged app reads and writes `~/Library/Application Support/com.memojiinc.argos`, the same directory the unpackaged app uses
- [x] The application menu and About panel read Argos in the packaged build, taken from `Info.plist` rather than from `package.json`
- [ ] Update-feed and release configuration, if any, reference the same identifier — deferred to MEM-131; packaging emits the `zip` such a feed would serve
- [x] `pnpm verify` passes

## Answer

electron-builder, `dmg` and `zip` for `arm64` and `x64`, Developer ID outside the App Store under the
hardened runtime, credentials read from the environment. The decision and its reasons are recorded in
[ADR 0008](../../../docs/adr/0008-developer-id-distribution.md); `app/README.md` names the variables.
