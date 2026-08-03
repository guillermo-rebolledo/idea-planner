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

One placeholder to replace: ticket 03 deleted the Software/General kind icons, which were the only content of the compact rail's buttons, and substituted a single generic message icon so the buttons kept a label. That was a stopgap, not a design decision.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] Geist Sans and Geist Mono are self-hosted as variable woff2 with local `@font-face`; no network font loading
- [x] Every colour, type, spacing, radius, and motion value used by a component resolves through a semantic token — no raw values in components
- [x] Light and dark are both fully specified, with light designed rather than inverted
- [x] Diff addition/deletion and the four Session statuses have dedicated tokens, distinct from the brand accent
- [x] Every foreground/background pair meets WCAG AA in both themes, including diff and status colours, verified rather than assumed
- [x] Focus states are visible in both themes and never removed
- [x] The System/Light/Dark switch still resolves the whole app, with no flash on launch or on switch
- [x] Adding a third theme requires changing token values only — demonstrate this rather than asserting it
- [x] The reduced-motion guard still holds for any motion added
- [x] `pnpm verify` passes

## Answer — two layers, so a theme is a block of values

**Families** are the colours, named after what they are (`--green`, `--amber`, `--blue`). **Roles** are what components ask for, named after what they mean. A component never names a family and never names a value.

A theme states its families and its own greys, and that is all: the roles that simply follow their family — the diff pair, the four statuses, the notice — are stated once outside every theme, because `var()` resolves against whichever theme is in force. So a third theme is a shorter block than the second one, not a longer one.

The theme is an attribute rather than a class, so nothing in the app can ask which theme is on; it can only ask for a role.

## Answer — the type

Geist and Geist Mono, the variable woff2 taken from the `geist` package with the OFL licence beside them, self-hosted under `assets/fonts` and declared with local `@font-face`. Nothing about them touches a network, which is not a preference here: the sandbox blocks every request that is not a local file, so a network font would simply not render.

The scale is six sizes and one emphasis weight. `font-semibold` is gone: hierarchy is luminance, not weight.

## Answer — verified, not admired

`src/shared/theme.test.ts` reads the stylesheet the app is actually built from, resolves the roles the way the browser does, converts OKLCH to sRGB and computes WCAG contrast for every pair in every theme — 4.5:1 for text, 3:1 for what is looked at rather than read. It caught real failures while the palette was being set, which is exactly what "verified rather than assumed" was asking for.

Borders are held to a lower bar than WCAG's, and deliberately: a line between two fills is not a control boundary, and the direction here asks borders to read as structure rather than decoration. That bar is named `EDGE`, is 1.2:1, and says in the file that it is not a WCAG requirement.

## Answer — nothing is hard-coded, and it is shown rather than claimed

Two enforcements, because the checkbox is about both what is written and what runs:

- ESLint fails on a raw colour or a bracketed size in any Renderer component. The provider marks are exempt: those colours are the providers' own, and no theme should recolour Anthropic's orange.
- `tests/design.spec.ts` re-skins the *running* app by injecting a third theme whose every role is a colour the app has never seen, then reads back what the page painted. Anything a component had hard-coded would survive that; nothing did.

What a theme cannot restate is the type, radius and motion scale. Those live in `@theme` because they belong to the app rather than to any one theme, and a third theme is a colour theme.

## Answer — focus, and the one thing allowed to suppress it

`:focus-visible` draws the ring for everything, in the base layer. The only thing allowed to override it is a control whose surrounding field shows focus for it (`focus-within:ring`) — the composer and the search field. The shell test tabs into the app in both themes and accepts either form, so removing focus fails whichever way it is removed.

## Answer — the window paints the page colour

A window exists before the Renderer has painted anything, so `@shared/theme` holds the page colour as hex for Main, and the unit test fails if it ever stops matching `--background`. The Renderer names the theme before its first paint from the OS colour scheme, which Main has already set from the stored preference.

## Answer — the rail says what a Session is doing

The placeholder ticket 03 left behind was one generic message icon for every Session, which is the one thing a status rail must not do. All four states now have their own mark and their own colour, and the accessible name says which.

## Answer — running needed a colour nobody had spent

Green, red and amber are reserved by the product, and the brand blue is meant to be the least interesting colour on screen. That left `running` with nothing, so there is one more family — a cyan — which is not the brand and is not one of the three the product has spent.
