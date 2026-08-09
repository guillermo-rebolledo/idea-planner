# 002 — Explain the Files panel arrival

- **Status**: DONE
- **Commit**: a3fed29
- **Severity**: LOW
- **Category**: Missed opportunities
- **Estimated scope**: 2 files, about 35 lines

## Problem

Opening Files conditionally inserts a wide flex sibling beside the conversation. Its content and
right-edge surface appear fully formed in one frame, so the viewport change has no spatial cue.

```tsx
// app/src/renderer/src/components/Mailbox.tsx:693 — current
{
  selectedSession && filesOpen && (
    <FilesPanel
      changes={changes}
      focusedPath={focusedFile}
      onFocus={setFocusedFile}
      onClose={() => setFilesOpen(false)}
      onAttach={attachReviewedCode}
    />
  )
}
```

```tsx
// app/src/renderer/src/components/FilesPanel.tsx:78 — current
<aside
  aria-label="Files this Session changed"
  style={{ width: `min(${String(width)}px, 42vw)`, minWidth: MIN_WIDTH }}
  className="relative flex shrink-0 flex-col border-l border-border bg-muted/40"
>
```

## Target

Keep the existing final layout and resizing behavior, but reveal the newly mounted right-hand panel
from its own right edge over 220ms. Only `transform` and `opacity` animate; width, minimum width, and
the conversation layout must not be transitioned.

```css
/* target; --ease-drawer belongs beside the other motion tokens */
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);

.files-panel-enter {
  transform-origin: right center;
  animation: files-panel-enter 220ms var(--ease-drawer) both;
}

@keyframes files-panel-enter {
  from {
    opacity: 0;
    transform: translateX(100%);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
```

Closing stays immediate. A close button is a frequent, explicit system response; delaying it would
make the interface feel less responsive. The entrance is the spatial explanation.

## Repo conventions to follow

- Motion tokens and keyframes live in `app/src/renderer/src/styles.css`.
- Plan 001 adds the first named curve beside `--default-transition-*`. Add
  `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)` in the same block. If Plan 001 has not run, create
  the motion-token block there rather than placing the literal in the component.
- `app/src/renderer/src/components/ui/preview-rail.tsx:232` is the compositor-only translated-surface
  exemplar; unlike that persistent card, this panel uses a one-time entrance because it mounts only
  when requested.

## Steps

1. Add the exact `--ease-drawer` token to `app/src/renderer/src/styles.css` beside the global motion
   values.
2. Add `.files-panel-enter` and its exact keyframes to that stylesheet.
3. Add `files-panel-enter` to the `aside` in
   `app/src/renderer/src/components/FilesPanel.tsx:78`. Preserve the inline width and all resize
   handlers unchanged.
4. Extend `app/tests/design.spec.ts` with a stylesheet-level assertion that this animation uses
   `translateX(100%)`, 220ms, and `--ease-drawer`, and does not transition `width`.

## Boundaries

- Do NOT animate `width`, `min-width`, grid tracks, margin, or padding.
- Do NOT convert the panel into an overlay or change the final workspace layout.
- Do NOT alter drag or keyboard resizing.
- Do NOT delay closing or add React presence state.
- Do NOT add dependencies.
- If a step does not match commit `a3fed29`, STOP and report instead of improvising.

## Verification

- **Mechanical**: run `pnpm --filter argos-desktop typecheck`, then
  `pnpm --filter argos-desktop exec playwright test tests/design.spec.ts`.
- **Feel check**: open a Session with changes and click its Files affordance. At 10% playback, the
  panel must travel from exactly its own width to rest at the right edge; no intermediate frame may
  stretch diff text. Close it and confirm the response is immediate. Reopen, drag the resize handle,
  and confirm no entrance timing leaks into resizing. With reduced motion enabled, confirm it appears
  without spatial travel.
- **Done when**: opening Files has a clear right-edge origin while resizing, final dimensions, and
  closing behavior are unchanged.
