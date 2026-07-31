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
