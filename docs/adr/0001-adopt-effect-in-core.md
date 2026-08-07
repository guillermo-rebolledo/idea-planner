# ADR 0001: Adopt Effect for non-UI product behavior

Status: accepted
Date: 2026-07-31
Amended: 2026-08-05

## Context

The Core utility process owns durable Session, Run, Conversation, and Queued
Submission facts, including product lifecycle decisions and Harness protocol
normalization. Main owns native Codex and Claude processes, Checkout
observation, adapter selection, and supervision. Transport and presentation
remain narrow Promise/zod or React seams.

The existing Core already hand-rolls three things a structured-effect system
provides: typed errors (`CoreError` codes), dependency injection (`CoreDeps`),
and write serialization (a manual promise queue).

[Effect](https://effect.website) (3.x, stable) provides structured concurrency
with guaranteed interruption, typed error channels, `Stream` for event
pipelines, `Scope` for resource cleanup, and `Layer`/`Context` for dependency
injection. Those primitives match the implemented durable lifecycle and native
Run supervision architecture.

## Decision

Use Effect as the target architecture for non-UI product behavior in the
**Core utility process** and **Main**. Durable Run state, Conversation journals,
Run lifecycle, Harness adapters, queue coordination, and native supervision are
Effect-native. Each migration landed atomically; no compatibility facade,
feature flag, or alternate production implementation remains.

Effect stays behind the application's transport and presentation seams:

- Core is Effect end-to-end: `core.ts` exposes an Effect-native surface
  consumed by the utility-process entry (`app/src/core/index.ts`), which runs
  each request in its own fiber keyed by request id.
- Main product behavior uses one Electron-lifetime runtime. Native process
  operations are injected Effect services, and each Run is a child Scope of
  that runtime. Promise conversion happens only at Electron callbacks and
  transport boundaries.
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
  to a defect at that boundary; the Electron-facing promise adapter still
  observes it and preserves supervision-failure behavior.
- Injectable dependencies (clock, id generation, later: filesystem, SQLite,
  process spawning) are `Context.Tag` services provided via `Layer`, so tests
  swap them without monkey-patching.
- Mutable state owned by an Effect-native slice lives in `Ref`; mutual
  exclusion uses `Effect.Semaphore` instead of hand-rolled promise queues.
  Resource lifetime belongs to Scope.

## Consequences

- Durable Run state, interruption, event normalization, Harness orchestration,
  and native process-group cleanup get compiler-checked error handling and
  guaranteed resource cleanup instead of bespoke promise plumbing.
- Contributors and agents implementing Core or Main product behavior must read
  and write Effect (`Effect.gen`, `pipe`, services, layers, scopes, and fibers).
  Renderer work is unaffected.
- Effect 3.x is the pinned major; a v4 migration is expected eventually and is
  accepted as a known cost.
- Reference modules are `app/src/core/core.ts`,
  `app/src/core/queued-submission-lifecycle.ts`,
  `app/src/main/harness-adapter.ts`, and
  `app/src/main/queue-coordinator.ts`.

## Final ownership and recovery invariants

- Main observes native process exit, Harness results, supervision failures, and
  Checkout comparison. It sends one terminal observation and publishes only
  after Core confirms durability.
- Core alone decides terminal Run state, Conversation ending, Checkout evidence,
  queue disposition, replay, and repair. Opening and completion are stable,
  idempotent lifecycle requests; the Conversation fact is canonical and derived
  Run or queue state is repairable.
- Main Harness Adapters own credentials, staged homes, launch arguments and
  environment, native permissions, Harness Thread continuity, Approval Request
  transport, interruption, and Harness-specific completion. Core protocol
  Adapters normalize raw Harness frames into product events.
- The queued lifecycle owns editability, ordering, claim, retry, recovery, and
  disposition. Main performs only the resulting native launch behind one
  per-Session gate.
- The selected Conversation read model owns durable reads, streamed state,
  freshness and paint cadence, write-result adoption, and identity
  reconciliation. No second Renderer refresh path exists.
