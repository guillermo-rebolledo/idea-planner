# Core workspace prototype

Throwaway UI prototype answering:

> Which information hierarchy keeps the Conversation unmistakably primary while Ideas, Run state, and Markdown remain easy to inspect?

Four variants are switchable with `?variant=A`, `?variant=B`, `?variant=C`, and `?variant=D`, or with the floating switcher. Variant D combines the Focus Deck with a full collapsible Mailbox.

Variant D also validates the complete review flow with `stage=developing`, `stage=spec`, `stage=tickets`, `stage=failure`, and `stage=ready`. Use the second floating control or open a state directly, for example:

```text
http://127.0.0.1:5173/?variant=D&stage=spec
```

## Verdict

Variant D, **Focus Mailbox**, is the validated production direction across all workflow states. Suggested Responses submit immediately as user turns, while custom answers use the composer. The whole app follows the system Light/Dark preference by default with explicit overrides. Production should use source-owned shadcn/ui components, Nexus UI conversational primitives, assistant-ui's standalone Diff Viewer, and Linear as an interaction-quality reference.

Run from the repository root:

```bash
pnpm prototype
```

This prototype is read-only, uses in-memory state, and is not production architecture.
