# Idea Development desktop app

The production macOS Electron shell for local-first Idea development. This is the real
Main / Core / Preload / Renderer architecture; the throwaway prototype under
`prototypes/` is design evidence only.

## Architecture

- `src/main` — thin privileged Main process: window lifecycle, native dialogs and theme,
  IPC sender validation, and supervision of the Core utility process.
- `src/core` — the deep product-behavior module (`core.ts`) plus the utility-process entry
  (`index.ts`). Owns the Idea lifecycle and canonical Markdown persistence. This module
  interface is the primary test seam.
- `src/preload` — the narrow context-isolated bridge. Fixed product functions only; no
  Node, filesystem, shell, raw IPC, or Electron objects reach the Renderer.
- `src/renderer` — the sandboxed React Renderer with the Focus Mailbox frame, built from
  source-owned shadcn-style components (React 19, Tailwind CSS v4).
- `src/shared` — the versioned zod contract validated at every process boundary.

Ideas are stored as ordinary Markdown: one folder per Idea inside the user-chosen Idea
Library, with minimal frontmatter (`id`, `kind`, `status`, timestamps) and the content as
plain CommonMark. A rebuildable app-support settings file remembers the library location
and theme preference; losing it never loses an Idea.

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
