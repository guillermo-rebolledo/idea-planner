# 13 — Model and reasoning effort selection

**What to build:** One control in the composer replaces the separate Harness, model, and effort selects. The user picks a model — grouped under the Harness that reaches it — and a thinking level, and those choices are pinned into the Run.

Choosing a model chooses the Harness. Users think in models, not in which CLI wrapper reaches them. When only one Harness is usable (ticket 09), the picker simply shows fewer groups, rather than presenting a Harness selector with one disabled option.

That collapse hides something real, so the UI must not let it hide silently: the Harness carries behaviour the model does not. **Ask and Full access do not behave identically across Harnesses** (`docs/harness-permission-mapping.md`), and **Skills work better on Claude Code than on Codex** ([ADR 0003](../../../docs/adr/0003-harness-native-permissions.md)). Switching model across a group boundary changes both. Head each group with the Harness name and surface the difference at the point of switching.

Use `ModelSelector` from assistant-ui's shadcn registry (`https://www.assistant-ui.com/docs/ui/model-selector`).

**Use `ModelSelector.Root`, not the default export.** The default export registers the selection into assistant-ui's `ModelContext`, which its transport then sends as `config` in an HTTP request body to an API route. This app has no backend — it spawns local CLIs and passes flags. `ModelSelector.Root` is presentational, with controlled value and effort props, which is what the existing per-Run configuration needs. Effort maps to each Harness's reasoning-effort flag; models without configurable reasoning omit `efforts` and the Thinking row hides itself.

This is the first substantial UI dependency the repo takes on: `command` (cmdk) and `popover`, plus `@base-ui/react`. Follow the existing source-owned component convention rather than adding a component library as a runtime dependency.

**Open decision for whoever picks this up:** where the model list comes from. A hardcoded list rots as providers ship models; probing each CLI is better if either exposes one. Establish what is actually available before choosing, and record the answer in the ticket comments.

**Blocked by:** 06, 09

**Status:** done

- [x] A single picker in the composer selects model and reasoning effort, grouped by Harness
- [x] Selecting a model selects the Harness that serves it
- [x] Only usable Harnesses appear as groups; a Harness that becomes unusable disappears without breaking the current Session
- [x] Group headings name the Harness, and the permission and Skill differences are surfaced when switching across a group boundary
- [x] Effort applies where supported and is omitted where not, without discarding the user's choice
- [x] Model and effort are pinned into the Run configuration and visible in its record
- [x] `ModelSelector.Root` is used; no `ModelContext` or transport wiring is introduced
- [x] Component source is vendored in the repo's existing source-owned style
- [x] Keyboard operation and the combobox accessibility contract survive vendoring
- [x] `pnpm verify` passes

## Answer — where the model list comes from

The open decision, settled by asking both installed binaries rather than by choosing in the abstract.

**Codex enumerates its own.** Its app-server answers `model/list` — no thread, no turn, so no request against the person's account — with an id, a display name, a description, whether it is hidden from Codex's own picker, and *the reasoning efforts each model supports*. Those differ per model: the installed 0.146.0 offered six levels for its default and four for others. A hardcoded list would have been wrong about that within a release, so Codex is asked, and models it hides are not shown.

**Claude Code enumerates nothing.** There is no listing command — `claude models` is not a subcommand, it is a prompt, which is what running it proved. What its `--model` help documents is aliases that follow the latest of each family, so those are what the app offers, alongside `default`, which leaves the choice to the Harness's own configuration. Aliases age far more slowly than versions. Claude takes `--effort` alongside any model, so its levels belong to the Harness rather than to a model.

The catalog says which of the two it was, and a Harness that cannot answer contributes no group at all — an empty group would say the Harness has no models, which is a different thing from this app not having been able to ask.

## Answer — what was vendored, and what was left behind

`ModelSelectorRoot` and its presentational parts, from `https://r.assistant-ui.com/base/model-selector.json`. The registry's default export renders a `ModelSelectorModelContext` that registers the selection into assistant-ui's `ModelContext` for its transport to send as an HTTP request body — exactly what this app has nowhere to send. That export, its registration, and the `@assistant-ui/react` import that only it needed are gone; the dependency is not taken at all.

The rest is kept close to its source so a newer registry copy can be diffed against it, which is why it is exempt from formatting and lint the same way the generated Codex bindings are.

Two primitives it imports are written here rather than pulled in: `ui/command` over cmdk and `ui/popover` over Base UI, in the same source-owned style as `ui/button`. The new runtime dependencies are `cmdk` and `@base-ui/react` — the primitives themselves, not a component library.

The trigger is a `combobox` with `aria-haspopup="listbox"`, arrows open it, and the vendored effort row hands vertical arrows back to the list so one keyboard contract owns the popup. The packaged-shell test drives it by role.

## Answer — effort is kept, and only asked for where it applies

The choice is the person's and is never rewritten: switching to a model with fewer levels and back finds the level still there. What a Run is *asked for* is `applicableEffort`, which is null when the chosen model does not offer that level or offers none at all — and a Run with no level passes no `--effort` to Claude Code and no `model_reasoning_effort` to Codex, rather than asking for something the Harness would refuse.

Claude Code's levels are the five its own `--effort` help documents, not three.

## Answer — what a Run was asked for is on the Run

The Run's own panel names the Harness, the model, the level and the Skill it was accepted with. A Run keeps what it was given whatever is chosen after it, and that is the record the ticket asked to be visible.

## Answer — the groups follow the Harnesses

The catalog is read when the Session opens and again whenever the window regains focus, because a Harness is repaired, installed or removed somewhere else entirely — in its own dialog, or in a terminal. A Harness that stops being usable stops being a group, and the choice falls back to one that can still run a message; a Run already sent keeps what it recorded.

## Answer — provider logos

The registry's optional `logos` item is plain inline SVG with no dependencies, which is what makes it usable here: a remote image would not survive the sandbox's content policy. Two marks are vendored — the two providers this app's Harnesses actually reach — and the Gemini mark the registry also ships is left behind rather than carried for a Harness this app cannot drive.
