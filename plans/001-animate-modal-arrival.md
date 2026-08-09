# 001 — Animate the shared modal arrival

- **Status**: DONE
- **Commit**: a3fed29
- **Severity**: LOW
- **Category**: Missed opportunities
- **Estimated scope**: 2 files, about 45 lines

## Problem

Every confirmation and settings surface uses the shared modal shell, but the scrim and panel are
inserted at their final visual state. The new modal layer therefore appears in a single frame and
provides no arrival cue.

```tsx
// app/src/renderer/src/components/ui/dialog.tsx:92 — current
return (
  <div
    className="absolute inset-0 z-50 flex items-center justify-center bg-background/60 p-6"
    role="presentation"
  >
    <div
      ref={panelRef}
      role={destructive ? 'alertdialog' : 'dialog'}
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      className={cn(
        'dialog-viewport w-full max-w-sm overflow-y-auto rounded-xl border border-border bg-surface-raised p-4 shadow-lg outline-none',
        className
      )}
    >
```

## Target

Give the shared scrim and centered panel one source-owned entrance. The scrim fades in while the
panel resolves from `opacity: 0`, `translateY(4px)`, and `scale(0.97)`. Both use a 200ms strong
ease-out. The centered modal keeps `transform-origin: center`; it must not inherit a trigger-origin
rule intended for popovers.

```css
/* target */
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);

.modal-backdrop {
  animation: modal-backdrop-enter 200ms var(--ease-out) both;
}

.modal-panel {
  transform-origin: center;
  animation: modal-panel-enter 200ms var(--ease-out) both;
}

@keyframes modal-backdrop-enter {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes modal-panel-enter {
  from {
    opacity: 0;
    transform: translateY(4px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
```

Dismissal remains immediate. This is deliberate asymmetric timing: the arrival explains a new
modal layer, while the system's response to Escape, Cancel, or a completed action snaps. Do not add
presence state or delayed callbacks.

## Repo conventions to follow

- Global visual tokens and source-owned keyframes live in
  `app/src/renderer/src/styles.css`; the existing `preview-rise` utility at line 317 is the exemplar.
- Add `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` beside the existing transition tokens at
  `styles.css:214` and reference the token from both animations.
- The global reduced-motion policy at `styles.css:267` already collapses animation duration. Do not
  add a competing accessibility policy in this plan.

## Steps

1. In `app/src/renderer/src/styles.css`, add the exact `--ease-out` token beside the existing default
   transition values.
2. In the same stylesheet, add `.modal-backdrop`, `.modal-panel`, and the two exact keyframes shown
   above near `.dialog-viewport`.
3. In `app/src/renderer/src/components/ui/dialog.tsx`, add `modal-backdrop` to the outer presentation
   layer and `modal-panel` to the inner dialog panel.
4. Extend `app/tests/design.spec.ts` with a stylesheet-level assertion that the shared modal classes
   reference the two keyframes and that the panel's starting scale is `0.97`, never `0`.

## Boundaries

- Do NOT change the modal DOM structure, focus trap, roles, focus restoration, or dismissal logic.
- Do NOT edit individual modal call sites.
- Do NOT animate layout properties or add dependencies.
- Do NOT add an exit delay.
- If a step does not match commit `a3fed29`, STOP and report instead of improvising.

## Verification

- **Mechanical**: run `pnpm --filter argos-desktop typecheck`, then the focused design test with
  `pnpm --filter argos-desktop exec playwright test tests/design.spec.ts`. Both must pass.
- **Feel check**: open Settings and a destructive confirmation. At normal speed, focus must already
  be usable while the layer settles. In DevTools at 10% playback, confirm the scrim only fades and
  the panel moves 4px while scaling from 0.97 around its center. Toggle reduced motion and confirm
  the spatial entrance is effectively absent.
- **Done when**: every shared `Modal` receives the same restrained entrance, centered geometry never
  shifts, and all dismissal paths remain immediate.
