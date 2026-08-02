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

**`thread/start.config` cannot be trusted to have applied anything.** Measured on 0.146.0: a `config` carrying `features.browser_use = false` is accepted, and so is one carrying `this_key_does_not_exist_xyz`. The field is `additionalProperties: true` and unknown keys are swallowed in silence, so acceptance is not evidence that a key was honoured. Use it for what has been observed to work (`model_reasoning_effort`), and never as a containment mechanism — a tool the app believes it disabled this way may simply be enabled.

Consequence for Ask on Codex: the tool-disabling `codex exec --disable browser_use …` argv has no app-server equivalent this app can verify, so Codex's own browser use, computer use, hooks, and plugins are reachable in Ask as well as Full access. Approval gates commands and out-of-workspace writes; a tool that acts without running a command is not a command. This is stated in the composer rather than left to be discovered.

## Transport

**Codex uses the app-server protocol, not `codex exec`.** `exec` has no `--ask-for-approval` flag and _auto-rejects_ approvals without emitting an event, and its `file_change` items carry only `{path, kind}` with no diff. Both Ask mode and inline diffs are impossible on `exec`. Ticket 10a moved the adapter onto app-server: one long-lived JSON-RPC peer per Run, with policy, sandbox, model, effort, the Skill, and the prompt all carried over the protocol rather than in argv.

Generate Codex bindings with `codex app-server generate-ts`; the published docs disagree with the shipped binary on enum spellings. The generated bindings and a recorded contract fixture live in the repo — see `docs/agents/codex-protocol.md` for regenerating both.

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

## Granting a rule mid-Run

A Run's settings are written at spawn, so a rule granted while it is running is not in them. The answer is native rather than app-side: the approval tool's allow result carries

```json
{ "behavior": "allow", "updatedInput": {…},
  "updatedPermissions": [ { "type": "addRules",
    "rules": [ { "toolName": "Bash", "ruleContent": "pnpm test:*" } ],
    "behavior": "allow", "destination": "session" } ] }
```

and the Harness applies it to the Thread it is already running. Verified on 2.1.220: the next matching request was not asked at all (`.scratch/research/…`, "Verified: mid-session rules"). Nothing in the app matches anything — its own matcher decides, exactly as it will next Run from the settings file.

`destination: "session"` is the only one this app will ever write. The others put rules in the person's own repository or home configuration.

T3 Code uses the same field for "accept for session", through the Agent SDK's `canUseTool` rather than an MCP tool. The SDK hands its callback ready-made `suggestions`; the prompt tool's request carries none, which is why rules are synthesised here.

## Path rules name the resolved path

The Harness resolves a path before checking any rule against it. Working through a symlinked root, a rule naming that root was **not** consulted and a rule naming its target **was**, and the request the app received already carried the resolved path. So an `Edit(//…/**)` rule is written from `realpath` of the Project root, not from the root as the person sees it.

## Allow rules never cover protected paths

`.claude`, `.git`, `.vscode`, and the documented dotfiles are outside any allow rule in every mode except `bypassPermissions` — observed, with an exact-path rule that still prompted. A Project inside one keeps asking whatever is stored, and no Standing Approval can change that.
