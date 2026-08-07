# ADR 0003: Harness-native permissions instead of an app-owned tool host

Status: accepted
Date: 2026-08-01

Supersedes the model-visible tool surface described in the follow-up decision of
[ADR 0001](./0001-adopt-effect-in-core.md), and the planning-only containment
model of the pre-pivot product (see git history for
`.scratch/idea-development-desktop/`).

## Context

The planning product enforced a fixed, non-overridable planning-only sandbox: no
source edits, no command execution, no Git mutation, even under a Harness's own
Full access mode. The old implementation advertised only app-owned tools and
validated them with an app-owned planning policy; both seams have been deleted.

The pivoted product is a coding agent. Its entire purpose is to edit source and
run commands, so a planning-only policy cannot survive. The open question was
who enforces the replacement.

## Decision

The Harness's **native tools and native permission system** do the work. The app
selects a **Permission Mode** — `Ask` or `Full access` — and maps it onto each
Harness's native flags.

**Standing Approvals** are expressed natively — Claude Code permission rules and
Codex execpolicy rules — injected **per Run** through each Harness's own
non-mutating override mechanism. The app never writes to the user's own provider
configuration (`~/.claude/settings.json`, `~/.codex/config.toml`), because those
files govern the user's terminal usage of tools the app does not own. The exact
mechanism per Harness is recorded in
[docs/harness-permission-mapping.md](../harness-permission-mapping.md).

The Main-owned MCP host is **retained but reduced** to tools that have no native
equivalent — currently `offer_response_options`, which backs Suggested Responses.
MCP _adds_ tools alongside the native ones; it no longer replaces them.

## Considered options

- **Keep the app-owned tool host as the only model-visible surface.** Perfectly
  uniform across Harnesses and provider-independent — this is what the existing
  architecture was built for. Rejected because it means reimplementing the entire
  tool layer (file edits, patch application, command execution, streaming output)
  and forfeiting each Harness's native strengths. The result would be a worse
  Codex than Codex. The tool host existed because planning needed tools that do
  not exist natively; a coding agent's tools do.
- **Surface each Harness's native modes verbatim.** Nothing lossy, nothing
  invented. Rejected because it leaks the implementation into the UI: users
  choose a Harness for quality and cost, not to change how permissions work.

## Consequences

- The planning policy and planning-only tool-host seams are removed. `ToolHost`
  serves only capabilities with no native counterpart.
- **The mode mapping is lossy and must be documented.** Codex thinks in approval
  policy crossed with sandbox scope; Claude Code thinks in permission modes. Ask
  and Full access will not behave identically on both, and the differences must
  be stated in the UI rather than discovered. The mapping is recorded in
  [docs/harness-permission-mapping.md](../harness-permission-mapping.md).
- Capabilities without a counterpart on both sides are Harness-conditional.
  Claude's plan mode is the current example.
- Skills work better on Claude Code, which supports them natively, than on Codex,
  where the app injects skill text as a prompt prefix. This gap is accepted and
  should be surfaced to the user, not hidden.
- The app can no longer guarantee containment. Containment is the Harness's, and
  the user's chosen mode is real. This is the deliberate trade for being a
  coding agent at all.
- All Harness-specific permission mapping, rule staging, Approval Request
  transport, and in-Run answers live inside the selected Main Harness Adapter.
  Common Run orchestration sees only the Adapter interface.
