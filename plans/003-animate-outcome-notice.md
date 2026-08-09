# 003 — Animate the outcome notice lifecycle

- **Status**: DONE
- **Commit**: a3fed29
- **Severity**: LOW
- **Category**: Missed opportunities
- **Estimated scope**: 3 files, about 75 lines

## Problem

The transient outcome/Undo pill is mounted at its final state and removed by a six-second timer. It
pops into the composer's visual field and vanishes without indicating that it is temporary.

```tsx
// app/src/renderer/src/components/Mailbox.tsx:122 — current
useEffect(() => {
  if (notice === null) return
  const timer = window.setTimeout(() => setNotice(null), 6_000)
  return () => window.clearTimeout(timer)
}, [notice])
```

```tsx
// app/src/renderer/src/components/Mailbox.tsx:712 — current
{notice && (
  <div
    className={cn(
      'pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-surface-raised py-1.5 text-xs shadow-md',
      notice.undoable ? 'pr-1.5 pl-3.5' : 'px-3.5'
    )}
  >
```

## Target

Retain the notice for a 160ms exit phase after 5,840ms, keeping the complete lifecycle at six
seconds. A new notice enters over 180ms from `translateY(100%)` and `opacity: 0`; timeout dismissal
exits over 160ms to the same state. Explicit Undo remains immediate because it is the system's
response to an action.

```css
/* target */
.outcome-notice {
  animation: outcome-notice-enter 180ms var(--ease-out) both;
}

.outcome-notice[data-exiting='true'] {
  animation: outcome-notice-exit 160ms var(--ease-out) both;
  pointer-events: none;
}

@keyframes outcome-notice-enter {
  from {
    opacity: 0;
    transform: translateY(100%);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes outcome-notice-exit {
  from {
    opacity: 1;
    transform: none;
  }
  to {
    opacity: 0;
    transform: translateY(100%);
  }
}
```

The notice state gains an `exiting` boolean. Its timeout marks the matching notice as exiting after
5,840ms. The exiting animation's `animationend` handler removes only that same notice, guarding
against a newer announcement replacing it during the exit.

## Repo conventions to follow

- Use the exact `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` token from Plan 001. If it is not yet
  present, add it beside `--default-transition-*`; never hand-type the curve in the component.
- Keep timer ownership in `Mailbox`, where the current lifecycle already lives.
- Use the notice's existing `at` timestamp as its React `key` and stale-callback identity guard.

## Steps

1. In `app/src/renderer/src/components/Mailbox.tsx`, define a named notice type containing `text`,
   `undoable`, `at`, and `exiting`; initialize announcements with `exiting: false`.
2. Change the existing timeout to 5,840ms. When it fires, functional-update only the notice whose
   `at` matches the effect's notice and set `exiting: true` instead of removing it.
3. Key the pill by `notice.at`, apply `outcome-notice`, expose `data-exiting`, and add an
   `onAnimationEnd` handler. The handler removes the notice only when the exit animation finishes
   and the current notice still has the same `at`.
4. Keep the Undo handler's direct `setNotice(null)` behavior unchanged.
5. Add the exact classes and keyframes above to `app/src/renderer/src/styles.css`.
6. Add focused fake-timer coverage in `app/src/renderer/src/components/Mailbox.test.tsx` if a practical
   renderer component-test seam already exists. Otherwise, add stylesheet-contract coverage to
   `app/tests/design.spec.ts` and exercise the complete lifecycle in the existing shell test that
   archives or mutates a Session. Do not introduce a new test framework.

## Boundaries

- Do NOT change the live-region wrapper, role, wording, six-second total lifetime, or Undo behavior.
- Do NOT let a stale animation callback remove a newer notice.
- Do NOT animate top, bottom, margin, padding, or height.
- Do NOT add dependencies.
- If a step does not match commit `a3fed29`, STOP and report instead of improvising.

## Verification

- **Mechanical**: run `pnpm --filter argos-desktop typecheck`, the focused test chosen in Step 6, and
  finally `pnpm verify` after all plans are implemented.
- **Feel check**: trigger an archive outcome. At 10% playback, it must rise by exactly its own height,
  rest without lingering transform, remain readable for roughly six seconds, and return downward.
  Trigger a second outcome while the first is present and confirm the second enters afresh and is not
  removed by the first timer or animation callback. Click Undo and confirm removal is immediate.
  With reduced motion enabled, confirm the notice remains readable and its lifecycle still completes.
- **Done when**: automatic entry and exit are visible, the lifetime remains six seconds, Undo snaps,
  and stale timers cannot dismiss a newer announcement.
