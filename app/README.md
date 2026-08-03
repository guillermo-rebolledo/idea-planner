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
pnpm typecheck    # typecheck node and web code
pnpm test:core    # Core-interface and title tests (Vitest)
pnpm test:shell   # packaged-shell acceptance tests (Playwright + Electron)
pnpm test         # typecheck + all suites
```

Lint and formatting live at the repo root and cover this package: run
`pnpm verify` there before finishing a change. See `docs/agents/code-style.md`.
