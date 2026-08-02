# ADR 0001: Adopt Effect inside the Core process

Status: accepted
Date: 2026-07-31

## Context

The Core utility process owns durable Run acceptance, normalized event state,
product-managed Idea-document writes, and product lifecycle decisions. Main
alone can own native Codex/Claude process groups, the macOS sandbox, and the
short-lived planning capability described below. Planning artifacts under an
Idea's `.scratch/` tree are deliberately outside Core's managed-document and
version-history contract. Hand-rolled promises inside Core would put durable
cancellation and write-ordering guarantees on bespoke queues, while importing
Effect into Electron authority wiring would enlarge the trusted surface without
improving the narrow OS process contract.

The existing Core already hand-rolls three things a structured-effect system
provides: typed errors (`CoreError` codes), dependency injection (`CoreDeps`),
and write serialization (a manual promise queue).

[Effect](https://effect.website) (3.x, stable) provides structured concurrency
with guaranteed interruption, typed error channels, `Stream` for event
pipelines, `Scope` for resource cleanup, and `Layer`/`Context` for dependency
injection — exactly the shape of the upcoming Run supervision work.

## Decision

Use Effect for all product behavior inside the **Core utility process**. Future
Core subsystems (durable Run state, managed Idea-document writes, and event
journals) are written Effect-native from the start. Native process launch,
reaping, and capability-mediated `.scratch/` planning operations remain in Main
as described by the follow-up decision below.

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

- Durable Run state, interruption, and event normalization get compiler-checked
  error handling and guaranteed resource cleanup instead of bespoke promise
  plumbing; native process-group cleanup stays behind a small tested Main
  boundary.
- Contributors and agents implementing Core issues must read and write Effect
  (generators, `Effect.gen`, `pipe`). Renderer/Main work is unaffected.
- Effect 3.x is the pinned major; a v4 migration is expected eventually and is
  accepted as a known cost.
- Reference migration: the capture slice in `app/src/core/core.ts` demonstrates
  the idioms (services, `Ref`, semaphore, `tryPromise`, boundary unwrapping).

## Follow-up decision: Main process supervision stays promise-based

> **Partially superseded by [ADR 0003](./0003-harness-native-permissions.md).**
> The promise-based Main supervision boundary stands. The model-visible tool
> surface described below does not: `PlanningPolicy` is removed and the
> Harness's native tools and permission system replace the app-owned planning
> sandbox.

`RunService`, `PlanningToolHost`, and `RunProcessBroker` remain promise- and
event-driven in **Main**. They form one native authority boundary: resolve the
already-probed executable, freeze the launch configuration through Core, then
launch, terminate, reap, verify, and remove the private Run directory.

The provider runs with its own native tools and its own permission system; the
app does not contain it. Main adds exactly one tool no Harness offers natively —
structured response options, which back Suggested Responses — through a per-Run
capability socket and a tiny stdio proxy. `PlanningToolHost` serializes those
calls, bounds them per Run, and reports them as activity. A Run's private
directory still holds the staged provider home, so the provider can read its own
bootstrap authentication without that path becoming a model-visible operation.

Main may report observed native lifecycle and policy events, but it does not
own canonical state transitions: each one is validated and persisted by Core
before presentation. Dependencies are injected and the boundary contract is
tested directly. Revisit if orchestration expands beyond this fixed
request/persist/launch/report sequence.
