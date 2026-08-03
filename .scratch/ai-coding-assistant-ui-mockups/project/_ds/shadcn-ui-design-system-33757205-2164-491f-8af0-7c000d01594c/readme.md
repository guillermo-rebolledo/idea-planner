# shadcn/ui — Design System

A faithful recreation of the **shadcn/ui** design language, rebuilt from the attached Figma
community file *"@shadcn_ui - Design System (Community)"*. shadcn/ui is an open-source set of
copy-paste React components styled with Tailwind and Radix primitives — famous for its restrained,
neutral **Slate** palette, Inter typography, small radii, and hairline borders.

This project packages that language as tokens, reusable React components, foundation specimen
cards, an icon set, and a dashboard UI kit, so any consuming project can build shadcn-styled
interfaces instantly.

## Sources
- **Figma (mounted .fig):** "@shadcn_ui - Design System (Community).fig" — pages: Cover, Components,
  Typography, Colors, Primitives, Icons (877 icon symbols).
- The file defines **no Figma Variables and no text styles** — all values are raw. Tokens here were
  transcribed verbatim from the Colors palette, the Typography specimen page, and each primitive's
  exact geometry (not snapped to a grid or to public shadcn defaults).
- Public reference (for confirmation only): https://ui.shadcn.com

## Fonts
- **Inter** (sans, the file's only text font) and **Menlo** (mono, 1 usage).
- Inter is loaded from **Google Fonts** (`tokens/fonts.css`) rather than bundled TTFs — a CDN
  substitution of the identical family. Menlo is a macOS system mono with a graceful fallback stack.
  **Ask:** drop in Inter/Menlo `.ttf` files if you need a fully self-contained, offline bundle.

---

## CONTENT FUNDAMENTALS
How shadcn writes copy (drawn from the file's sample content and the public docs):

- **Voice:** plain, technical, unfussy. Short declarative sentences. No marketing gloss, no exclamation
  marks, no emoji. Example microcopy: *"Make changes to your account here."*, *"Enter your email address."*
- **Person:** addresses the user as **you** ("Deploy your new project in one click"). Descriptions of
  components use neutral third person ("A modal dialog that interrupts the user…").
- **Casing:** **Sentence case** everywhere — buttons ("Add customer", "Save changes"), titles, menu
  items. Reserve Title Case only for proper nouns.
- **Buttons:** verb-first and terse — *Continue, Cancel, Save changes, Deploy, Log out, Delete*.
- **Labels & helper text:** label is a noun ("Email"), helper text is a short instruction in muted grey
  ("Enter your email address."). Errors are direct.
- **Placeholders:** realistic examples (`name@example.com`, "Type your message here").
- **Tone vibe:** developer-calm. It reads like good API docs — confident, minimal, never cute.

---

## VISUAL FOUNDATIONS

- **Palette:** neutral **Slate** scale (50→950) is the entire base; there are effectively no brand hues.
  The one saturated accent is **destructive red** (`#ef4444`). Semantic roles (`--primary`, `--secondary`,
  `--muted`, `--accent`, `--border`, `--input`, `--ring`) all resolve to slate steps. Primary = slate-900.
- **Themes:** ships **light** (default) and **dark** (`.dark` scope, slate-900 surfaces). Two background
  colors max: white / slate-900.
- **Type:** Inter throughout. Display sizes use tight negative tracking (h1 48px/800/-0.012em). Body 16px
  with generous 28px line-height. UI text is 14px medium. See `tokens/typography.css` and the Type cards.
- **Spacing:** 4px base grid. Control padding is 8×16 (buttons), 8×12 (inputs).
- **Radius:** small and consistent — checkbox 2px, controls (button/input/tabs) 4–6px, cards/popovers 8px,
  pills full. Never large pill-y cards.
- **Borders:** hairline **1px** in slate-200 (`--border`); input fields use slate-300 (`--input`). Borders
  do the heavy lifting — this system is border-first, not shadow-heavy.
- **Shadows:** subtle and low-opacity (rgba black ~0.09). `--shadow-sm` on cards, a soft `--shadow-popover`
  (`0 4px 12px rgba(15,23,42,.15)`) on floating surfaces. No colored or glow shadows.
- **Focus:** a 2px ring (`--ring`, slate-400) with a 2px offset — a defining shadcn detail.
- **Backgrounds:** flat solid fills only. **No gradients, no textures, no illustrations, no full-bleed
  imagery.** Surfaces are white or slate-900.
- **Hover states:** buttons darken ~10% (primary/destructive) or fill with `--accent` (ghost/outline);
  menu/list items get an `--accent` background; links underline. **Press:** color deepens (no scale bounce).
- **Motion:** minimal and fast — 120–200ms, standard ease `cubic-bezier(.4,0,.2,1)`. Dialogs fade + scale
  from .96; popovers fade + slide 4px. No springy/bouncy motion.
- **Transparency & blur:** dialog scrim is `rgba(15,23,42,.5)`. No glassmorphism/backdrop-blur.
- **Cards:** white surface, 1px slate-200 border, 8px radius, `--shadow-sm`. Header (title 24/600 +
  muted description), content, footer with right-aligned actions.
- **Imagery:** effectively none in the system; avatars use real photos or initials on a muted circle.

---

## ICONOGRAPHY
- shadcn/ui uses **Lucide** icons (outline, 24×24 viewBox, ~2px stroke, `currentColor`). The Figma file
  embeds the full ~877-glyph Lucide set as components.
- **Bundled offline:** `assets/icons/icon-data.js` carries **393 icons** extracted verbatim from the file,
  rendered via `<Icon name="IconName" size={20} />` (see `assets/icons/Icon.d.ts` for valid names).
  Icons paint with `currentColor` — set `color` to recolor.
- **Full set:** the complete Lucide library (1000+) is CDN-available if you need a glyph not bundled —
  `https://unpkg.com/lucide-static` or the `lucide-react` package; names map 1:1 (kebab-case in Lucide,
  `IconPascalCase` here).
- **Caveat / substitution:** the offline set was capped by a tool limit that only enumerated icons A→F
  plus an explicit hand-picked batch of common G→Z glyphs. It is *not* the whole 877 — but every icon used
  by this project's cards and UI kit is included, and Lucide CDN covers the rest. **Ask:** tell me which
  extra glyphs you need bundled offline and I'll materialize them.
- No emoji, no unicode-as-icon, no icon font. Just Lucide SVGs.
- A few glyphs (IconBot, IconFlashlight) had non-decodable geometry in the file and render as a plain box.

---

## COMPONENTS
React primitives, grouped by concern under `components/`. All are styled with the CSS custom properties in
`styles.css`; import each from `window.DesignSystem_337572` (the compiled bundle) in HTML, or as
`<Name>.jsx` in a build.

**Forms** (`components/forms/`): **Button**, **IconButton**, **Input**, **Textarea**, **Label**,
**Checkbox**, **RadioGroup** (+ RadioGroupItem), **Switch**, **Select**, **Slider**.

**Display** (`components/display/`): **Card** (+ CardHeader/CardTitle/CardDescription/CardContent/CardFooter),
**Badge**, **Avatar**, **Separator**, **AspectRatio**, **Progress**, **Accordion** (+ AccordionItem),
**Table** (+ TableHeader/TableBody/TableFooter/TableRow/TableHead/TableCell).

**Overlay** (`components/overlay/`): **Dialog** (+ DialogHeader/Title/Description/Footer), **AlertDialog**,
**Popover**, **HoverCard**, **Tooltip**, **Menu** (+ MenuItem/MenuLabel/MenuSeparator), **DropdownMenu**,
**ContextMenu**, **Menubar** (+ MenubarMenu), **Command**.

**Navigation** (`components/navigation/`): **Tabs**, **NavigationMenu** (+ NavigationMenuLink),
**Collapsible**, **ScrollArea**.

**Iconography** (`assets/icons/`): **Icon** — renders any bundled Lucide glyph by name.

### Intentional additions
- **IconButton** — the file's 32×32 "just icon" button, exposed as a named convenience over `Button size="icon"`.
- **Menu** — shared surface extracted so DropdownMenu / ContextMenu / Menubar stay consistent.
- **Switch on-state** — the community file's checked track was light slate-200 (a likely mistake); this system
  uses `--primary` for a legible on-state.

---

## UI KITS
- **Dashboard** (`ui_kits/dashboard/index.html`) — the iconic shadcn analytics dashboard: top nav with
  search + avatar dropdown, stat cards, a bar-chart overview, recent-sales list, and a customers table with
  row action menus and an "Add customer" dialog. Interactive (route + dialog + menus). Composes the primitives.

---

## FILE INDEX
- `styles.css` — global entry point (import-only). Consumers link this.
- `tokens/` — `colors.css`, `typography.css`, `spacing.css`, `fonts.css`.
- `components/{forms,display,overlay,navigation}/` — React primitives + `.d.ts` + one `@dsCard` per group.
- `assets/icons/` — `icon-data.js`, `Icon.jsx`, `Icon.d.ts`, icons card.
- `assets/img/avatar-cn.jpg` — sample avatar photo (from the file).
- `guidelines/` — foundation specimen cards (Colors, Type, Spacing).
- `ui_kits/dashboard/` — dashboard screen.
- `thumbnail.html` — homepage tile.
- `SKILL.md` — Agent-Skills entry point.

## CAVEATS
- No logo/brand mark in the source → the wordmark renders as **type** ("shadcn/ui") everywhere; none was invented.
- Inter/Menlo loaded via CDN, not bundled TTFs.
- Offline icon set is 393 of ~877 (A–F + common G–Z); rest via Lucide CDN.
