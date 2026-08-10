# Argos

The production macOS Electron shell. This is the real Main / Core / Preload / Renderer
architecture; the throwaway prototype under `prototypes/` is design evidence only.

## Architecture

- `src/main` — thin privileged Main process: window lifecycle, native dialogs and theme,
  IPC sender validation, and supervision of the Core utility process.
- `src/core` — the deep product-behavior module (`core.ts`) plus the utility-process entry
  (`index.ts`). Owns the Session lifecycle and canonical Markdown persistence. This module
  interface is the primary test seam. Internals are written with
  [Effect](https://effect.website) behind a promise-based interface — see
  `docs/adr/0001-adopt-effect-in-core.md`; Effect never leaks past Core.
- `src/preload` — the narrow context-isolated bridge. Fixed product functions only; no
  Node, filesystem, shell, raw IPC, or Electron objects reach the Renderer.
- `src/renderer` — the sandboxed React Renderer with the Focus Mailbox frame, built from
  source-owned shadcn-style components (React 19, Tailwind CSS v4).
- `src/shared` — the versioned zod contract validated at every process boundary.

## Identity

The product is **Argos**, and the bundle identifier is **`com.memojiinc.argos`**. Both live
in `src/main/identity.ts`, which `package.json` is tested to agree with. The name is a
display string and can change; the identifier cannot, because everything the app owns —
Sessions, Conversations, Runs, settings — lives in
`~/Library/Application Support/com.memojiinc.argos` (ADR 0002), and a build is signed and
notarized under it.

## Packaging

`pnpm package` builds and produces a `dmg` and a `zip` for `arm64` and `x64` under `dist/`.
Argos is a Developer ID app distributed outside the App Store, hardened, with the
entitlements in `build/entitlements.mac.plist` — see
[ADR 0008](../docs/adr/0008-developer-id-distribution.md) for why.

Signing and notarization credentials are read from the environment and are named nowhere in
the repository. Without them the command still produces a bundle that launches locally; the
packager says plainly that it skipped both.

```bash
CSC_LINK, CSC_KEY_PASSWORD                              # the Developer ID certificate
APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID    # notarization, or:
APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER       # an App Store Connect key
```

A packaged build keeps its state where an unpackaged one does, so a Session made before
packaging is there after it. Windows and Linux are deferred.

## Updates

A packaged Argos asks the release feed once at launch, and once a day after that, whether a
newer version has been published. If one has, it says so quietly — a dot on the sidebar footer,
a row in Settings ▸ About — and taking it opens the release in the browser, where the person
installs it themselves.

Argos never downloads, replaces, or relaunches itself; see
[ADR 0009](../docs/adr/0009-notify-only-updates.md) for why an app that spawns agents with write
access to repositories does not take an update channel into its own bundle. A check that fails is
silent and holds nothing up, and nothing is awaited on the way to a window.

The feed and the release page are both derived from `RELEASE_REPOSITORY` in `src/main/identity.ts`,
which `package.json` is tested to agree with, and the version compared against it comes from the
bundle. An update is an ordinary reinstall, so Sessions and Standing Approvals are exactly where
they were: the state directory is keyed by the bundle identifier (ADR 0002), not by the build.

## Visual identity

`src/renderer/src/styles.css` holds the whole identity in two layers: families
(what a colour is) and roles (what it means). Components name roles only —
never a value, never a family — which is what makes a theme a block of values
and nothing else. A raw colour or a bracketed size in a component is an ESLint
error, `src/shared/theme.test.ts` computes WCAG contrast for every pair in
every theme, and `tests/design.spec.ts` re-skins the running app from invented
values to prove nothing is hard-coded.

Geist and Geist Mono are self-hosted under `src/renderer/src/assets/fonts`
(SIL OFL, licence alongside them). Nothing about the app loads over a network.

## Commands

```bash
pnpm dev          # run the app with hot reload
pnpm build        # build main, preload, core, and renderer bundles
pnpm start        # preview the built app
pnpm package      # build and package a signed, notarized macOS app into dist/
pnpm typecheck    # typecheck node and web code
pnpm test:core    # Core-interface and title tests (Vitest)
pnpm test:shell   # packaged-shell acceptance tests (Playwright + Electron)
pnpm test         # typecheck + all suites
```

Lint and formatting live at the repo root and cover this package: run
`pnpm verify` there before finishing a change. See `docs/agents/code-style.md`.
