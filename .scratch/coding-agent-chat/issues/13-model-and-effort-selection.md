# 13 — Model and reasoning effort selection

**What to build:** One control in the composer replaces the separate Harness, model, and effort selects. The user picks a model — grouped under the Harness that reaches it — and a thinking level, and those choices are pinned into the Run.

Choosing a model chooses the Harness. Users think in models, not in which CLI wrapper reaches them. When only one Harness is usable (ticket 09), the picker simply shows fewer groups, rather than presenting a Harness selector with one disabled option.

That collapse hides something real, so the UI must not let it hide silently: the Harness carries behaviour the model does not. **Ask and Full access do not behave identically across Harnesses** (`docs/harness-permission-mapping.md`), and **Skills work better on Claude Code than on Codex** ([ADR 0003](../../../docs/adr/0003-harness-native-permissions.md)). Switching model across a group boundary changes both. Head each group with the Harness name and surface the difference at the point of switching.

Use `ModelSelector` from assistant-ui's shadcn registry (`https://www.assistant-ui.com/docs/ui/model-selector`).

**Use `ModelSelector.Root`, not the default export.** The default export registers the selection into assistant-ui's `ModelContext`, which its transport then sends as `config` in an HTTP request body to an API route. This app has no backend — it spawns local CLIs and passes flags. `ModelSelector.Root` is presentational, with controlled value and effort props, which is what the existing per-Run configuration needs. Effort maps to each Harness's reasoning-effort flag; models without configurable reasoning omit `efforts` and the Thinking row hides itself.

This is the first substantial UI dependency the repo takes on: `command` (cmdk) and `popover`, plus `@base-ui/react`. Follow the existing source-owned component convention rather than adding a component library as a runtime dependency.

**Open decision for whoever picks this up:** where the model list comes from. A hardcoded list rots as providers ship models; probing each CLI is better if either exposes one. Establish what is actually available before choosing, and record the answer in the ticket comments.

**Blocked by:** 06, 09

**Status:** ready-for-agent

- [ ] A single picker in the composer selects model and reasoning effort, grouped by Harness
- [ ] Selecting a model selects the Harness that serves it
- [ ] Only usable Harnesses appear as groups; a Harness that becomes unusable disappears without breaking the current Session
- [ ] Group headings name the Harness, and the permission and Skill differences are surfaced when switching across a group boundary
- [ ] Effort applies where supported and is omitted where not, without discarding the user's choice
- [ ] Model and effort are pinned into the Run configuration and visible in its record
- [ ] `ModelSelector.Root` is used; no `ModelContext` or transport wiring is introduced
- [ ] Component source is vendored in the repo's existing source-owned style
- [ ] Keyboard operation and the combobox accessibility contract survive vendoring
- [ ] `pnpm verify` passes
