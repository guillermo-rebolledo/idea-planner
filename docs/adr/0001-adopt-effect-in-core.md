# ADR 0001: Adopt Effect inside the Core process

Status: accepted
Date: 2026-07-31

## Context

The Core utility process will soon own the hardest parts of the product: harness
adapters that spawn Codex/Claude CLI processes per Run, normalize their
stream-JSON output into a versioned event stream, and supervise Run lifecycle —
stop, failure, timeout, cleanup of every acquired process, stream, and file
handle. Hand-rolled promises put all of that burden on cancellation edge cases.

The existing Core already hand-rolls three things a structured-effect system
provides: typed errors (`CoreError` codes), dependency injection (`CoreDeps`),
and write serialization (a manual promise queue).

[Effect](https://effect.website) (3.x, stable) provides structured concurrency
with guaranteed interruption, typed error channels, `Stream` for event
pipelines, `Scope` for resource cleanup, and `Layer`/`Context` for dependency
injection — exactly the shape of the upcoming Run supervision work.

## Decision

Use Effect for all product behavior inside the **Core utility process**. Future
Core subsystems (harness adapters, Run supervision, managed-file writes,
event streams) are written Effect-native from the start.

Effect stays **contained behind the process boundary**:

- The Core process is Effect end-to-end: `core.ts` exposes an Effect-native
  surface (`CoreEffects`) consumed by the utility-process entry
  (`app/src/core/index.ts`), which runs each request in its own fiber keyed by
  request id — the seam where a future cancellation envelope becomes
  `Fiber.interrupt`.
- The promise boundary sits at the edges: the `Core` interface stays
  promise-based for tests and any out-of-process caller (`runPromiseExit`,
  failures re-thrown as the contract's `CoreError`), and the dispatcher speaks
  plain validated messages to Main.
- The shared IPC contract (`app/src/shared/contract.ts`) stays **zod**. Effect
  Schema is not adopted; one validation vocabulary at the boundary.
- Main, Preload, and the React Renderer do **not** use Effect.
- Only the core `effect` package is a dependency. `@effect/platform` and other
  ecosystem packages are deferred until a concrete need arises, as they are
  less stable than core.

This containment is enforced, not just documented: `eslint.config.mjs` forbids
importing `effect` from `src/main` and `src/preload`, and points violations back
at this ADR.

Conventions inside Core:

- Failures travel in the typed error channel as `CoreError` (the contract
  error). Internal tagged errors are fine while a subsystem grows, but they
  must be mapped to `CoreError` before crossing the Core interface.
- Injectable dependencies (clock, id generation, later: filesystem, SQLite,
  process spawning) are `Context.Tag` services provided via `Layer`, so tests
  swap them without monkey-patching.
- Mutable state lives in `Ref`; mutual exclusion uses `Effect.Semaphore`
  instead of hand-rolled promise queues.

## Consequences

- Run supervision, interruption, and stream normalization get compiler-checked
  error handling and guaranteed resource cleanup instead of bespoke promise
  plumbing.
- Contributors and agents implementing Core issues must read and write Effect
  (generators, `Effect.gen`, `pipe`). Renderer/Main work is unaffected.
- Effect 3.x is the pinned major; a v4 migration is expected eventually and is
  accepted as a known cost.
- Reference migration: the capture slice in `app/src/core/core.ts` demonstrates
  the idioms (services, `Ref`, semaphore, `tryPromise`, boundary unwrapping).

## Open decision: Effect in Main's process supervision

The Electron architecture decision places the future `RunProcessBroker`
(spawning and supervising provider CLI process trees) in **Main**, alongside
`CoreClient` — the most supervision-shaped code in the app, in the process
this ADR declares Effect-free. When the RunProcessBroker issue is implemented,
explicitly decide whether to extend Effect to Main's supervision modules
(`CoreClient`, the broker — never the Electron lifecycle/security wiring) or
keep Main promise-based. Do not silently pick a side; surface the choice in
that issue.
