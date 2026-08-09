# ADR 0008: Argos is distributed as a Developer ID build, outside the App Store

Status: accepted
Date: 2026-08-09

## Context

Until now there was no packaging at all: `pnpm build` produced `out/`, the acceptance suite launched
that with the `electron` binary, and adopting Argos meant cloning a repository. Every other
improvement had an audience of one — the person who wrote it.

Packaging forces four decisions the repository had deferred: which builder, which targets, which
distribution channel, and where signing and notarization credentials come from.

The channel is the one that constrains the product. Argos runs a coding agent against the person's
own repositories: it spawns `claude`, `codex`, `git` and `gh`, reads and writes folders the person
chooses anywhere on disk, and keeps everything it owns in an application-support directory keyed by
the bundle identifier (ADR 0002). The Mac App Store requires Apple's App Sandbox, which grants file
access only through the person's explicit picks and forbids most of that; the sandbox exceptions
Argos would need are exactly the ones review does not grant.

## Decision

- **electron-builder** is the builder. `app/package.json` already carried `build.appId` and
  `productName` where electron-builder reads them, and a unit test fails if those disagree with
  `src/main/identity.ts`; packaging inherits the identity rather than restating it.
- **Developer ID, outside the App Store.** The build runs under the hardened runtime with
  entitlements checked into the repository at `app/build/entitlements.mac.plist` — the three
  exceptions V8 needs, and nothing else. The Mac App Store is not a deferred milestone; it is a
  channel this app's behavior does not fit.
- **Targets are `dmg` and `zip`, for `arm64` and `x64`.** The disk image is what a person installs
  from. The archive of the same bundle is what an update feed can serve later (MEM-131), which is
  cheaper to have from the first release than to add after one has shipped.
- **Credentials come from the environment.** The certificate is read from `CSC_LINK` and
  `CSC_KEY_PASSWORD`; notarization from `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
  `APPLE_TEAM_ID`, or from an App Store Connect key in `APPLE_API_KEY`, `APPLE_API_KEY_ID` and
  `APPLE_API_ISSUER`. None of them is named anywhere in the build configuration, so there is no
  place in the repository for one to be committed to. A build without them still produces a bundle
  that launches locally — unsigned, and said so plainly by the packager.
- **Windows and Linux are deferred**, not designed against. Nothing in this configuration is macOS-
  specific beyond the `mac` block.

## Consequences

- One command, `pnpm package`, produces the installable build.
- The packaged app reads and writes the same `~/Library/Application Support/com.memojiinc.argos` as
  an unpackaged one, because the directory is derived from the identifier in both. A Session made
  before packaging is present after it.
- The packaged build takes its displayed name and version from `Info.plist`, which the packager
  writes from the same identity. Main only names itself when it is _not_ packaged, where the bundle
  is Electron's own.
- Anything a child process opens by path has to survive being packed into `app.asar`. The MCP proxy
  is handed to a child as `NODE_OPTIONS=--require=…`, which Node reads before Electron's archive
  support exists, so it is listed under `asarUnpack` and addressed through `unpackedPath`.
- Notarization needs a paid Apple Developer account and network access to Apple. Releases are cut by
  someone who has both; there is no CI release pipeline yet.
- Distributing outside the App Store means Argos is responsible for its own updates. ADR 0004 makes
  git the only undo, so an auto-updater is a channel into the person's machine that has to be
  designed rather than switched on; MEM-131 does that, and this decision only leaves the archive it
  will need.
