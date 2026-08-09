# Theme picker prototype

Throwaway UI prototype answering:

> How should Argos let someone choose a preset theme and create a simple theme from a background
> and accent color?

Run it from the repository root:

```bash
pnpm prototype:theme
```

Three variants share the same in-memory state and are switchable with `?variant=A|B|C`, the floating
bar, or the left/right arrow keys:

| Key | Name                | Primary idea                                                      |
| --- | ------------------- | ----------------------------------------------------------------- |
| A   | Library + inspector | Presets and editing stay visible together in a broad modal        |
| B   | Guided compact flow | A familiar small Settings modal reveals one decision at a time    |
| C   | Live canvas drawer  | The workspace is the preview; controls live in a right-side sheet |

No state is persisted and none of this is production architecture. The prototype imports the app's
real stylesheet and semantic tokens, then derives a complete preview palette from the two user-facing
colors. The floating bar spells out the shared state so changes remain visible while comparing
variants.

## Current direction

Variant A won the first comparison. It is now a larger, unified Settings window with a persistent
sidebar for **General**, **Harnesses**, and **Appearance**. General carries the existing quit warning;
Harnesses folds in the current readiness, executable selection, individual checks, and login-shell
discovery concepts; Appearance retains A's library-and-inspector layout. Custom themes remember
separate Light and Dark color pairs, initially using white and black backgrounds respectively. A
**Use for both** toggle temporarily shares one color pair and hides the mode selector without
discarding either mode's saved choices. Derived surfaces follow the actual background luminance, so
unusual combinations such as black in the Light slot remain readable. Editing the custom draft does
not activate it; choosing the Custom card or **Save & apply** does.

The custom editor is contextual rather than permanently occupying the right side: selecting Custom
reveals it with a short right-to-left slide and fade, while choosing a preset dismisses it and gives
the theme library the full content width.
