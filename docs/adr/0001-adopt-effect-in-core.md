# ADR 0001: Adopt Effect for non-UI product behavior

Status: accepted
Date: 2026-07-31
Amended: 2026-08-05

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

Use Effect as the target architecture for non-UI product behavior in the
**Core utility process** and **Main**. Core is Effect-native today; Main is
migrated in complete behavior slices so commands, events, and persisted state
remain compatible throughout the program. Durable Run state, Conversation
journals, Run lifecycle, Harness adapters, queue coordination, and native
supervision move into Effect as their slices land.

Effect stays behind the application's transport and presentation seams:

- Core is Effect end-to-end: `core.ts` exposes an Effect-native surface
  consumed by the utility-process entry (`app/src/core/index.ts`), which runs
  each request in its own fiber keyed by request id.
- Main's first slice is `RunProcessBroker` resource lifetime: native process
  operations are represented as an injected Effect layer, and each Run is a
  child Scope of one Electron-lifetime runtime. Its existing promise facade to
  `RunService` remains temporarily behavior-compatible while later slices move
  that caller into Effect.
- The Core process seam and Electron IPC seam stay promise-based. Dispatchers
  use `runPromiseExit` at those edges and speak plain validated messages.
- The shared IPC contract (`app/src/shared/contract.ts`) stays **zod**. Effect
  Schema is not adopted; one validation vocabulary at transport seams.
- Preload remains a promise adapter, and the React Renderer uses React-native
  state. Neither exposes Effect in its interface.
- Only the core `effect` package is required. `@effect/platform` and other
  ecosystem packages remain deferred until a concrete need arises.

This containment is enforced, not just documented: architecture rules permit
`effect` in Core and Main product behavior and forbid it from Preload, shared
contracts, and the Renderer.

Conventions inside Core and Effect-native Main modules:

- Failures travel in the typed error channel as `CoreError` (the contract
  error). Internal tagged errors are fine while a subsystem grows, but they
  must be mapped to `CoreError` before crossing the Core interface.
- Main uses tagged domain errors inside operational Effects. Scope finalizers
  cannot expose a typed error channel, so a finalizer converts a cleanup error
  to a defect at that boundary; the enclosing promise facade still observes it
  and preserves the existing supervision-failure behavior.
- Injectable dependencies (clock, id generation, later: filesystem, SQLite,
  process spawning) are `Context.Tag` services provided via `Layer`, so tests
  swap them without monkey-patching.
- Mutable state owned by an Effect-native slice lives in `Ref`; mutual
  exclusion uses `Effect.Semaphore` instead of hand-rolled promise queues.
  A compatibility facade may retain existing observable state until the slice
  that owns it migrates, but new resource lifetime belongs to Scope.

## Consequences

- Durable Run state, interruption, event normalization, Harness orchestration,
  and native process-group cleanup get compiler-checked error handling and
  guaranteed resource cleanup instead of bespoke promise plumbing.
- Contributors and agents implementing Core or Main product behavior must read
  and write Effect (`Effect.gen`, `pipe`, services, layers, scopes, and fibers).
  Renderer work is unaffected.
- Effect 3.x is the pinned major; a v4 migration is expected eventually and is
  accepted as a known cost.
- Reference migration: the capture slice in `app/src/core/core.ts` demonstrates
  the idioms (services, `Ref`, semaphore, `tryPromise`, boundary unwrapping).

## Superseded follow-up: Main process supervision stays promise-based

> **Superseded by the 2026-08-05 amendment.** Main retains native process
> authority, but its product behavior and supervision are now Effect-native.
> During the phased migration, a complete migrated slice may keep a temporary
> promise facade to its unmigrated caller. The final architecture converts only
> at Electron callbacks and transport seams.

> **Partially superseded by [ADR 0003](./0003-harness-native-permissions.md).**
> The model-visible tool surface described below was removed: `PlanningPolicy`
> is gone, and the Harness's native tools and permission system replace the
> app-owned planning sandbox.

The original decision kept `RunService`, `PlanningToolHost`, and
`RunProcessBroker` promise- and event-driven in **Main**. The 2026-08-05
amendment replaces that implementation direction while preserving their native
authority boundary: resolve the already-probed executable, freeze the launch
configuration through Core, then launch, terminate, reap, verify, and remove
the private Run directory.

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

### Amendment: starting a Session is one act, sequenced in Main

Sending on the launch screen creates a Session and answers the message that
created it, in one Run. That sequence — `session/start` through Core, then the
existing develop path — lives on `RunService` as `startSession`, which expands
Main's orchestration past the fixed request/persist/launch/report sequence the
follow-up decision drew a line at.

It stays in Main rather than moving into Core because the second half of it is
already there: developing a Session is Main's, since it launches and supervises
the Harness process. Splitting the act so Core sequenced the half it can see
would put the launch screen's one gesture behind two owners.

Canonical state is unaffected: both halves are still validated and persisted by
Core before anything is presented, and Main invents no state of its own. Revisit
if Main starts sequencing acts whose steps are all Core's.
