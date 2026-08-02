# Claude Code permissions, per-run config injection, and stream protocol

Research date: 2026-08-01

Harness under test: Claude Code `2.1.220` at `/Users/guillermoortizrebolledo/.local/bin/claude` (native binary, macOS arm64).

## Question

For a macOS Electron app that drives the locally installed `claude` CLI as a child process and exposes exactly two permission modes ("Ask" and "Full access") plus per-Repository Standing Approvals: what permission modes and rule syntax exist, how can settings be injected **per run** without mutating `~/.claude/settings.json`, how does a non-interactive run request approval, and what exactly does the `stream-json` protocol emit for edits, commands, usage, and session identity?

## Executive conclusion

- **Ask → `--permission-mode default`** (the CLI also accepts the alias `manual`) **plus a per-run approval channel.** Two channels work; only one is reliable.
- **Full access → `--permission-mode bypassPermissions`** (equivalently `--dangerously-skip-permissions`). `acceptEdits` is *not* full access: it auto-approves file edits and a small filesystem-command set only. `auto` is not a safe substitute either, since it is account/model-gated and aborts a `-p` run after repeated classifier blocks.
- **Per-run config injection is `--settings <file-or-json>` plus `--setting-sources`.** `--settings` is a first-class layer in the precedence chain (below managed, above local/project/user) and it carries `permissions.allow/deny/ask`, `permissions.defaultMode`, **and `hooks`**. Verified locally: a staged settings file registered `SessionStart` and `PreToolUse` hooks and changed `permissionMode` for one run, with `~/.claude/settings.json` untouched.
- **`CLAUDE_CONFIG_DIR` is NOT usable as the staging mechanism.** Pointing it at a fresh directory breaks authentication on this machine (`Not logged in · Please run /login`), because the OAuth account state lives in `<config dir>/.claude.json`. It also relocates session transcript storage. Use `--settings` instead.
- **Two blocking findings** are documented in [Blockers](#blockers-for-the-described-design): `PermissionRequest` hooks did not fire at all in `-p` mode on 2.1.220 despite the docs, and `--setting-sources ''` silently disables `--add-dir` skill discovery.
- **Inline diffs are directly available.** The `Edit` tool's `tool_result` stream event carries a sibling `tool_use_result` object containing `oldString`, `newString`, `originalFile`, and a `structuredPatch` array of unified-diff hunks. No reconstruction needed.

## Evidence base

Every claim below is tagged. `[docs]` = Anthropic documentation. `[local]` = reproduced against the installed binary on this machine. `[unverified]` = documented but not reproduced, or reproduced with a contradictory result.

Local probe artifacts were written to `~/cc-probe/` and `$TMPDIR/opencode/cc-probe/` during this research and are disposable.

---

## 1. Permission modes

### The six modes

`claude --help` on 2.1.220 lists the accepted `--permission-mode` values: `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`. [local]

The value `default` is also accepted even though `--help` does not list it: `claude --permission-mode default -p "reply with OK only"` returned `OK`, while `claude --permission-mode nonsense` failed with `error: option '--permission-mode <mode>' argument 'nonsense' is invalid. Allowed choices are acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.` [local]

Anthropic confirms the relationship: the mode's config value is `default`, the UI label is Manual, and `manual` is an accepted alias from v2.1.200 onward. Both spellings work and `--help` shows `manual` in place of `default`. [docs: [CLI reference `--permission-mode`](https://code.claude.com/docs/en/cli-reference), [Permission modes](https://code.claude.com/docs/en/permission-modes)]

| Mode | Runs without asking | Notes |
| --- | --- | --- |
| `default` / `manual` | Reads only | Every write and non-read-only command prompts |
| `acceptEdits` | Reads, file edits, and `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed` | Only for paths inside cwd or `additionalDirectories`. All other Bash commands still prompt |
| `plan` | Reads, plus classifier-approved commands when auto mode is available | Edits blocked until a plan is approved |
| `auto` | Everything, with a classifier reviewing each action | Account-, plan-, model-, and provider-gated |
| `dontAsk` | Only pre-approved tools | Auto-denies anything that would otherwise prompt. Never waits for input |
| `bypassPermissions` | Everything | Includes writes to protected paths |

[docs: [Permission modes — Available modes](https://code.claude.com/docs/en/permission-modes)]

### What still prompts in every mode

These are not overridable by mode, and matter because they can stall a `-p` run:

- Explicit `deny` rules and explicit `ask` rules.
- Connector tools an organization set to `ask`, and MCP tools marked `_meta["anthropic/requiresUserInteraction"]`.
- Removals targeting `/` or `~` (e.g. `rm -rf /`, `rm -rf ~`), including via `$(...)`, backticks, or `<(...)` substitution — a circuit breaker that fires even in `bypassPermissions`.

[docs: [Permission modes — bypassPermissions](https://code.claude.com/docs/en/permission-modes)]

In `bypassPermissions`, allow rules have no effect because everything else is already approved. [docs: same]

### Protected paths

Writes to a fixed set of paths are never auto-approved except in `bypassPermissions` (and in planning sessions that have bypass available). Protected directories include `.git`, `.claude` (except `.claude/worktrees`), `.vscode`, `.idea`, `.husky`, `.cargo`, `.devcontainer`, `.yarn`, `.mvn`, `.config/git`. Protected files include shell rc files, `.npmrc`/`.yarnrc`, `.gitconfig`, `.mcp.json`, `.claude.json`, and others.

Critically: **`permissions.allow` rules do not pre-approve protected-path writes.** The safety check runs before allow rules are evaluated, so `Edit(.claude/**)` in any settings file does not change the outcome. Per-mode behaviour is: `default`/`acceptEdits` prompt, `plan` prompts, `auto` routes to the classifier, `dontAsk` denies, `bypassPermissions` allows. [docs: [Permission modes — Protected paths](https://code.claude.com/docs/en/permission-modes)]

This means a Standing Approval of "edit anything in this repo" cannot cover `.git/**` or `.claude/**` unless the run is in Full access.

### Recommended mapping

| App mode | Flags | Rationale |
| --- | --- | --- |
| **Ask** | `--permission-mode default` + `--permission-prompt-tool mcp__<server>__<tool>` | `default` prompts on everything except the built-in read-only command set. The prompt tool converts each prompt into an MCP round-trip the Electron app answers. Verified working. |
| **Full access** | `--permission-mode bypassPermissions` | The only mode that genuinely skips checks including protected paths. |

Do **not** use `dontAsk` for Ask: it auto-denies rather than prompting, and it denies `AskUserQuestion` outright even when allowed. [docs: [Permission modes — dontAsk](https://code.claude.com/docs/en/permission-modes)]

Do **not** use `auto` for Full access: availability depends on plan, organization policy, model, and provider, and in `-p` mode "repeated blocks abort the session since there is no user to prompt." [docs: [Permission modes — When auto mode falls back](https://code.claude.com/docs/en/permission-modes)]

`bypassPermissions` has two operational constraints the app must handle:

1. The first interactive launch with the mode enabled shows a one-time acceptance dialog, saved to user settings. In `-p` mode no dialog is shown; but a `--bg` background session is refused until the dialog has been accepted in an interactive session. [docs: [Permission modes — bypassPermissions](https://code.claude.com/docs/en/permission-modes)]
2. On macOS/Linux the CLI refuses to start in this mode as root or under `sudo`. [docs: same]

---

## 2. Permission rules

### Syntax

Rules are `Tool` or `Tool(specifier)`, grouped into `permissions.allow`, `permissions.ask`, and `permissions.deny` arrays.

Evaluation order is **deny, then ask, then allow**; the first match in that order wins and specificity does not change the order. A broad deny beats a narrow allow. [docs: [Permissions — Manage permissions](https://code.claude.com/docs/en/permissions)]

```json
{
  "permissions": {
    "allow": ["Bash(pnpm test:*)", "Bash(git commit *)", "Edit(src/**)"],
    "ask":   ["Bash(git push *)"],
    "deny":  ["Read(./.env)", "Bash(curl *)"]
  }
}
```

A bare tool name in `deny` (e.g. `"Bash"`) removes the tool from Claude's context entirely; a scoped rule (`"Bash(rm *)"`) leaves the tool available and blocks matching calls. [docs: same]

### Bash matching semantics

- `*` matches any sequence including spaces and can appear anywhere: `Bash(npm *)`, `Bash(* install)`, `Bash(git * main)`.
- A **space before a trailing `*` enforces a word boundary**: `Bash(ls *)` matches `ls -la` but not `lsof`; `Bash(ls*)` matches both.
- `Bash(ls:*)` is an exact synonym for `Bash(ls *)`. The `:*` form is only recognised at the end of a pattern — in `Bash(git:* push)` the colon is a literal.
- `Bash(*)` is equivalent to bare `Bash`.
- Compound commands are split on `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines; **every subcommand must match independently**. So `Bash(safe-cmd *)` does not permit `safe-cmd && other-cmd`.
- Wrappers `timeout`, `time`, `nice`, `nohup`, `stdbuf`, shell builtins `command`/`builtin`, zsh `noglob`, and bare flagless `xargs` are stripped before matching. `command -v` and `nocorrect` are not.
- A leading assignment of a known-safe env var is stripped for allow rules (`NODE_ENV=test npm test` matches `Bash(npm test *)`); deny/ask rules match past **any** leading assignment.
- Environment runners (`npx`, `docker exec`, `devbox run`, `mise exec`, `direnv exec`) are **not** stripped, so `Bash(devbox run *)` would also permit `devbox run rm -rf .`. Write runner+inner-command rules instead.
- Exec wrappers `watch`, `setsid`, `ionice`, `flock`, and `find` with `-exec`/`-delete` always prompt and cannot be prefix-approved.

[docs: [Permissions — Bash](https://code.claude.com/docs/en/permissions)]

### File rules: only `Edit(...)` and `Read(...)` are consulted

This is a sharp edge. From v2.1.210, Claude Code checks file permissions against `Edit(path)` and `Read(path)` rules **only**. A path rule written for `Write`, `NotebookEdit`, `Glob`, or `MultiEdit` is accepted but never consulted, and produces a startup warning. `Edit` rules cover all file-editing tools. [docs: [Permissions — Read and Edit](https://code.claude.com/docs/en/permissions)]

So a Standing Approval for edits must be written as `Edit(...)`, not `Write(...)`.

Path patterns use gitignore syntax with four anchors:

| Pattern | Anchor |
| --- | --- |
| `//path` | filesystem root (absolute) |
| `~/path` | home directory |
| `/path` | **the settings source that defines the rule** |
| `path` / `./path` | current directory |

The `/path` anchor is the trap: for a file passed with `--settings <file>`, `/path` resolves to `<directory of the settings file>/path`. [docs: [Permissions — Read and Edit](https://code.claude.com/docs/en/permissions)] For a staged config directory that lives outside the repo, this means **do not write `Edit(/src/**)` in a staged settings file** — it will anchor at the staging directory, not the repo. Use absolute `//` paths built from the repository path.

Depth semantics differ by rule type for single-segment relative patterns:
- Allow rules: `Edit(src/**)` matches only `<cwd>/src`.
- Deny/ask rules: `Read(secrets/**)` matches a `secrets` directory at **any depth**.
- `Edit(/src/**)` and `Edit(**/src/**)` behave the same in all rule types.

[docs: same]

Symlinks are checked on both the link path and its target. Allow rules require **both** to match (otherwise it prompts); deny rules fire if **either** matches. [docs: same]

### Answers to the Standing Approval questions

**"Always allow all file edits in this project"** — yes, with caveats:

```json
{ "permissions": { "allow": ["Edit(//Users/me/dev/my-repo/**)"] } }
```

Caveats: this does not cover protected paths (`.git`, `.claude`, `.vscode`, dotfiles listed above) in any mode except `bypassPermissions`; and it does not cover shell commands that write files (`Bash(sed ...)`, a Python script, etc.) — Read/Edit deny rules apply to Claude's built-in file tools and to file commands Claude Code recognises in Bash, but not to arbitrary subprocesses. [docs: [Permissions — Read and Edit](https://code.claude.com/docs/en/permissions)]

Using `--permission-mode acceptEdits` is the coarser alternative and additionally auto-approves the filesystem command set, scoped to cwd/`additionalDirectories`.

**"Always allow this specific command"** — yes:

```json
{ "permissions": { "allow": ["Bash(pnpm test:*)"] } }
```

Store the Standing Approval as the literal rule string. The app should surface the word-boundary rule (`pnpm test:*` ≡ `pnpm test *`) and the compound-command rule to the user, because a naive "always allow `pnpm test`" does not permit `pnpm test && pnpm lint`.

### Rules via CLI flags

`--allowedTools` / `--allowed-tools` and `--disallowedTools` / `--disallowed-tools` accept comma- or space-separated rules in the same syntax, e.g. `--allowedTools "Bash(git diff *),Bash(git commit *)"`. [local: `claude --help`] [docs: [Headless — Create a commit](https://code.claude.com/docs/en/headless)]

These are a thinner surface than `--settings` (no `ask` array, no `defaultMode`, no hooks), so prefer the staged settings file as the single injection point.

---

## 3. Settings precedence and per-run override

### Where settings live

| Scope | Location |
| --- | --- |
| Managed | server-managed, macOS `com.anthropic.claudecode` plist, Windows registry, or `/Library/Application Support/ClaudeCode/managed-settings.json` (+ `managed-settings.d/`) |
| User | `~/.claude/settings.json` |
| Project | `.claude/settings.json` |
| Local | `.claude/settings.local.json` (at the git repository root from v2.1.211) |
| Other config | `~/.claude.json` — OAuth session, user/local MCP servers, per-project trust state, caches |

[docs: [Settings — Settings files](https://code.claude.com/docs/en/settings)]

### Precedence (highest first)

1. **Managed settings** — cannot be overridden by anything, including CLI arguments.
2. **Command line arguments**, including `--settings`.
3. Local project settings (`.claude/settings.local.json`)
4. Shared project settings (`.claude/settings.json`)
5. User settings (`~/.claude/settings.json`)

[docs: [Settings — Settings precedence](https://code.claude.com/docs/en/settings)]

Two merge rules matter:

- Scalars from a higher-priority scope override lower ones.
- **Array-valued settings, including `permissions.allow`/`deny`/`ask`, are concatenated and de-duplicated across scopes rather than replaced.** [docs: same] So a staged `--settings` file *adds* rules; it cannot subtract rules the user set in `~/.claude/settings.json`. To get a clean slate, combine it with `--setting-sources`.

### The per-run injection mechanism

**`--settings <file-or-json>`** — "Path to a settings JSON file or a JSON string to load additional settings from." [local: `claude --help`] Anthropic documents it as a full precedence layer: "JSON passed via `--settings <file-or-json>` merges with file-based settings using the same rules as the other layers: a key set here overrides the same key in local, project, or user settings, and omitting a key leaves the lower-layer value in place." [docs: [Settings — Settings precedence](https://code.claude.com/docs/en/settings)]

`--settings` is explicitly a *trusted* source. Several settings that Claude Code refuses to read from a repository's checked-in files are honoured from `--settings`, including `autoMode`, `sandbox.filesystem.disabled`, `sandbox.network.strictAllowlist`, `sandbox.credentials.*`, `processWrapper`, and `pluginConfigs`. [docs: [Settings — Available settings](https://code.claude.com/docs/en/settings)]

**`--setting-sources <sources>`** — "Comma-separated list of setting sources to load (user, project, local)." [local: `claude --help`] [docs: [CLI reference](https://code.claude.com/docs/en/cli-reference)] Passing an empty string suppresses all three file scopes.

**Verified locally.** A staged settings file at `~/cc-probe/staged3.json`:

```json
{
  "permissions": { "defaultMode": "default" },
  "hooks": {
    "SessionStart":      [ { "hooks": [ { "type": "command", "command": ".../session.sh" } ] } ],
    "PreToolUse":        [ { "matcher": "*", "hooks": [ { "type": "command", "command": ".../hook2.sh", "timeout": 30 } ] } ]
  }
}
```

invoked as `claude -p ... --settings ./staged3.json --setting-sources ''` produced `system/init` with `"permissionMode": "default"`, fired the `SessionStart` hook, fired the `PreToolUse` hook, and honoured its `permissionDecision: "allow"` so the command ran with `permission_denials: []`. The user's `~/.claude/settings.json` (which sets `defaultMode: acceptEdits`) was not modified and did not win. [local]

`--setting-sources ''` also visibly isolated the run: `system/init.skills` dropped from 127 entries to 16, and `plugins` was empty, versus the user's 6 enabled plugins. [local]

### Alternatives and why they are worse

| Mechanism | Verdict |
| --- | --- |
| `--settings` + `--setting-sources` | **Recommended.** Full settings surface including hooks; never touches user files. |
| `CLAUDE_CONFIG_DIR` | **Do not use.** See below. |
| `--add-dir` | Grants file access, not configuration. Only `.claude/skills/`, `.claude/agents/`, and the `enabledPlugins`/`extraKnownMarketplaces` settings keys load from these directories. [docs: [Permissions — Additional directories grant file access, not configuration](https://code.claude.com/docs/en/permissions)] |
| `--bare` | Skips hooks, LSP, plugin sync, auto-memory, keychain reads, and CLAUDE.md auto-discovery, and forces `ANTHROPIC_API_KEY`/`apiKeyHelper` auth. [local: `--help`] Not usable for an app relying on the user's existing subscription login. |
| `--safe-mode` | Disables all customizations for troubleshooting; too blunt. [local: `--help`] |
| Writing `.claude/settings.local.json` in the user's repo | Mutates the user's working tree. Rejected by the design constraint. |

### `CLAUDE_CONFIG_DIR` is a dead end

Documented as: "Override the configuration directory (default: `~/.claude`). All settings, session history, and plugins are stored under this path, as are credentials on Linux and Windows; on macOS, credentials are in the system Keychain." [docs: [Environment variables](https://code.claude.com/docs/en/env-vars)]

**It breaks auth on macOS anyway.** Running `CLAUDE_CONFIG_DIR="$HOME/cc-probe/cfg" claude -p "say hi" --output-format json` against a fresh directory returned `"is_error": true` with result `Not logged in · Please run /login` and `apiKeySource: "none"`, and created a new `cfg/.claude.json`, `cfg/projects/`, `cfg/sessions/`. [local] The macOS Keychain holds the credential, but the account/session state that Claude Code needs lives in `<config dir>/.claude.json`, which the fresh directory lacks.

It would also relocate session transcripts away from the user's `~/.claude/projects/`, splitting their history. [docs: [Sessions — Where transcripts are stored](https://code.claude.com/docs/en/sessions)]

### Limitations of the `--settings` mechanism

1. **Managed settings outrank it.** On a machine with an MDM profile or `managed-settings.json`, the staged file cannot override policy — and `allowManagedPermissionRulesOnly: true` in managed settings prevents *any* non-managed source from defining `allow`/`ask`/`deny` rules. [docs: [Permissions — Managed-only settings](https://code.claude.com/docs/en/permissions)] The app must detect this (see [Open questions](#open-questions--could-not-verify)) and degrade gracefully.
2. **Arrays merge upward.** Without `--setting-sources`, the user's own allow rules still apply on top of the staged ones.
3. **`/path` rules anchor at the settings file's directory**, not the repo. Use `//` absolute paths.
4. **Not restored on resume.** "If the session depended on `--mcp-config`, `--settings`, `--plugin-dir`, `--fallback-model`, or directories added with `--add-dir`, pass them again when you resume." [docs: [Sessions — What a resumed session restores](https://code.claude.com/docs/en/sessions)] The app must persist the full argv, not just the session ID.
5. **`-p` mode silently ignores invalid settings files.** "Settings files that fail validation are silently ignored in this mode (no error dialog is shown)." [local: `--help` on `-p`] The app must validate its own generated JSON and assert `system/init.permissionMode` matches what it asked for.
6. **`--setting-sources ''` has a side effect on `--add-dir`** — see [Blockers](#blockers-for-the-described-design).

---

## 4. Programmatic approval

### `--permission-prompt-tool` — verified, and the right primitive for "Ask"

The flag is **absent from `claude --help` on 2.1.220** but is accepted and functional, and is documented in the CLI reference: "Specify an MCP tool to handle permission prompts in non-interactive mode." From v2.1.206 Claude Code waits for that tool's MCP server to connect before the first turn, up to the `MCP_TIMEOUT` startup timeout of 30 seconds. [docs: [CLI reference `--permission-prompt-tool`](https://code.claude.com/docs/en/cli-reference)] [local: flag accepted; `claude --totally-bogus-flag` errors with `unknown option`, so acceptance is meaningful]

**Verified end to end.** A minimal stdio MCP server exposing `approve`, wired with:

```
claude -p "<prompt>" \
  --output-format stream-json --verbose \
  --setting-sources '' \
  --strict-mcp-config \
  --mcp-config '{"mcpServers":{"approver":{"command":"node","args":["/path/mcpsrv.mjs"]}}}' \
  --permission-prompt-tool mcp__approver__approve
```

**Request** — the exact `tools/call` params Claude Code sent, captured on the wire:

```json
{
  "name": "approve",
  "arguments": {
    "tool_name": "Bash",
    "input": { "command": "python3 -c 'print(99)'", "description": "Print 99 using python3" },
    "tool_use_id": "toolu_01VTmheSC7ib3hzCWY7Ezb9Y"
  },
  "_meta": {
    "claudecode/toolUseId": "toolu_01VTmheSC7ib3hzCWY7Ezb9Y",
    "progressToken": 2
  }
}
```

**Response** — the tool returns an ordinary MCP tool result whose text content is a JSON-encoded decision.

Allow (verified): text content `{"behavior":"allow","updatedInput":{...}}`. The command executed; `permission_denials` was `[]`. [local]

Deny (verified): text content `{"behavior":"deny","message":"User declined in the desktop app"}`. The stream produced a `tool_result` with `"content": "User declined in the desktop app", "is_error": true`, and the final `result` message listed the call under `permission_denials`. [local]

This shape matches the Agent SDK's `canUseTool` return type: `{ behavior: "allow", updatedInput }` / `{ behavior: "deny", ... }`. [docs: [Agent SDK — Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)]

Documented restriction: the prompt tool cannot approve an MCP tool marked `requiresUserInteraction` — an `allow` result for one is converted to a deny (v2.1.199+). [docs: [CLI reference](https://code.claude.com/docs/en/cli-reference)]

This is exactly the "Ask" primitive: the app runs its own MCP server (which it already plans to, for `offer_response_options`), blocks in the tool handler, renders an approval card in the Electron UI, and returns allow/deny.

### `PreToolUse` hooks — verified, and the right primitive for Standing Approvals

`PreToolUse` runs after Claude creates tool parameters and before the tool call is processed, for every tool except `EndConversation`. Input includes `tool_name`, `tool_input`, `tool_use_id`, plus common fields `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`. [docs: [Hooks reference — PreToolUse](https://code.claude.com/docs/en/hooks)]

Output shape:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Standing approval for this repository",
    "updatedInput": { "...": "optional, replaces the entire input object" },
    "additionalContext": "optional string added to Claude's context"
  }
}
```

`permissionDecision` accepts `"allow"` (skip the prompt), `"deny"` (block), `"ask"` (force a prompt), and `"defer"` (exit gracefully so the tool can be resumed later). Exit code 0 with no output means "no decision" and the normal permission flow continues — silence does not approve. [docs: same]

**Verified locally:** a `PreToolUse` hook registered *only* through `--settings` returned `permissionDecision: "allow"` for `python3 -c 'print(42)'` in `--permission-mode default`, and the command ran with `permission_denials: []`. Without the hook the identical run returned `tool_result: "This command requires approval", is_error: true`. [local]

Important constraints:

- **Hook decisions do not bypass permission rules.** Deny and ask rules are evaluated regardless of what the hook returns; a matching deny blocks, and a matching ask still prompts, even after `"allow"`. [docs: [Permissions — Extend permissions with hooks](https://code.claude.com/docs/en/permissions)]
- A hook exiting with code 2 blocks the call *before* permission rules are evaluated, so it beats allow rules too. [docs: same]
- Hooks are enforced by Claude Code, but the `if` filter is best-effort and fails open on unparseable Bash. Use permission rules for hard boundaries. [docs: [Hooks reference — Common fields](https://code.claude.com/docs/en/hooks)]
- Hook handler types are `command`, `http`, `mcp_tool`, `prompt`, and `agent`. The `http` type POSTs the same JSON to a URL and reads the same JSON output from the response body — attractive for an Electron app that already runs a local server, avoiding a process spawn per tool call. Note that for HTTP hooks, non-2xx responses, connection failures, and timeouts are **non-blocking errors that allow execution to continue**. [docs: [Hooks reference — HTTP hook fields](https://code.claude.com/docs/en/hooks)]
- Default `timeout` is 600s for `command`/`http`/`mcp_tool`. [docs: same]

### Can hooks implement Standing Approvals?

Yes, and there are two viable designs:

**(a) Declarative — preferred.** Materialise each Standing Approval as a `permissions.allow` entry in the staged settings file. No process spawn, no IPC, no failure mode. Handles both "always run this command" (`Bash(pnpm test:*)`) and "always edit files here" (`Edit(//abs/repo/path/**)`). **Verified to short-circuit `--permission-prompt-tool`** — see [Verified: allow-rule vs permission-prompt-tool interaction](#verified-allow-rule-vs-permission-prompt-tool-interaction). [local]

**(b) Programmatic.** A `PreToolUse` hook consults the app's own store and returns `allow`. Necessary only if the approvals need logic that rule syntax cannot express (e.g. argument validation, time-boxing, rate limiting).

Design (a) short-circuits earlier and is what the permission system is for. Use (b) only for approvals that (a) cannot represent.

### `AskUserQuestion` in `-p` mode

`AskUserQuestion` and `ExitPlanMode` require user interaction and normally block in `-p` mode. A `PreToolUse` hook satisfies the requirement by returning `permissionDecision: "allow"` **together with** `updatedInput`. Returning `"allow"` alone is not sufficient. For `AskUserQuestion`, echo back the original `questions` array and add an `answers` object mapping each question's text to the chosen label; multi-select answers join labels with commas. [docs: [Hooks reference — PreToolUse decision control / AskUserQuestion](https://code.claude.com/docs/en/hooks)] This confirms the mechanism already recorded in `local-cli-harness-capabilities.md`.

A cleaner alternative exists via `"defer"`: the hook returns `permissionDecision: "defer"`, the process exits with `stop_reason: "tool_deferred"` and the pending tool call preserved in the transcript; the app collects the answer, resumes, and the hook then returns `"allow"` with the answer in `updatedInput`. `--resume` restores the permission mode the tool was deferred under, except `plan` and `bypassPermissions` which are never carried over. [docs: same] [unverified — not reproduced locally]

### `PermissionRequest` hooks — documented but did NOT fire

See [Blockers](#blockers-for-the-described-design).

### `updatedPermissions` — persisting an approval mid-session

`PermissionRequest` hooks can return `updatedPermissions`, an array of permission-update entries, alongside `behavior: "allow"`. Entry types: `addRules`, `replaceRules`, `removeRules`, `setMode`, `addDirectories`, `removeDirectories`. Each carries a `destination`:

| `destination` | Writes to |
| --- | --- |
| `session` | in-memory only, discarded at session end |
| `localSettings` | `.claude/settings.local.json` |
| `projectSettings` | `.claude/settings.json` |
| `userSettings` | `~/.claude/settings.json` |

[docs: [Hooks reference — Permission update entries](https://code.claude.com/docs/en/hooks)]

For this app, **only `destination: "session"` is acceptable** — the other three write into the user's repo or home config, violating the design constraint. But since `PermissionRequest` does not fire in `-p` mode on this version, this surface is unavailable anyway; persist Standing Approvals in the app's own store and re-materialise them into the staged settings file on the next run.

The corresponding *input* field, `permission_suggestions`, would have been the natural source for the "always allow this" affordance in the approval card. Without `PermissionRequest`, the app must synthesise the suggested rule itself from `tool_name` + `tool_input` (e.g. first token of `command` + ` *`, matching what the CLI writes for "Yes, don't ask again"). [docs: [Permissions — Bash compound commands](https://code.claude.com/docs/en/permissions)]

---

## 5. Stream protocol (`stream-json`)

Launch shape used for all captures below:

```
claude -p "<prompt>" --output-format stream-json --verbose [--include-partial-messages] [--include-hook-events]
```

`--verbose` is required with `stream-json`. [docs: [Headless — Stream responses](https://code.claude.com/docs/en/headless)]

Each line is one JSON object. Every event carries `uuid` and `session_id`. Messages from subagents carry `parent_tool_use_id`; main-conversation messages carry `null`. [docs: same]

### `system` / `init`

First event in the stream unless startup events precede it. Observed keys on 2.1.220: [local]

```
agents, analytics_disabled, apiKeySource, capabilities, claude_code_version,
cwd, fast_mode_disabled_reason, fast_mode_state, mcp_servers, memory_paths,
model, output_style, permissionMode, plugins, product_feedback_disabled,
session_id, skills, slash_commands, subtype, tools, type, uuid
```

Example fragment: [local]

```json
{
  "type": "system", "subtype": "init",
  "cwd": "/Users/.../cc-probe",
  "session_id": "ac2c2d5c-22ab-46f8-ab15-74bbcc494147",
  "tools": ["Task","Bash","Edit","Read","Skill","WebFetch","Write", "..."],
  "mcp_servers": [{"name":"approver","status":"connected"}],
  "model": "claude-sonnet-5",
  "permissionMode": "acceptEdits",
  "apiKeySource": "none",
  "claude_code_version": "2.1.220",
  "skills": ["..."], "slash_commands": ["..."], "agents": ["..."]
}
```

Capture `session_id` here — it is the earliest point it is available. `permissionMode` is the app's assertion point that its staged config took effect.

`capabilities` is an array of protocol-behaviour strings (e.g. `interrupt_receipt_v1`) for feature detection instead of version comparison; present from v2.1.205, absent earlier, and unrecognised values should be ignored. [docs: [Headless — Read session metadata](https://code.claude.com/docs/en/headless)]

`plugin_errors` and `mcp_server_errors` appear only when non-empty and identify components that failed to load. [docs: same]

### `assistant` — text, thinking, tool_use

An `assistant` event wraps an Anthropic Messages API message. `message.content` is the standard content-block array, so block types are `text`, `thinking`, and `tool_use`. [local]

Thinking block: [local]

```json
{"type":"thinking","thinking":"","signature":"Ep8CCokBCBAYAipARikwx2..."}
```

Note the observed `thinking` string was empty with only a `signature` present — the app must not assume thinking text is available. Redacted/summarised thinking is expected to vary by model and settings.

Text block: [local]

```json
{"type":"text","text":"Done — demo.txt now reads \"goodbye world\"..."}
```

`tool_use` block, with a Claude Code-specific `caller` field: [local]

```json
{
  "type": "tool_use",
  "id": "toolu_01CYjurLweEeyBuvnG9X9T7z",
  "name": "Edit",
  "input": {
    "replace_all": false,
    "file_path": "/Users/.../demo.txt",
    "old_string": "hello world",
    "new_string": "goodbye world"
  },
  "caller": {"type": "direct"}
}
```

Each `assistant` event also carries `message.usage` (per-request `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_5m/1h_input_tokens`, `service_tier`), plus `request_id` and `timestamp`. [local]

### `user` — tool results, and the diff payload

Tool results arrive as a `user` event whose `message.content` holds a `tool_result` block, **plus a sibling top-level `tool_use_result` object carrying Claude Code's structured metadata.** The `tool_result` block is what the model sees; `tool_use_result` is what a UI should render. [local]

**Edit — this answers the inline-diff question directly.** Verified capture: [local]

```json
{
  "type": "user",
  "message": { "role": "user", "content": [
    { "tool_use_id": "toolu_01CYjurLweEeyBuvnG9X9T7z", "type": "tool_result",
      "content": "The file /Users/.../demo.txt has been updated successfully. (file state is current in your context — no need to Read it back)" }
  ]},
  "parent_tool_use_id": null,
  "session_id": "ac2c2d5c-...",
  "uuid": "00aa9274-...",
  "timestamp": "2026-08-01T20:13:29.805Z",
  "tool_use_result": {
    "filePath": "/Users/.../demo.txt",
    "oldString": "hello world",
    "newString": "goodbye world",
    "originalFile": "hello world\nsecond line\n",
    "structuredPatch": [
      { "oldStart": 1, "oldLines": 2, "newStart": 1, "newLines": 2,
        "lines": ["-hello world", "+goodbye world", " second line"] }
    ],
    "userModified": false,
    "replaceAll": false
  }
}
```

So the app gets **both** old/new content *and* a ready-made unified-diff hunk list. `structuredPatch[].lines` uses the conventional `-`/`+`/` ` prefixes and `oldStart`/`oldLines`/`newStart`/`newLines` are 1-based hunk headers — directly renderable.

`originalFile` gives the full pre-edit content, so the app can also compute its own diff or render side-by-side without re-reading from disk.

**Bash:** [local]

```json
"tool_use_result": {
  "stdout": "done", "stderr": "", "interrupted": false,
  "isImage": false, "noOutputExpected": false
}
```

and the `tool_result` block carries `"content": "done", "is_error": false`.

**Read:** [local]

```json
"tool_use_result": {
  "type": "text",
  "file": { "filePath": "/Users/.../demo.txt", "content": "hello world\nsecond line\n",
            "numLines": 3, "startLine": 1, "totalLines": 3 }
}
```

with the `tool_result` content line-numbered (`"1\thello world\n2\tsecond line\n3\t"`).

**Denied / errored calls** produce a `tool_result` with `is_error: true` and a human-readable message, and no `tool_use_result`: [local]

```json
{"type":"tool_result","content":"This command requires approval","is_error":true,"tool_use_id":"toolu_..."}
```

`tool_use_result` is not documented in the CLI docs; the shapes above are from direct capture on 2.1.220 and should be treated as version-sensitive. Pin an adapter contract test to the installed version.

### Other observed event types

| Event | Notes |
| --- | --- |
| `system` / `hook_started`, `hook_response` | Emitted with `--include-hook-events`, and unconditionally for `SessionStart`/`Setup` hooks ahead of `system/init`. Fields: `hook_id`, `hook_name`, `hook_event`, and on response `output`, `stdout`, `stderr`, `exit_code`, `outcome`. [local] |
| `system` / `thinking_tokens` | `estimated_tokens`, `estimated_tokens_delta`. [local] |
| `system` / `api_retry` | `attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error` (category). [docs: [Headless — Handle API retries](https://code.claude.com/docs/en/headless)] |
| `system` / `plugin_install` | Only when `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` is set. [docs: same] |
| `rate_limit_event` | `rate_limit_info: {status, resetsAt, rateLimitType, overageStatus, overageDisabledReason, isUsingOverage}`. [local] Not found in the docs — treat as unstable. |
| `stream_event` | Partial message chunks, only with `--include-partial-messages`. Text deltas appear as `.event.delta.type == "text_delta"` with `.event.delta.text`. [docs: [Headless — Stream responses](https://code.claude.com/docs/en/headless)] |
| `result` | Always last. |

### `result` — the terminal event

Verified capture (abridged): [local]

```json
{
  "type": "result", "subtype": "success", "is_error": false,
  "session_id": "ac2c2d5c-...",
  "stop_reason": "end_turn",
  "num_turns": 5,
  "duration_ms": 15222, "duration_api_ms": 15222,
  "total_cost_usd": 0.19561049999999996,
  "usage": { "input_tokens": 10, "output_tokens": 473,
             "cache_creation_input_tokens": 21613, "cache_read_input_tokens": 196025,
             "server_tool_use": {...}, "iterations": [...] },
  "modelUsage": { "claude-sonnet-5": { "inputTokens": 10, "outputTokens": 473,
                  "costUSD": 0.1956..., "contextWindow": 1000000,
                  "maxOutputTokens": 64000, "canonicalModel": "claude-sonnet-5",
                  "provider": "firstParty" } },
  "permission_denials": [ { "tool_name": "Bash", "tool_use_id": "toolu_...",
                            "tool_input": { "command": "...", "description": "..." } } ],
  "terminal_reason": "api_error",
  "result": "<final assistant text, or the error message>",
  "uuid": "bcc029a1-..."
}
```

`permission_denials` is the authoritative list of blocked calls for a run — the app should surface it rather than inferring denials from `is_error` tool results.

An auth failure produced `is_error: true`, `terminal_reason: "api_error"`, `result: "Not logged in · Please run /login"`, and process exit code 1, preceded by a synthetic `assistant` message with `"model": "<synthetic>"`, `"error": "authentication_failed"`, `"is_api_error_message": true`. [local] That synthetic-message marker is a clean signal for classifying auth/API failures.

### Cancellation

SIGTERM to `claude -p` aborts the in-progress turn, terminates the process tree of any running Bash command, runs `SessionEnd` hooks, and exits with code 143. [docs: [Headless — Background tasks at exit](https://code.claude.com/docs/en/headless)]

Background Bash tasks are killed ~5s after the final result; background subagents/workflows are waited for, capped at 10 minutes by default (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`). [docs: same]

From v2.1.214, if the consumer reads the stream slowly, Claude Code waits for queued output to drain before exiting, up to 30 seconds. [docs: same] The app must keep draining stdout after the `result` event rather than tearing down immediately.

---

## 6. Session continuity

| Flag | Behaviour |
| --- | --- |
| `-c`, `--continue` | Most recent conversation in the current directory |
| `-r`, `--resume [value]` | By session ID or name; interactive picker without a value |
| `--session-id <uuid>` | Use a caller-supplied session ID (must be a valid UUID) |
| `--fork-session` | With `--resume`/`--continue`, create a new session ID instead of reusing |
| `-n`, `--name <name>` | Display name, resumable by name |
| `--no-session-persistence` | Do not write the transcript; session cannot be resumed (`-p` only) |

[local: `claude --help`] [docs: [Sessions](https://code.claude.com/docs/en/sessions)]

For a desktop app driving concurrent sessions, **use `--session-id` with an app-generated UUID** rather than `--continue` — the latter is directory-scoped and ambiguous across parallel Ideas in one repo. The `session_id` in `system/init` should still be captured and reconciled.

Sessions created with `claude -p` do **not** appear in the interactive picker, but can be resumed by ID. Session ID lookup is scoped to the project directory and its git worktrees, so resume must run from the same directory or it fails with `No conversation found with session ID: <id>`. [docs: [Sessions — Resume a session](https://code.claude.com/docs/en/sessions)]

### What resume restores, and what it does not

Restored: conversation history including tool calls/results, model, agent, permission mode, active goal, non-expired scheduled tasks.

Not restored: `plan` and `bypassPermissions` permission modes (never carried over — must be re-passed at launch); `auto` only if the account still qualifies. [docs: same]

**Not restored: `--mcp-config`, `--settings`, `--plugin-dir`, `--fallback-model`, `--add-dir`.** These must be passed again on every resume. [docs: same] This is a hard requirement for the app: persist the entire launch argv per session, not just the ID.

### On-disk state

Transcripts: `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is the working directory path with non-alphanumeric characters replaced by `-`. Confirmed locally: `~/.claude/projects/-Users-guillermoortizrebolledo-cc-probe/<uuid>.jsonl`. [local] [docs: [Sessions — Where transcripts are stored](https://code.claude.com/docs/en/sessions)]

**Anthropic explicitly warns against parsing these files:** "The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release." [docs: same] The app should treat the transcript as opaque and rebuild its own history from the `stream-json` events it already consumes.

Retention defaults to 30 days (`cleanupPeriodDays`). [docs: same]

Other observed contents of `~/.claude/` on this machine (names and schema only): `settings.json`, `settings.local.json`, `.credentials.json` (mode 0600), `history.jsonl`, `projects/`, `sessions/`, `skills/`, `plugins/`, `tasks/`, `jobs/`, `file-history/`, `session-env/`, `shell-snapshots/`, `backups/`, `cache/`, `telemetry/`, `daemon.*`, `policy-limits.json`, `remote-settings.json`, `stats-cache.json`. [local]

The user's `~/.claude/settings.json` on this machine sets `permissions.defaultMode: "acceptEdits"`, a `model`, `effortLevel`, `enabledPlugins`, and UI preferences. [local] This is a live example of why the staged config must win: a user with `acceptEdits` as their default would otherwise silently get edit auto-approval in the app's "Ask" mode. `--settings` with an explicit `permissions.defaultMode` overrides it — verified. [local]

---

## 7. Skills

### Discovery

Skills load from `~/.claude/skills/`, project `.claude/skills/`, plugins, and — with live reload — from directories passed with `--add-dir`. [docs: [Permissions — Additional directories grant file access, not configuration](https://code.claude.com/docs/en/permissions)]

Each skill is a directory containing `SKILL.md` with YAML frontmatter (`name`, `description`, optional `disable-model-invocation`, optional `hooks`). Skills can declare hooks in frontmatter, scoped to while the component is active, and those hooks honour `once: true`. [docs: [Hooks reference — Hook locations](https://code.claude.com/docs/en/hooks)]

### Invocation

Skills are invoked as `/skill-name`. User-invoked skills and custom commands work in `-p` mode: include `/skill-name` in the prompt string and Claude Code expands it before running. [docs: [Headless — Auto-approve tools note](https://code.claude.com/docs/en/headless)]

Because `--input-format stream-json` allows sending multiple user messages over stdin, a skill can be invoked mid-conversation by sending `/skill-name ...` as a later user message. [docs: [Headless](https://code.claude.com/docs/en/headless)] [unverified — not reproduced locally]

`--disable-slash-commands` disables all skills for a run. [local: `--help`]

### Can a staged directory add skills for one run?

**Yes, via `--add-dir` — but not while `--setting-sources` is empty.**

Verified: a staged directory `~/cc-probe/staged/.claude/skills/probe-skill/SKILL.md` passed as `--add-dir ~/cc-probe/staged` appeared in `system/init.skills` as `probe-skill` (127 skills total). The same run with `--setting-sources ''` added showed `skills: []` for the probe and 16 skills total. [local]

This is a real tension: the app wants `--setting-sources ''` for isolation but `--add-dir` for staged skills. See [Blockers](#blockers-for-the-described-design).

`--plugin-dir <path>` and `--plugin-url <url>` load a plugin for the session only, and are repeatable — an alternative packaging route for app-supplied skills. [local: `--help`] [unverified — not reproduced locally]

---

## 8. MCP

`--mcp-config <configs...>` — "Load MCP servers from JSON files or strings (space-separated)." `--strict-mcp-config` — "Only use MCP servers from `--mcp-config`, ignoring all other MCP configurations." [local: `--help`]

**Verified:** an inline JSON string works, using the standard `mcpServers` object:

```
claude -p "..." --strict-mcp-config \
  --mcp-config '{"mcpServers":{"probe":{"command":"node","args":["/path/server.mjs"]}}}'
```

`system/init.mcp_servers` reported `[{"name":"probe","status":"pending"}]` immediately at init, and `[{"name":"approver","status":"connected"}]` once the handshake completed in the prompt-tool run. [local]

For the app's `offer_response_options` server, use `--mcp-config` with an inline JSON string (no temp file needed) plus `--strict-mcp-config` so the user's own MCP servers do not leak into the run. Combine it with `--permission-prompt-tool mcp__<server>__<tool>` if the same server also handles approvals — Claude Code will wait up to `MCP_TIMEOUT` (30s) for it to connect before the first turn. [docs: [CLI reference](https://code.claude.com/docs/en/cli-reference)]

Failure handling: each `--mcp-config` entry is validated at startup and invalid entries are **skipped, with the run continuing and exiting cleanly**. Check `system/init.mcp_server_errors` (each with `name`, `type`, `message`; `type` ∈ `unknown_type`, `url_missing_type`, `invalid_config`, `reserved_name`, or unrecognised) to detect a server that never loaded. The key is omitted when empty. Requires v2.1.219+. [docs: [Headless — Fail CI when a plugin or MCP server doesn't load](https://code.claude.com/docs/en/headless)]

MCP permission rules use `mcp__<server>` (whole server), `mcp__<server>__*`, or `mcp__<server>__<tool>`. Allow rules accept a glob only after a literal `mcp__<server>__` prefix; unanchored allow globs like `"mcp__*"` are skipped with a warning. Deny/ask rules accept `mcp__*`. [docs: [Permissions — MCP](https://code.claude.com/docs/en/permissions)]

`--mcp-config` is **not** restored on resume and must be re-passed. [docs: [Sessions](https://code.claude.com/docs/en/sessions)]

---

## 9. Working directory and `--add-dir`

The primary working directory is the process's cwd — set it when spawning the child process. There is no `--cwd` flag on the top-level `claude` command (only on `claude agents --cwd` for filtering). [local: `--help`]

`--add-dir <directories...>` — "Additional directories to allow tool access to." Each path is validated to exist as a directory. [local: `--help`] [docs: [CLI reference](https://code.claude.com/docs/en/cli-reference)]

Semantics:

- Files in additional directories become readable without prompts, and editing follows the current permission mode — the same as the primary working directory. [docs: [Permissions — Working directories](https://code.claude.com/docs/en/permissions)]
- `acceptEdits` auto-approval extends to `additionalDirectories`; paths outside that scope still prompt. [docs: [Permission modes — acceptEdits](https://code.claude.com/docs/en/permission-modes)]
- **Configuration is mostly not loaded** from added directories. Exceptions, and only for `--add-dir`/`/add-dir` (not for `permissions.additionalDirectories` in settings): `.claude/skills/` (with live reload), `.claude/agents/`, and the `enabledPlugins` + `extraKnownMarketplaces` settings keys. `CLAUDE.md` and `.claude/rules/` load only when `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`. [docs: [Permissions — Additional directories grant file access, not configuration](https://code.claude.com/docs/en/permissions)]
- The persistent equivalent is `permissions.additionalDirectories` in settings — settable from the staged `--settings` file, but note it does **not** carry the skills/agents loading behaviour.
- `--add-dir` is not restored on resume. [docs: [Sessions](https://code.claude.com/docs/en/sessions)]

A local observation worth designing around: writes were refused with `touch in '<path>' was blocked. For security, Claude Code may only create or modify files in the allowed working directories for this session: '<the same path>'` — i.e. the path *was* inside the listed working directory. Reproduced in `~/cc-probe` and under `$TMPDIR`, in `--permission-mode default` with `--setting-sources ''`. [local] The cause was not isolated; see [Open questions](#open-questions--could-not-verify). The app should treat working-directory rejections as a distinct, reportable failure class rather than assuming a permission prompt is pending.

---

## Blockers for the described design

### 1. `PermissionRequest` hooks do not fire in `-p` mode (2.1.220)

The docs state: "Runs when Claude Code is about to ask you for permission. **In sessions that can't show a prompt, such as background subagents in non-interactive mode, Claude Code still runs these hooks**, and if no hook returns a decision, it denies the tool call." [docs: [Hooks reference — PermissionRequest](https://code.claude.com/docs/en/hooks)]

**Observed behaviour contradicts this.** With a `PermissionRequest` hook registered via `--settings` (matcher `"*"`, a `command` handler that logs stdin and returns `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`), running `claude -p "Run this exact bash command and nothing else: python3 -c 'print(7)'" --permission-mode default --setting-sources '' --include-hook-events`:

- the hook's log file was never created — the handler did not execute;
- no `hook_started`/`hook_response` events for `PermissionRequest` appeared in the stream;
- the tool result was `"This command requires approval", is_error: true`;
- the call appeared in `result.permission_denials`.

The same staged-settings mechanism demonstrably works for `SessionStart` and `PreToolUse` in the identical setup, so this is not a config-loading failure. [local]

**Impact.** The `permission_suggestions` input field and the `updatedPermissions` output field — the natural way to implement "always allow this" from an approval card — are unreachable in `-p` mode.

**Workaround.** Use `--permission-prompt-tool` for Ask (verified) and `permissions.allow` rules in the staged settings file for Standing Approvals (verified). Synthesise the "always allow" rule string in the app rather than reading it from `permission_suggestions`.

**Not a blocker for the design as a whole** — both replacement mechanisms are verified working — but it invalidates any plan that routes approvals through `PermissionRequest`.

### 2. `--setting-sources ''` disables `--add-dir` skill discovery

`--add-dir <staged>` surfaced `probe-skill` in `system/init.skills` (127 skills) on its own, but with `--setting-sources ''` added, the probe skill was absent and the total dropped to 16. [local] This is not documented.

**Impact.** The app cannot simultaneously (a) fully isolate the run from the user's own settings/skills/plugins and (b) inject its own skills via a staged directory.

**Options.** Pick one:
- Accept `--setting-sources user,project,local` (or a subset) and rely on `--settings` precedence for permissions, accepting that the user's skills, plugins, and hooks also load. Note that arrays merge, so the user's `permissions.allow` entries will be added to the app's.
- Use `--plugin-dir` to ship app skills as a session-only plugin, which may be independent of `--setting-sources`. [unverified]
- Drop staged skills and invoke the user's already-installed skills by name.

### 3. Managed settings can override everything, including CLI arguments

Managed settings outrank command-line arguments and cannot be overridden. `allowManagedPermissionRulesOnly: true` prevents any non-managed source — including `--settings` — from defining `allow`/`ask`/`deny` rules; `disableBypassPermissionsMode: "disable"` rejects `--permission-mode bypassPermissions` at startup; `disableAutoMode: "disable"` does the same for `auto`. [docs: [Permissions — Managed settings](https://code.claude.com/docs/en/permissions), [Settings — Settings precedence](https://code.claude.com/docs/en/settings)]

**Impact.** On a managed (corporate MDM / Claude for Enterprise) machine, Full access may be unavailable and Standing Approvals may be silently ignored.

**Mitigation.** After spawn, assert `system/init.permissionMode` equals the requested mode and surface a clear "your organization's policy overrides this setting" state rather than silently running in a different mode.

### 4. `--settings` is not restored on resume

`--settings`, `--mcp-config`, `--plugin-dir`, and `--add-dir` must all be re-passed on `--resume`. [docs: [Sessions](https://code.claude.com/docs/en/sessions)] If the app resumes with only the session ID, the run silently loses its staged permissions, its MCP server, and its approval bridge — and `bypassPermissions` is additionally never restored. Persist and replay the full argv.

### 5. Invalid staged settings fail silently in `-p`

"Settings files that fail validation are silently ignored in this mode (no error dialog is shown)." [local: `--help`] A malformed staged file produces a run with the user's own settings in effect and no warning. Validate before writing, and assert against `system/init`.

---

## Recommended launch shape

```
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --session-id <app-generated-uuid> \
  --model <selected-model> \
  --effort <selected-effort> \
  --permission-mode <default | bypassPermissions> \
  --settings <staged-config-dir>/settings.json \
  --strict-mcp-config \
  --mcp-config '{"mcpServers":{"agentsideas":{...}}}' \
  [--permission-prompt-tool mcp__agentsideas__request_approval]   # Ask mode only
  [--add-dir <staged-config-dir>]                                  # if staged skills are needed
```

with cwd set to the repository root, and the staged `settings.json` containing:

```json
{
  "permissions": {
    "defaultMode": "default",
    "allow": [
      "Bash(pnpm test:*)",
      "Edit(//Users/me/dev/my-repo/**)"
    ]
  }
}
```

The staged directory lives in the app's own storage. `~/.claude/` is never written.

---

## Verified: allow-rule vs permission-prompt-tool interaction

Verification date: **2026-08-01**. Harness: `claude --version` → **`2.1.220 (Claude Code)`** at `/Users/guillermoortizrebolledo/.local/bin/claude`.

**Answer: (a).** A `permissions.allow` rule delivered via `--settings` **short-circuits `--permission-prompt-tool`**. An allowed tool call never reaches the prompt tool. The rule is consulted and wins.

This resolves the open question "Whether `permissions.allow` rules short-circuit `--permission-prompt-tool`" — the Standing Approvals design holds as specified.

### Method

A dependency-free stdio MCP server (`mcpsrv.mjs`) exposing one tool `approve`, which appends the full `tools/call` params to a log file and unconditionally returns text content `{"behavior":"allow","updatedInput":<the input it received>}`. The log file is the instrument: a line means the prompt tool was consulted, no line means it was bypassed.

Every run used the identical launch shape, varying only the staged settings file and the prompt. cwd was a scratch directory outside any repo.

```
cd "$BASE/work"
claude -p "$PROMPT" \
  --output-format stream-json --verbose \
  --permission-mode default \
  --setting-sources '' \
  --settings "$SETTINGS" \
  --strict-mcp-config \
  --mcp-config '{"mcpServers":{"approver":{"command":"node","args":["'"$BASE"'/mcpsrv.mjs"],"env":{"APPROVE_LOG":"'"$APPROVE_LOG"'"}}}}' \
  --permission-prompt-tool mcp__approver__approve
```

All runs reported `system/init` with `"permissionMode": "default"` and `"mcp_servers": [{"name":"approver","status":"connected"}]`, so the staged layer and the approval bridge were both live in every case.

### Result 1 — Bash pair

Prompt (both runs): `Run this exact bash command and nothing else: python3 -c 'print(99)'`

| Run | Staged `permissions.allow` | `approve` invocations | Outcome |
| --- | --- | --- | --- |
| **allow** | `["Bash(python3:*)"]` | **0** | `tool_result` `99`, `is_error: false`, `permission_denials: []` |
| **control** | `[]` | **1** | same outcome (the stub allowed it) |

Control invocation, captured verbatim:

```json
{"at":"2026-08-01T20:30:34.275Z","params":{"name":"approve","arguments":{
  "tool_name":"Bash",
  "input":{"command":"python3 -c 'print(99)'","description":"Print 99 with python3"},
  "tool_use_id":"toolu_01Wyx5CbqrV7BcYVcRkxBRiV"},
  "_meta":{"claudecode/toolUseId":"toolu_01Wyx5CbqrV7BcYVcRkxBRiV","progressToken":2}}}
```

The `tool_use` block emitted was byte-identical across the pair (`{"name":"Bash","input":{"command":"python3 -c 'print(99)'"...}}`), so the difference is not model variance in the command chosen.

### Result 2 — Edit pair

Prompt (both runs): `Edit the file demo.txt in the current directory: change the text 'hello world' to 'goodbye world'. Do nothing else.` File reset to `hello world\nsecond line\n` before each run.

| Run | Staged `permissions.allow` | `approve` invocations | Outcome |
| --- | --- | --- | --- |
| **allow** | `["Edit(//private/var/.../permexp/work/**)", "Edit(//var/.../permexp/work/**)"]` | **0** | file written, `permission_denials: []` |
| **control** | `[]` | **1** (`tool_name: "Edit"`) | file written |

Both runs issued `Read` then `Edit` on the same absolute path. `Read` never reached the prompt tool in either run — reads are auto-approved in `default` mode, as documented.

So the `Edit(//abs/path/**)` form **is** consulted on this path, same as Bash rules. The Write/Glob caveat in §2 is about which *rule tool name* is consulted, not about the prompt-tool interaction.

### Result 3 — the rule is scoped, not a global switch (bonus control)

The two pairs above leave one alternative explanation open: that the mere presence of a non-empty `allow` array disables the prompt tool wholesale. It does not.

Single run, staged `allow: ["Bash(python3:*)"]`, prompt: `Run exactly these two bash commands, as two separate Bash tool calls, and nothing else: first python3 -c 'print(99)' then perl -e 'print 7'`

Exactly **one** `approve` invocation, and it was for `perl`:

```json
{"at":"2026-08-01T20:31:29.213Z","params":{"name":"approve","arguments":{
  "tool_name":"Bash",
  "input":{"command":"perl -e 'print 7'","description":"Print 7 with perl"},
  "tool_use_id":"toolu_01PqBd5RRCQfoEXDjKxNvzSA"}, ...}}
```

The matching `python3` call in the same session was silently auto-approved; the non-matching `perl` call was routed. Per-call rule evaluation, confirmed.

### Incidental finding — `echo` is auto-approved without any rule

The first attempt used `echo hello-from-test` as the subject command. **Both** the allow run and the control run produced zero `approve` invocations and ran the command successfully. `echo` is in Claude Code's built-in auto-approved command set in `default` mode, so it cannot be used as a probe for permission behaviour. The test was redone with `python3`, which does prompt.

This is a trap for anyone writing permission tests: a null result may mean "the rule worked" or "the command never needed approval". **Always run the control.**

### Incidental finding — `system/init` does not list permission rules

Observed `system/init` keys on 2.1.220 (with `--setting-sources ''`):

```
agents, analytics_disabled, apiKeySource, capabilities, claude_code_version, cwd,
fast_mode_disabled_reason, fast_mode_state, mcp_servers, memory_paths, model,
output_style, permissionMode, plugins, product_feedback_disabled, session_id,
skills, slash_commands, subtype, tools, type, uuid
```

The only permission-related key is `permissionMode` (value `"default"`). There is **no** field listing the effective `allow`/`deny`/`ask` rules. `capabilities` was `["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"]`.

**Impact.** The app cannot read back its own Standing Approvals from the stream to confirm they loaded. Combined with §"Invalid staged settings fail silently in `-p`", the only assertion available at startup is `permissionMode`. A staged file with a valid `defaultMode` but a malformed `allow` entry could plausibly pass that assertion while dropping the rules. Validate the generated JSON in-process before spawning.

### Implications for Standing Approvals

1. **The declarative design (a) in §"Can hooks implement Standing Approvals?" is confirmed working in Ask mode.** Materialise each Standing Approval as a `permissions.allow` entry in the staged `--settings` file. Approved calls are auto-approved and never surface an approval card.
2. **The MCP prompt tool does not need to consult the Standing Approvals store.** It only ever sees calls the rules did not match. Keeping the store out of the prompt-tool hot path avoids a second, divergent implementation of Claude Code's Bash-matching and gitignore-path semantics — which §2 shows is subtle enough (word boundaries, compound splitting, wrapper stripping, four path anchors) that reimplementing it would be a bug farm.
3. **Consequence: the app never observes a "standing-approved" tool call at the permission layer.** If the UI wants to show "auto-approved by your standing approval for `pnpm test:*`", it must derive that from the `tool_use` stream event by matching against its own rule store — a display-only concern, and being wrong there is cosmetic rather than a security hole.
4. **Corollary risk.** Because rules short-circuit before the prompt tool, a too-broad Standing Approval is unrecoverable at runtime — there is no interception point left. Rule breadth must be constrained at the point the user creates the approval, not at execution. Synthesise narrow rules (`Bash(pnpm test:*)`, not `Bash(pnpm *)`) and show the user the literal rule string being stored.

### Artifacts

Run under `$TMPDIR/opencode/permexp/` (`mcpsrv.mjs`, `run.sh`, `cfg/*.json`, `work/demo.txt`, `logs/*.stream.jsonl`, `logs/*.approve.log`) and deleted after capture. `~/.claude/` was not read or modified; `--setting-sources ''` isolated every run from user, project, and local settings.

---

---

## Verified: mid-session rules, symlinks, and protected paths

Verification date: **2026-08-02**. Harness: `claude --version` → **`2.1.220 (Claude Code)`**. Same instrument as the section above: a stdio MCP server exposing `approve` that logs every `tools/call` and answers from an env var. A logged line means the prompt tool was consulted; no line means the rules bypassed it.

### 1. `updatedPermissions` on the prompt tool's answer — works

The permission prompt tool's allow result accepts `updatedPermissions`, the same field the Agent SDK's `canUseTool` takes, and the rule applies to the **running** session.

Prompt (both runs): `Run exactly these two bash commands, as two separate Bash tool calls, and nothing else: first python3 -c 'print(11)' then python3 -c 'print(22)'`

| Run | `approve` answers with | invocations | Meaning |
| --- | --- | --- | --- |
| **control** | `{"behavior":"allow","updatedInput":…}` every time | **2** | each Bash call is asked |
| **treatment** | first answer adds `updatedPermissions:[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"python3:*"}],"behavior":"allow","destination":"session"}]` | **1** | the second call was auto-approved by the rule just added |

`permission_denials` was `[]` and both commands ran in both runs.

This is how a "always allow" granted mid-Run takes effect in the Run that granted it, without the app matching anything itself. `destination: "session"` is in-memory and discarded at session end, which is the only destination acceptable here — the others write into the user's repo or home config.

T3 Code uses the same field for its "accept for session" decision, via the Agent SDK rather than the prompt tool ([`ClaudeAdapter.ts`](https://github.com/pingdotgg/t3code/blob/e60821f0e0d82a5d671ca3b94719c49d333921c8/apps/server/src/provider/Layers/ClaudeAdapter.ts), `canUseTool`): it returns `updatedPermissions: [...pendingApproval.suggestions]` on `acceptForSession`, taking the suggestions the SDK hands it. The SDK gives its callback `suggestions`; the MCP prompt tool's request carries no equivalent, which is why this app synthesises rules itself.

### 2. A path rule must name the **resolved** path

Setup: `$B/real/work/demo.txt`, `$B/link -> $B/real`, cwd `$B/link/work`, prompt to edit `demo.txt`. `$B` outside any symlinked parent.

| Run | staged `permissions.allow` | invocations | Meaning |
| --- | --- | --- | --- |
| **link form** | `Edit(//$B/link/work/**)` | **1** | not consulted — no match |
| **real form** | `Edit(//$B/real/work/**)` | **0** | matched |

In the link-form run the request the prompt tool received carried `"file_path": "$B/real/work/demo.txt"` — the Harness had already resolved the symlink. So a rule written from the path the user sees goes on asking; write it from `realpath`.

This also settles what the earlier Edit pair could not: it staged both `/private/var/...` and `/var/...` forms and could not tell which was doing the work. It was the resolved one.

### 3. Allow rules never cover protected paths

Both symlink conditions first ran under `~/.claude/jobs/…` and **both prompted**, including an exact-path `Edit(//…/**)` match. `.claude` is a protected path, and protected paths are not covered by allow rules in any mode except `bypassPermissions` — the documented behaviour, observed. A Project inside one keeps prompting whatever is stored, and no rule the app writes can change that.

**Trap for anyone repeating this:** run the experiment outside `~/.claude`, `.git`, and dotfile directories, or a real match will read as a failure to match.

## Open questions / could not verify

- **Why `touch <path-inside-cwd>` was refused** with `may only create or modify files in the allowed working directories for this session` naming that same directory. Reproduced in two directories and both with and without `--setting-sources ''`. Not isolated to `--settings`, `--setting-sources`, or `$TMPDIR`. Could be `touch`-specific handling, a symlink-resolution issue, or an interaction with `default` mode. Needs a controlled reproduction before the app treats working-directory errors as retryable.
- **Whether `--plugin-dir` is affected by `--setting-sources ''`.** If it is not, it is the clean answer to Blocker 2. Not tested.
- **Whether `--permission-prompt-tool` and a `PreToolUse` hook can be combined**, and their relative order. The docs describe hook decisions and rule evaluation but do not state where the prompt tool sits. Not tested.
- **The `"defer"` / `stop_reason: "tool_deferred"` resume flow.** Documented but not reproduced. If it works, it is a cleaner alternative to a blocking IPC bridge for `AskUserQuestion`.
- **`--include-partial-messages` `stream_event` shapes.** Only the `text_delta` selector is documented; the full set of partial event types on 2.1.220 was not captured. Needs a dedicated capture before the app renders streaming thinking or streaming tool input.
- **Whether `thinking` block text is ever populated** in `-p` mode, or whether only `signature` is emitted. The single local capture had `"thinking": ""`. Behaviour may depend on model, `alwaysThinkingEnabled`, and `--effort`.
- **The `rate_limit_event` shape.** Observed locally, not found in any documentation page read. Treat as unstable and do not build UI that requires it.
- **The `tool_use_result` shape for tools other than Bash, Read, and Edit** — in particular `Write`, `NotebookEdit`, `Task`/`Agent`, `WebFetch`, and MCP tools. Only three were captured. `Write` in particular is worth capturing, since the app needs a diff for file creation too and there is no `originalFile` to diff against.
- **A programmatic way to detect that managed settings are in force.** `claude doctor` and `/status` report setting sources to a human, but no machine-readable equivalent was found, and `system/init` does not appear to expose it. Without this, Blocker 3 can only be detected indirectly by comparing the requested mode against `system/init.permissionMode`.
- **Whether `--permission-prompt-tool` is intentionally hidden from `--help`.** It is documented in the CLI reference and functional, but its absence from `--help` on 2.1.220 raises a stability question for a product that depends on it.

## Primary sources

- Installed binary: `claude --version` → `2.1.220 (Claude Code)`; `claude --help`; direct `stream-json` captures in `~/cc-probe/` and `$TMPDIR/opencode/cc-probe/`
- Local config inspected (names/schema only): `~/.claude/`, `~/.claude/settings.json`, `~/.claude/settings.local.json`, `~/.claude/projects/`
- [Anthropic: Choose a permission mode](https://code.claude.com/docs/en/permission-modes)
- [Anthropic: Configure permissions](https://code.claude.com/docs/en/permissions)
- [Anthropic: Claude Code settings](https://code.claude.com/docs/en/settings)
- [Anthropic: Environment variables](https://code.claude.com/docs/en/env-vars)
- [Anthropic: Hooks reference](https://code.claude.com/docs/en/hooks)
- [Anthropic: Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Anthropic: CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Anthropic: Manage sessions](https://code.claude.com/docs/en/sessions)
- [Anthropic: Authentication](https://code.claude.com/docs/en/iam)
- [Anthropic: Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)
