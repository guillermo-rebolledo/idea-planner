# ADR 0009: Argos tells a person an update exists and never installs one

Status: accepted
Date: 2026-08-09

Follows [ADR 0008](./0008-developer-id-distribution.md).

## Context

Argos is distributed as a Developer ID build outside the App Store (ADR 0008), so no store tells
anybody their copy is old. A packaged app that cannot say a newer version exists leaves every person
on whatever they first downloaded, and the audience for every later improvement is whoever happens
to hear about it.

The obvious answer is an auto-updater, and Electron ships one. It is also the decision that deserves
the most care in this particular app. Argos spawns coding agents with write access to repositories
anywhere on disk, and ADR 0004 makes git the only undo for what those agents do. An update channel
is a channel into the person's machine that replaces the program holding that access, and a bad one
arriving quietly, mid-Run, is not a small thing. "Restart to update" is also a demand made of
somebody with an agent halfway through a change.

## Decision

- **Argos notifies. It does not download, replace, or relaunch itself.** There is no
  `electron-updater`, no differential download, no staged install, no `quitAndInstall`. Taking an
  update opens the published release in the person's browser, where they download and install it
  through Gatekeeper exactly as they installed it the first time. This is the deliberate position,
  not a placeholder for a silent updater later: no code path in Argos can replace Argos.
- **The check is a read of one feed.** The newest published release, from the repository Argos is
  released from — draft and prerelease excluded by asking for the latest release rather than the
  list. A version is offered only if it parses and is strictly newer than the running one, and only
  if its address is a release published where this app is published. A version arriving over the
  network with an address nobody in this repository chose is a link, not an update.
- **A failed check is silent.** Unreachable, refused, rate-limited, timed out, or answered with
  something that is not a release: all of them leave the app exactly as it would have been without a
  check. There is no error surface for an update check, because nobody opened a coding app to be
  told about their network.
- **Nothing waits on it.** The check runs after the app is up, is never awaited, and is never on a
  path a person is standing on. The Renderer reads what Main already knows; a check that lands later
  is pushed to a window that is already working. A long-lived window asks again once a day.
- **The configuration is inherited, not restated.** `src/main/identity.ts` names the release
  repository once, and the feed and the release-page prefix are derived from it; `app/package.json`
  is tested to name the same repository. The installed version is read from the bundle, which the
  packager wrote from the manifest — the same identity packaging and signing already use.
- **Only a packaged build looks.** Running from source, the version in the manifest is not a version
  anyone published a newer copy of, and a notice about it would be noise.

## Consequences

- Sessions, Conversations, Runs and Standing Approvals survive an update untouched, because the
  update is an ordinary reinstall and the application-support directory is keyed by the bundle
  identifier rather than by anything a build carries (ADR 0002).
- Adoption of a new version is slower than a silent updater's, and that is the trade being made. The
  notice is quiet by design: a dot on the sidebar footer and a row in Settings ▸ About, with no
  dialog, no toast, and no badge that has to be dismissed.
- The feed is GitHub's `releases/latest` for the release repository, read unauthenticated. It is
  rate-limited per IP; one check per launch and one a day thereafter is far inside that, and a
  refusal is one more silent check.
- Update checking is the only thing in Argos that reaches the network of its own accord. It sends
  nothing: no identifier, no version, no telemetry — it asks a public URL what the newest release
  is.
- Should a signed, delta-based updater ever be wanted, it is a new decision to be made against these
  reasons, not a switch to flip. The archive ADR 0008 already publishes is what it would need.
