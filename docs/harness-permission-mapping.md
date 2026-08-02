# Harness permission mapping

[ADR 0003](./adr/0003-harness-native-permissions.md) maps the app's two Permission Modes onto each Harness's native controls. That mapping is lossy, so it is written down here.

Sources: `.scratch/research/claude-code-permissions-and-protocol.md` and `.scratch/research/codex-permissions-and-protocol.md`, both verified against installed binaries (Claude Code 2.1.220, codex-cli 0.146.0) rather than documentation alone. Both CLIs change fast and both were found to contradict their own published docs — re-verify before trusting this file.

## Permission Modes

| Mode            | Claude Code                                                                    | Codex                                                        |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **Ask**         | `--permission-mode default` + `--permission-prompt-tool mcp__<server>__<tool>` | `approvalPolicy: "untrusted"` + `sandbox: "workspace-write"` |
| **Full access** | `--permission-mode bypassPermissions`                                          | `approvalPolicy: "never"` + `sandbox: "danger-full-access"`  |

Rejected values, and why:

- **Claude `acceptEdits`** is not Full access — edits plus seven filesystem commands, scoped to the working directory.
- **Claude `auto`** aborts non-interactive runs after repeated classifier blocks. **`dontAsk`** auto-_denies_ rather than prompting.
- **Codex `on-request`** lets _the model_ decide when to prompt, so a user who chose Ask can silently receive no prompts. Use `untrusted`.
- **Codex `--full-auto` / `--yolo`** are aliases whose meaning has already shifted; `--full-auto` is deprecated and `exec`-only.

## Where the modes are not equivalent

- **Ask granularity.** Codex's `workspace-write` permits file writes inside the workspace without prompting, and gates commands and out-of-workspace writes. Claude's `default` gates edits too, until a Standing Approval rule allows them. Ask therefore starts noisier on Claude.
- **Full access containment.** Codex `danger-full-access` disables its sandbox outright. Claude `bypassPermissions` skips prompts but is refused at startup where enterprise managed settings set `disableBypassPermissionsMode`.
- **Skills.** Native on Claude. Codex has no equivalent; the app injects methodology text via `developerInstructions` / `baseInstructions`. Skills will behave measurably better on Claude, per ADR 0003.

## Standing Approvals

Both Harnesses can express these natively. Do not build app-side interception.

**Claude** — declarative rules in the staged settings file:

- command: `permissions.allow: ["Bash(pnpm test:*)"]`
- repo-wide edits: `permissions.allow: ["Edit(//absolute/repo/path/**)"]`

`Edit(...)` is mandatory. From 2.1.210, `Write(...)` and `Glob(...)` path rules are accepted but never consulted.

**Codex** — execpolicy `.rules` files (`prefix_rule(pattern=[...], decision="allow")`), validated by `codex execpolicy check`. `bash -lc` chains are split with tree-sitter, so allowing `git add` cannot smuggle `rm -rf /`. Approval responses can create rules in-band via `acceptWithExecpolicyAmendment`, and the request carries a `proposedExecpolicyAmendment` — Codex computes the prefix for us. `acceptForSession` covers the session-scoped case.

Repo-wide edits on Codex are expressed as `workspace-write` with the repository as a writable root. Do not use `grantRoot` — it is marked `[UNSTABLE]` and may not be honoured.

## Per-Run configuration injection

Neither path mutates the user's own configuration, per ADR 0003.

**Claude** — `--settings <file-or-json>` with `--setting-sources`. It is a real precedence layer carrying `permissions.allow/deny/ask`, `defaultMode`, and `hooks`.

> **`CLAUDE_CONFIG_DIR` does not work for this.** A staged directory returns `Not logged in · Please run /login`, because OAuth account state lives in `<dir>/.claude.json` rather than the Keychain. It also relocates transcripts. `run-service.ts:703` currently uses it.

**Codex** — `thread/start.config` over the app-server protocol accepts an arbitrary config object, needing no files at all. Use it as the primary path. A staged `CODEX_HOME` is needed only for things that must be files: the `rules/` directory and MCP registration. `-c key=value` overrides everything and is available on every subcommand.

Never emit Codex's `default_permissions` — it silently disables `sandbox_mode`.

## Transport

**Codex must use the app-server protocol, not `codex exec`.** `exec` has no `--ask-for-approval` flag and _auto-rejects_ approvals without emitting an event, and its `file_change` items carry only `{path, kind}` with no diff. Both Ask mode and inline diffs are impossible on `exec`. The current adapter parses `exec --json`.

Generate Codex bindings with `codex app-server generate-json-schema`; the published docs disagree with the shipped binary on enum spellings.

## Inline diffs

Both Harnesses expose enough to render diffs in the Conversation, satisfying ADR 0004.

- **Claude**: the `Edit` tool result carries a sibling `tool_use_result` with `oldString`, `newString`, `originalFile`, and a ready-made `structuredPatch` of unified-diff hunks. Undocumented — pin a contract test to the installed version.
- **Codex**: app-server emits `fileChange.changes[].diff` per file, and `turn/diff/updated` with a full `git diff`.

## Known hazards

- Claude's `PermissionRequest` hooks never fire in `-p` mode on 2.1.220, contradicting the docs. `SessionStart` and `PreToolUse` from the same staged file do work. "Always allow" rule strings must therefore be synthesised by the app rather than taken from `permission_suggestions`.
- `--setting-sources ''` silently disables `--add-dir` skill discovery. Full isolation and staged skills are mutually exclusive.
- Claude managed settings outrank CLI arguments. Assert `system/init.permissionMode` after spawn rather than assuming the requested mode took effect.
- `--settings`, `--mcp-config`, and `--add-dir` are not restored on `--resume`; persist full argv, not just the session id. `bypassPermissions` is never restored.
- Invalid staged settings are silently ignored in `-p` with no error.

## Verified: allow rules short-circuit the prompt tool

They do. A `permissions.allow` rule delivered through `--settings` is consulted **before** `--permission-prompt-tool`, per call rather than wholesale, and an allowed call never reaches the app's tool at all. Reproduced on 2.1.220 for both `Bash(...)` and `Edit(//abs/path/**)`, with controls; method and captures are in `.scratch/research/claude-code-permissions-and-protocol.md`.

Three consequences the app is built on:

- The approval tool never consults the Standing Approval store, and must not. It only ever sees calls the rules did not match, so Claude Code's Bash-matching and gitignore-path semantics — word boundaries, compound splitting, wrapper stripping, four path anchors — are never reimplemented here.
- **A too-broad rule is unrecoverable at runtime**, because there is no interception point left after it matches. Breadth is therefore constrained where the rule is written: `app/src/shared/approval.ts` synthesises the narrowest rule that would stop the same question, refuses anything it cannot narrow honestly, and the literal string is shown before it is accepted.
- `system/init` does not report the effective rules, so the app cannot read back that its own rules loaded. Validate the staged JSON in-process before spawning — invalid settings are ignored in silence.

Two consequences of rules being staged per Run:

- **A rule granted mid-Run is not in that Run's settings**, which were written at spawn. The app therefore answers a later request in the same Run itself when that request proposes a rule it has just granted. This compares one synthesised rule string with another; it is not a second matcher and it never consults the store, so the Harness's own semantics stay the only thing deciding what a rule covers.
- **A Project root reached through a symlink may keep prompting.** Allow rules require both the link path and its target to match, and the app writes one `Edit(//…/**)` rule from the Project root as git resolved it. The failure is a grant that goes on asking, never a grant that reaches further than it said.
