## Agent skills

### Issue tracker

Issues and specs are tracked as local Markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the default five-role vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses the single-context layout. See `docs/agents/domain.md`.

### Codex protocol bindings

`app/src/core/harness/codex-protocol/` and the Codex contract fixture are
generated from the installed binary. See `docs/agents/codex-protocol.md`.

## Code style and checks

Prettier owns formatting and ESLint enforces the architecture boundaries. Run `pnpm verify` before finishing. See `docs/agents/code-style.md`.
