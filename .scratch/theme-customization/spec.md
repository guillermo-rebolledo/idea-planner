# Appearance customization and unified Settings

## Outcome

Argos has one large Settings dialog with General, Harnesses, and Appearance sections. Appearance
offers preset themes and a custom theme editor for background and accent colors.

## Requirements

- Settings uses a large modal with a persistent left navigation for General, Harnesses, and
  Appearance. Sidebar edges and footer areas do not use separator rules.
- General contains the existing quit-warning preference and application information.
- Harnesses embeds the existing readiness, executable selection, repair, re-check, and login-shell
  discovery behavior. The old separate Harnesses dialog is no longer a second settings surface.
- The app menu's Harnesses item opens unified Settings directly on Harnesses; Settings opens on
  General.
- Appearance offers System, Light, Dark, Graphite, Orchid, and Custom cards.
- Choosing a preset applies it immediately and dismisses the custom editor.
- Choosing Custom reveals its editor from the right with a short slide/fade. The editor is otherwise
  hidden and non-interactive. Reduced-motion preferences remove the motion.
- A custom theme has a name, background, and accent. Light and Dark keep independent color pairs,
  initially white/blue and black/blue respectively.
- "Use for both" uses a shared color pair and hides the Light/Dark editor control. Turning it off
  restores the untouched per-mode values.
- Editing the custom draft never activates Custom. Selecting the Custom card or Save & apply does.
- Custom values persist locally and survive restart. Invalid or older settings safely receive
  defaults.
- Semantic surfaces, text, hover, focus, and primary colors are derived from the actual background
  luminance, not from the Light/Dark slot label. Black in the Light slot must remain readable.
- Green, red, amber, and status/diff roles remain reserved and are not replaced by customization.
- The derived palette maintains the existing text and non-text contrast expectations.

## Verification

- Unit tests cover schemas/defaults, mode-specific preservation, palette polarity, and contrast.
- Shell coverage verifies the unified navigation and that custom editing does not activate Custom.
- `pnpm verify` passes in an environment where Electron accepts Playwright's launch arguments.

