# 15 — Visual identity

**What to build:** Argos looks like a precision instrument. One coherent identity across System, Light, and Dark, expressed entirely in semantic tokens so a custom theme is later a matter of swapping values rather than editing components.

The direction is Linear-inspired, which the repo had already landed on independently. Take the *structure*, not the skin: near-achromatic surfaces, hierarchy carried by luminance rather than hue, borders so subtle they read as structure instead of decoration, translucent surfaces over solid fills, tight type with a single emphasis weight, and restraint as the dominant characteristic.

## Foundations already in place

`styles.css` has a semantic token layer in OKLCH with light and dark blocks, a `@theme inline` mapping, a 13px base size, and a reduced-motion guard. Re-point it; do not replace it.

## Type

**Geist Sans** and **Geist Mono**, both OFL. The matched pair matters because the primary content surface is code.

Self-host the variable woff2 files with local `@font-face` declarations. The `geist` npm package exports Next.js font loaders, which are useless here — take the font files from the package or the upstream release archive. No network font loading: the app is local-first and must render correctly offline.

Mono is load-bearing, not decorative. It carries every diff, path, command, and hash.

## Colour

The accent is a **deep blue**, pushed clearly away from indigo so the result is not a Linear pastiche.

Three colour families are reserved by the product and must not be used for brand or decoration:

- **green** — diff additions, and success
- **red** — diff deletions, and failure
- **amber** — the `blocked` state, which is the most important signal in the inbox

In a product whose visual job is making code changes legible, the brand colour should be the least interesting colour on screen. Distinctiveness is spent on monochrome character — surface luminance, border weight, density — not on hue.

## Tokens to add

The existing set predates the new domain and is missing roles the product now needs:

- diff addition and deletion, as background and as foreground, legible in both themes
- Session status: `running`, `blocked`, `idle`, `failed`
- an elevated surface step, since the reference's depth comes from stacked near-equal surfaces rather than shadows

## Light mode is original work

The reference is dark-mode-native: its identity lives in translucent white at 2–5% opacity over near-black, which has no light-mode equivalent. Light mode must be designed to the same principles rather than derived by inversion, and it will not look like the reference. Both themes are first-class — a macOS app that ignores system appearance reads as unfinished.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Geist Sans and Geist Mono are self-hosted as variable woff2 with local `@font-face`; no network font loading
- [ ] Every colour, type, spacing, radius, and motion value used by a component resolves through a semantic token — no raw values in components
- [ ] Light and dark are both fully specified, with light designed rather than inverted
- [ ] Diff addition/deletion and the four Session statuses have dedicated tokens, distinct from the brand accent
- [ ] Every foreground/background pair meets WCAG AA in both themes, including diff and status colours, verified rather than assumed
- [ ] Focus states are visible in both themes and never removed
- [ ] The System/Light/Dark switch still resolves the whole app, with no flash on launch or on switch
- [ ] Adding a third theme requires changing token values only — demonstrate this rather than asserting it
- [ ] The reduced-motion guard still holds for any motion added
- [ ] `pnpm verify` passes
