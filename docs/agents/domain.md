# Domain Docs

## Before exploring, read these

- `CONTEXT.md` at the repo root, or relevant contexts from `CONTEXT-MAP.md`
- ADRs under `docs/adr/`

If these files do not exist, proceed silently. Domain-modeling skills create them lazily.

## Layout

This is a single-context repo:

/
├── CONTEXT.md
├── docs/adr/
└── src/

## Vocabulary

Use terms defined in `CONTEXT.md` and avoid its rejected synonyms. If a needed concept is absent, reconsider the language or note the gap for `/domain-modeling`.

## ADR conflicts

Explicitly surface output that contradicts an existing ADR rather than silently overriding it.

## Implemented ownership

- **Core** owns durable Session, Run, Conversation, and Queued Submission facts.
  A Run opens and completes through one lifecycle interface. Conversation facts
  are written first; derived Run and queue state is idempotently repairable.
- **Main** owns native process facts. `RunService` selects a Harness Adapter,
  supervises the process, compares the Checkout, and reports one terminal
  observation. It does not sequence Core persistence primitives.
- **Main Harness Adapters** own every Codex- or Claude-specific native fact:
  credentials, staged home, arguments and environment, native permissions,
  Harness Thread continuity, Approval Request transport, interruption, and
  completion. **Core protocol Adapters** normalize raw Harness frames into
  product events; protocol normalization remains in Core.
- **Queued Submission lifecycle** owns editability, ordering, claims, retries,
  recovery, and disposition in Core. Main owns only the serialized native launch.
- **Selected Conversation read model** is the sole Renderer owner of durable and
  streamed Conversation state, Run history, freshness cadence, write-result
  adoption, and live/durable identity reconciliation. Mailbox consumes only
  explicit lifecycle invalidation.

Effect is confined to Core and Main product behavior. Core process transport,
Electron IPC, Preload, shared contracts, and Renderer state are Promise/zod or
React seams; no Effect value crosses them.
