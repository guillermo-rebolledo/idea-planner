# Appearance and custom-theme research

Date: 2026-08-08

## Recommendation

Argos can add preset and user-created themes without changing components. The existing semantic
token architecture is already the hard part: a theme is a complete block of color-family and
surface values, components consume roles, and the running-app test proves an unknown third block
can repaint the UI.

For the first custom-theme editor, ask for three things:

1. a light or dark base,
2. a background color, and
3. an accent color.

Treat those as inputs to a deterministic palette generator, not as the only two CSS variables to
override. Derive the surface ladder, text, borders, hover color, focus ring, and foreground-on-accent
from them; keep green, red, and amber reserved for existing product semantics. Reject a palette that
does not pass the same contrast matrix as a built-in theme.

In the current vocabulary, the user-facing **accent** should feed the `--primary` / `--blue` family.
The existing `--accent` role is a quiet hover/selection surface, so writing the chosen hue directly
to it would produce surprising results and could make selected text unreadable.

## What the repository already provides

- [`app/src/renderer/src/styles.css`](../../app/src/renderer/src/styles.css) defines complete light
  and dark theme blocks in OKLCH and maps semantic roles into Tailwind v4 theme variables. Components
  do not know which theme is active.
- [`app/tests/design.spec.ts`](../../app/tests/design.spec.ts) injects a third theme at runtime and
  verifies that page, text, and muted text repaint from values alone.
- [`app/src/shared/theme.test.ts`](../../app/src/shared/theme.test.ts) reads the shipped stylesheet,
  resolves aliases, and tests the actual foreground/background pairs used by the product.
- [`app/src/main/settings.ts`](../../app/src/main/settings.ts) already stores the app-wide appearance
  preference atomically in app-owned `settings.json`.
- [`app/src/shared/contract.ts`](../../app/src/shared/contract.ts), Main IPC, Preload, and
  [`App.tsx`](../../app/src/renderer/src/App.tsx) already form a validated preference -> resolved
  theme -> `data-theme` pipeline.
- [`app/src/shared/theme.ts`](../../app/src/shared/theme.ts) and `BrowserWindow.backgroundColor` keep
  the native window's first paint in step with the rendered background.
- [Visual identity ticket 15](../coding-agent-chat/issues/15-visual-identity.md) explicitly reserves
  green, red, and amber for additions/success, deletions/failure, and blocked state; it also records
  that custom themes should be value swaps rather than component variants.

This means the work is an extension of the current seam, not a new theming framework.

## Why two literal overrides are unsafe

Changing only `--background` leaves `--surface`, `--surface-raised`, `--muted`, `--border`, both text
roles, status colors, and the focus ring calibrated for the old background. Changing only a strong
accent leaves its hover and foreground colors behind. Arbitrary combinations can therefore fail:

- 4.5:1 contrast for normal text (WCAG 2.2 1.4.3),
- 3:1 contrast for meaningful UI graphics and focus indicators (WCAG 2.2 1.4.11), and
- Argos's own adjacency checks for diff and status colors.

WCAG evaluates the color pairs that actually appear adjacent, not colors in isolation. A live
preview is useful, but it is not a substitute for validating the resolved palette.

## Proposed model

Keep selection, authoring inputs, and the resolved palette separate:

```ts
type ThemeSelection =
  | { kind: 'system' }
  | { kind: 'preset'; id: PresetThemeId }
  | { kind: 'custom'; id: string }

type CustomTheme = {
  version: 1
  id: string
  name: string
  scheme: 'light' | 'dark'
  background: `#${string}`
  accent: `#${string}`
}

type ResolvedTheme = {
  id: string
  scheme: 'light' | 'dark'
  roles: Record<ThemeColorRole, string>
}
```

Validate IDs, name length, and canonical opaque sRGB hex at the shared-contract boundary. Store the
small versioned custom definition, not hand-authored CSS. The resolved role map is derived and can
change safely when the palette algorithm improves. Presets should enter the renderer as the same
`ResolvedTheme` shape even if their source values remain static and hand-tuned.

For an MVP, one custom theme is enough. The schema can still use a stable ID so adding rename,
duplicate, delete, import, or several saved themes later does not require replacing the selection
model.

Appearance is app-wide, so `SettingsStore` is the correct owner. It should not be attached to a
Project, Session, or Conversation.

## Resolution and application

1. A pure shared module resolves a preset or custom definition into every color role. Put the
   contrast math currently private to `theme.test.ts` behind this shared, testable seam.
2. Main validates and persists the selection and custom definition, resolves its light/dark scheme,
   and sets Electron's `nativeTheme.themeSource` to `system`, `light`, or `dark` as appropriate.
3. Main sets the `BrowserWindow` background to the resolved background before showing the window and
   updates it on every theme change. This preserves the existing no-flash invariant.
4. The validated `ThemeState` crossing Preload includes the resolved theme (or a tightly typed role
   map). Split theme identity from scheme: `data-theme` can name a preset/custom theme while
   `data-color-scheme='light|dark'` drives the existing dark variant and the CSS `color-scheme`
   property. The Renderer sets only allowlisted custom properties on
   `document.documentElement.style`.
5. Presets, preview, save, cancel, startup, and OS appearance changes all call the same resolver and
   application function.

CSS custom properties are specifically designed as an open-ended property set consumed through
`var()`, so the current architecture is standards-aligned. Tailwind v4's `@theme` variables are also
ordinary CSS variables at runtime. Use `style.setProperty()` with fixed property names and validated
color values; do not accept or inject a user-provided stylesheet, selector, `url()`, or arbitrary
CSS text.

Electron's `nativeTheme.themeSource` only understands `system`, `light`, and `dark`. A custom theme
therefore still needs an explicit scheme even though its visual identity has a separate ID. This
also keeps native menus, window chrome, and `prefers-color-scheme` consistent with the custom theme.

The custom palette is not available to the Renderer synchronously at module load, unlike the current
Light/Dark guess from `prefers-color-scheme`. Keep the Renderer root transparent or unrevealed over
Main's correctly painted `BrowserWindow` until boot state has been validated and its token map
applied, then reveal it atomically. Otherwise an opaque built-in background can flash before an
asynchronously loaded custom theme.

## Palette generation

Keep OKLCH as the internal working space because the app already uses it and its lightness axis makes
surface-ramp generation understandable. CSS Color 4 describes OKLCH as having improved hue,
lightness, and chroma uniformity compared with CIE LCH.

A practical generator should:

- parse the two sRGB hex inputs, convert to OKLCH, and gamut-map outputs back to displayable sRGB;
- create `surface`, `surface-raised`, `muted`, and `border` by controlled lightness steps from the
  background while retaining little enough chroma for a precision-tool surface;
- choose `foreground` and `muted-foreground` by measured contrast, not a fixed lightness cutoff;
- map the chosen accent to `primary`, derive `primary-hover` and `ring`, and choose
  `primary-foreground` by measured contrast;
- derive the quiet selection `accent` from the background/surface ramp rather than the chosen hue;
- retain semantic green/red/amber/cyan families, adjusting their lightness when necessary so every
  existing adjacency pair passes; and
- fail closed if every required pair cannot be made valid without changing the two requested colors
  beyond an explicitly documented tolerance.

Do this in TypeScript, not with the draft `color-contrast()` CSS function. A pure resolver gives Main
the exact first-paint background, makes migrations deterministic, and lets unit tests exercise every
output rather than depending on rendered computed styles.

## Settings experience

- Replace the current three-button group with a list or compact grid: System, built-in presets, and
  Custom.
- “Create theme” opens a small editor with Name, Base (Light/Dark), Background, and Accent.
- Preview immediately but keep an in-memory snapshot. Cancel restores that snapshot; Save persists
  only after validation.
- Show the generated surface/text/button samples and explain a rejected combination beside the
  offending input (for example, “This accent cannot produce readable button text”). Do not silently
  change a saved color.
- Include “Reset custom theme” and keep Light/Dark always reachable. A malformed future settings file
  must continue to fall back to System as it does today.
- Color must remain decorative for state: blocked, failed, running, additions, and deletions retain
  their labels/shapes as well as hues.

## Delivery sequence

### 1. Presets through the generalized path

- Introduce typed theme IDs/definitions and a pure resolver.
- Move Light and Dark through it without changing their values.
- Add one new hand-tuned preset to prove the selection and persistence model.
- Generalize the static `WINDOW_BACKGROUND` map into the resolved palette path.

### 2. One custom theme

- Add the versioned definition to `SettingsStore` and the validated IPC contract.
- Add the editor, live preview, save/cancel/reset, and allowlisted CSS-property application.
- Generate and validate a full role map from base/background/accent.

### 3. Multiple themes and portability, only if demanded

- Add duplicate/rename/delete and several stored definitions.
- Consider import/export of the small JSON definition only after versioning and validation are
  established. Do not import raw CSS.

## Tests and acceptance criteria

- Every preset and generated custom palette states the same complete role set.
- The existing contrast matrix runs against presets plus representative and property-generated
  custom inputs; invalid combinations return a typed error.
- Main/contract tests cover corrupt settings, schema migration, unknown selected IDs, and System
  fallback.
- Shell tests cover preview/cancel, save/relaunch, native window background, System appearance
  changes, and a custom theme whose values are absent from the stylesheet.
- Existing focus-visible, hover-transition, semantic-status, and third-theme tests remain green.
- No component gains a theme conditional or raw color.

## Open product choices

1. Should “System” mean only the existing Light/Dark pair, or eventually allow separate custom light
   and custom dark definitions? Start with the former; paired custom themes add substantial UI and
   validation surface.
2. Are fully saturated backgrounds a real requirement? If not, limiting background chroma in the
   first editor makes successful, legible palettes much easier to explain.
3. Is one custom theme enough initially? It proves the architecture and keeps management UI out of
   the first release.

## Primary sources

- [CSS Custom Properties for Cascading Variables Level 1](https://www.w3.org/TR/css-variables-1/)
- [CSS Color Module Level 4: Oklab and OKLCH](https://www.w3.org/TR/css-color-4/#ok-lab)
- [CSS Color Adjustment Level 1: `color-scheme` and forced colors](https://www.w3.org/TR/css-color-adjust-1/)
- [WCAG 2.2: 1.4.3 Contrast (Minimum) and 1.4.11 Non-text Contrast](https://www.w3.org/TR/WCAG22/#distinguishable)
- [Electron `nativeTheme`](https://www.electronjs.org/docs/latest/api/native-theme)
- [Electron `BrowserWindow` / window background](https://www.electronjs.org/docs/latest/api/browser-window)
- [Electron context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [HTML color input](https://html.spec.whatwg.org/multipage/input.html#color-state-(type=color))
- [Tailwind CSS v4 theme variables](https://tailwindcss.com/docs/theme)
- [CSSOM `CSSStyleDeclaration.setProperty`](https://drafts.csswg.org/cssom/#dom-cssstyledeclaration-setproperty)
