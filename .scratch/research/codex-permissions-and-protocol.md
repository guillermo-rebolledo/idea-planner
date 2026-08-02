# Codex CLI permissions, per-run config injection, and stream protocol

Research date: 2026-08-01

Harness under test: `codex-cli 0.146.0` at `/opt/homebrew/bin/codex` (verified locally with `which codex` and `codex --version`).

## Question

For a macOS Electron app that drives the locally-installed Codex CLI as a child process: how do Codex's approval and sandbox policies map onto a two-mode ("Ask" / "Full access") permission UI; how can per-run settings and per-Repository Standing Approvals be injected without mutating the user's own `~/.codex` config; does Codex have a native standing-approval concept; and what is the exact protocol for surfacing and answering approval requests, streaming items, and resuming sessions?

## Executive conclusion

1. **Use `codex app-server`, not `codex exec`.** This is not a preference — it is forced. `codex exec` **auto-rejects** every approval request instead of surfacing it, and `codex exec` has no `--ask-for-approval` flag at all. An "Ask" mode is impossible on `codex exec`. Verified empirically below.
2. **Recommended mapping** (wire values as accepted by the installed 0.146.0 binary, which are kebab-case, *not* the camelCase shown in the docs):
   - **Ask** → `approvalPolicy: "untrusted"` + `sandbox: "workspace-write"`
   - **Full access** → `approvalPolicy: "never"` + `sandbox: "danger-full-access"`
3. **Per-run config injection has three independent, non-mutating mechanisms**, in increasing order of preference for this app:
   - `-c key=value` CLI overrides (highest config precedence, no files touched)
   - a **staged `CODEX_HOME`** directory (env var; isolates config, `AGENTS.md`, rules, sessions, MCP registrations)
   - `thread/start.config` — an **arbitrary config object passed over the app-server protocol**, plus `developerInstructions` / `baseInstructions` for per-run methodology injection. No filesystem staging needed at all.
4. **Codex *does* have a native standing-approval concept**, contrary to what the brief anticipated. Two of them: session-scoped `acceptForSession`, and persistent **execpolicy `.rules` files** (`prefix_rule(pattern=[...], decision="allow")`) which the approval protocol can amend in-band via `acceptWithExecpolicyAmendment`. This is a materially better fit for Standing Approvals than app-side interception.
5. **Nothing blocks the design**, provided the app targets app-server. The only real constraints are: a staged `CODEX_HOME` needs `auth.json` made reachable; there is no "blanket file-edit approval" primitive that is documented as reliable (`grantRoot` is marked `[UNSTABLE]`); and the published docs disagree with the shipped binary on enum casing, so bindings must be generated from the installed binary.

## Local verification: what is installed

```
$ which codex
/opt/homebrew/bin/codex
$ codex --version
codex-cli 0.146.0
```

`~/.codex/` contains (names only, no contents inspected): `config.toml`, `auth.json`, `hooks.json`, `history.jsonl`, `session_index.jsonl`, `installation_id`, `version.json`, `models_cache.json`, `chrome-native-hosts-v2.json`, `.codex-global-state.json`, several `*.sqlite` state/log databases (`logs_2.sqlite`, `state_5.sqlite`, `memories_1.sqlite`, `goals_1.sqlite`), and directories `sessions/`, `archived_sessions/`, `rules/`, `skills/`, `plugins/`, `worktrees/`, `shell_snapshots/`, `cache/`, `ipc/`, `attachments/`, `memories/`, `vendor_imports/`. No secrets or credentials were read or printed.

## 1. Approval and sandbox model

Codex separates two orthogonal layers: **sandbox mode** ("what Codex can do technically") and **approval policy** ("when Codex must stop and ask"). [Source: [Agent approvals & security](https://developers.openai.com/codex/agent-approvals-security)]

### `--ask-for-approval` values (installed 0.146.0)

From real `codex --help` output on this machine:

```
  -a, --ask-for-approval <APPROVAL_POLICY>
          Possible values:
          - untrusted:  Only run "trusted" commands (e.g. ls, cat, sed) without asking for user
            approval. Will escalate to the user if the model proposes a command that is not in the
            "trusted" set
          - on-request: The model decides when to ask the user for approval
          - never:      Never ask for user approval Execution failures are immediately returned to
            the model
```

**`on-failure` no longer exists.** The configuration reference confirms it was removed: "`on-failure` is deprecated; use `on-request` for interactive runs or `never` for non-interactive runs." [Source: [Config Reference](https://developers.openai.com/codex/config-file/config-reference), `approval_policy` key]

There is a fourth, non-scalar form — a **granular** policy that keeps some prompt categories interactive while auto-rejecting others:

```
approval_policy = { granular = { sandbox_approval = bool, rules = bool,
                                 mcp_elicitations = bool, request_permissions = bool,
                                 skill_approval = bool } }
```

`sandbox_approval`, `rules`, and `mcp_elicitations` are required; `request_permissions` and `skill_approval` default to `false`. [Source: locally generated `AskForApproval` schema, see §5]

### `--sandbox` values

`read-only`, `workspace-write`, `danger-full-access` (from real `--help`).

### Combination table

Reproduced from the official docs. [Source: [Agent approvals & security → Common sandbox and approval combinations](https://developers.openai.com/codex/agent-approvals-security)]

| Intent | Flags | Effect |
| --- | --- | --- |
| Auto (preset) | *no flags* or `--sandbox workspace-write --ask-for-approval on-request` | Read, edit, and run commands in the workspace. Approval required to edit outside the workspace or use the network. |
| Safe read-only browsing | `--sandbox read-only --ask-for-approval on-request` | Read and answer only; approval required to edit, run, or use network. |
| Read-only non-interactive (CI) | `--sandbox read-only --ask-for-approval never` | Read only; never asks. |
| Auto-edit, ask before untrusted commands | `--sandbox workspace-write --ask-for-approval untrusted` | Read and edit files; asks before running untrusted commands. |
| Auto-review | `--sandbox workspace-write --ask-for-approval on-request -c approvals_reviewer=auto_review` | Same boundary, but approvals routed to a reviewer subagent instead of the user. |
| Dangerous full access | `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`) | No sandbox, no approvals. |

### Presets and hidden flags — verified locally

- `--yolo` is **accepted on the root command** but is not listed in `--help`. It is documented as an alias of `--dangerously-bypass-approvals-and-sandbox`. Verified: `codex --yolo --help` exits 0 while `codex --bogus-flag-xyz --help` exits 2.
- `--yolo` is **not** accepted on `codex exec` (exits 2).
- `--full-auto` is **accepted on `codex exec`** but **rejected on the root command** (exits 2). It is a deprecated compatibility path that prints a warning: "Codex keeps `codex exec --full-auto` as a deprecated compatibility flag and prints a warning. Prefer the explicit `--sandbox workspace-write` flag in new scripts." [Source: [Non-interactive mode](https://developers.openai.com/codex/non-interactive-mode)]
- `Auto` is the name of the UI preset for `workspace-write` + `on-request`, not a flag.

**Do not use `--full-auto` or `--yolo` in the app.** Both are aliases whose meaning has already shifted once; set `sandbox` and `approvalPolicy` explicitly.

### Recommended mapping for the two-mode UI

| App mode | approvalPolicy | sandbox | Rationale |
| --- | --- | --- | --- |
| **Ask** | `untrusted` | `workspace-write` | `untrusted` is the only value that guarantees escalation is driven by a *policy*, not by model discretion. Under `on-request` the model decides when to ask, so a user who selected "Ask" can silently get no prompts. `workspace-write` keeps the blast radius at the repo while still letting the agent work. |
| **Full access** | `never` | `danger-full-access` | The documented "read files, make edits, and run commands with network access without approval prompts" combination. |

Two caveats on **Ask**:

- `untrusted` + `workspace-write` still lets file edits inside the workspace proceed **without** a prompt in some configurations — the docs describe this row as "Codex can read and edit files but asks for approval before running untrusted commands." If the product requires a prompt on *every* file write, that must be verified per version rather than assumed. In the live probe below, `untrusted` + `read-only` *did* raise `item/fileChange/requestApproval` for a file write, because the write was a sandbox escalation.
- Prefer `never` over `--dangerously-bypass-approvals-and-sandbox` for Full access if you want Codex to still apply its own guardrails; use `danger-full-access` as the sandbox value rather than the bypass flag, because the bypass flag also disables hook trust and other checks.

## 2. `workspace-write` semantics

**Writable roots.** By default the workspace is the current working directory plus temporary directories: "The workspace includes the current directory and temporary directories like `/tmp`." [Source: [Agent approvals & security → Defaults and recommendations](https://developers.openai.com/codex/agent-approvals-security)] The existence of `sandbox_workspace_write.exclude_tmpdir_env_var` and `sandbox_workspace_write.exclude_slash_tmp` confirms `$TMPDIR` and `/tmp` are writable by default and must be opted *out* of.

**Protected paths inside writable roots** (read-only even though the root is writable), recursive:

- `<writable_root>/.git` — whether a directory or a `gitdir:` pointer file (the resolved Git dir is also protected)
- `<writable_root>/.agents`
- `<writable_root>/.codex`

[Source: [Agent approvals & security → Protected paths in writable roots](https://developers.openai.com/codex/agent-approvals-security)]

This matters for this app: **a staged config directory placed at `<repo>/.codex` would be read-only to the agent**, which is fine for injection but means the agent cannot write there.

**Network.** Off by default in `workspace-write`. Enabled with:

```toml
[sandbox_workspace_write]
network_access = true
```

**Configurable knobs** [Source: [Config Reference](https://developers.openai.com/codex/config-file/config-reference)]:

| Key | Type | Meaning |
| --- | --- | --- |
| `sandbox_workspace_write.writable_roots` | `array<string>` | Additional writable roots |
| `sandbox_workspace_write.network_access` | `boolean` | Outbound network inside the sandbox |
| `sandbox_workspace_write.exclude_tmpdir_env_var` | `boolean` | Drop `$TMPDIR` from writable roots |
| `sandbox_workspace_write.exclude_slash_tmp` | `boolean` | Drop `/tmp` from writable roots |

The equivalent app-server wire shape (`SandboxPolicy` / `workspaceWrite`) exposes `writableRoots`, `networkAccess`, `excludeSlashTmp`, `excludeTmpdirEnvVar`, plus `readOnlyAccess` for restricted read roots. The CLI also has `--add-dir <DIR>` ("Additional directories that should be writable alongside the primary workspace").

**Does it write in place?** **Yes.** Verified: in a scratch git repo, `codex exec --sandbox workspace-write` edited `greeting.txt` directly in the working tree; `git diff --stat` afterwards showed `greeting.txt | 2 +-`. There is no shadow/overlay copy. The app must own the git-safety story (branch/worktree) itself.

On macOS, enforcement is Seatbelt via `sandbox-exec -p`. [Source: [Agent approvals & security → OS-level sandbox](https://developers.openai.com/codex/agent-approvals-security)]

## 3. Config: locations, precedence, and per-run injection

### Locations

`CODEX_HOME` (default `~/.codex`) is "the root for Codex state, including config, auth, logs, sessions, skills, and standalone package metadata. **If you set it, the directory must already exist.**" [Source: [Environment Variables](https://developers.openai.com/codex/config-file/environment-variables)]

### Precedence (highest first)

1. CLI flags and `-c`/`--config` overrides
2. Project config `.codex/config.toml`, root → cwd, closest wins — **trusted projects only**
3. Profile file selected with `--profile <name>` → `$CODEX_HOME/<name>.config.toml`
4. User config `$CODEX_HOME/config.toml`
5. System config `/etc/codex/config.toml`
6. Built-in defaults

[Source: [Config basics → Configuration precedence](https://developers.openai.com/codex/config-file/config-basic)]

### The four per-run injection mechanisms — all verified

**(a) `-c key=value` — dotted-path TOML overrides.** Present on *every* subcommand (verified in `--help` for `exec`, `resume`, `mcp`, `mcp-server`, `app-server`, `sandbox`, `debug`, `apply`, `execpolicy`). Value parsed as TOML, falling back to a literal string. Highest precedence. Touches nothing on disk.

Verified: `codex exec -c approval_policy=never -c model_reasoning_effort=low ...` ran successfully.

**(b) `CODEX_HOME` — staged config directory.** Verified end-to-end. A staged home containing only `config.toml`, `AGENTS.md`, and a symlink to the user's `auth.json` produced a working run that loaded the staged instructions:

```
$ CODEX_HOME=<staged> codex exec --json --skip-git-repo-check --ephemeral \
    "Reply with the marker described in your instructions, nothing else."
{"type":"thread.started","thread_id":"019fbef7-8b60-75e3-8401-5c220bd7582c"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"STAGED-HOME-OK"}}
{"type":"turn.completed","usage":{...}}
```

`STAGED-HOME-OK` was defined only in the staged `AGENTS.md`, proving the staged home fully replaced `~/.codex` for config *and* global instructions.

App-server also honours it — the `initialize` result echoes the active home:

```json
{"id":1,"result":{"userAgent":"probe/0.146.0 (Mac OS 26.3.0; arm64) ...","codexHome":"/private/var/.../staged-codex-home","platformFamily":"unix","platformOs":"macos"}}
```

**Limits of the staged home:**
- The directory **must already exist** before launch.
- **Auth follows `CODEX_HOME`.** `codex exec --ignore-user-config` is documented as "Do not load `$CODEX_HOME/config.toml`; **auth still uses `CODEX_HOME`**." So a staged home needs `auth.json` symlinked or copied, or the run will be unauthenticated. Symlinking the user's `auth.json` worked; note this is a token file and the app should not copy it.
- Codex **writes into** the staged home: `sessions/`, `logs_2.sqlite`, `cache/`, `installation_id`, and it downloaded a full `plugins/cache/` tree. A staged home is not free — budget disk and startup cost, or reuse one staged home per Repository rather than per run.

**(c) `--profile <name>` / `-p`.** Layers `$CODEX_HOME/<name>.config.toml` over the base user config. Confirmed in real `--help`: "Layer $CODEX_HOME/<name>.config.toml on top of the base user config". Since 0.134.0 it no longer reads `[profiles.<name>]` from `config.toml`, and top-level `profile = "..."` is gone. [Source: [Advanced Config → Profiles](https://developers.openai.com/codex/config-file/config-advanced)]

**Not suitable for this app**: a profile requires writing a file *into the user's `CODEX_HOME`*, which is exactly what the brief forbids — unless combined with a staged `CODEX_HOME`.

**(d) `thread/start.config` — protocol-level config injection. This is the best mechanism.** The installed app-server schema defines:

```json
"config": {"type": ["object","null"], "additionalProperties": true}
```

on both `ThreadStartParams` and (per docs) resume. It accepts an arbitrary config object over JSON-RPC. Verified working: `"config":{"model_reasoning_effort":"low"}` was accepted by a live `thread/start`.

`ThreadStartParams` also carries `baseInstructions` and `developerInstructions` (both `string|null`), `cwd`, `approvalPolicy`, `sandbox`, `model`, `modelProvider`, `personality`, `ephemeral`, `serviceName`, `approvalsReviewer`.

**Recommendation:** use **(d)** for policy/model/effort/methodology, and **(b)** a per-Repository staged `CODEX_HOME` only for things that must be files on disk — the `rules/` directory (Standing Approvals) and `mcp_servers` registration. Never write to the user's `~/.codex`.

### Relevant config keys

| Key | Type |
| --- | --- |
| `approval_policy` | `untrusted \| on-request \| never \| { granular = {...} }` |
| `sandbox_mode` | `read-only \| workspace-write \| danger-full-access` |
| `sandbox_workspace_write.*` | see §2 |
| `model` | string |
| `model_reasoning_effort` | `minimal \| low \| medium \| high \| xhigh` (Responses API only; `xhigh` is model-dependent) |
| `approvals_reviewer` | `user \| auto_review \| guardian_subagent` (legacy) |
| `web_search` | `cached` (default) `\| indexed \| live \| disabled` |
| `personality` | `friendly \| pragmatic \| none` |
| `allow_login_shell` | boolean |
| `project_doc_max_bytes` | number (default 32 KiB) |
| `log_dir` | path |
| `[features].*` | feature flags; CLI equivalents `--enable`/`--disable` |

Other useful escape hatches on `codex exec`: `--ignore-user-config`, `--ignore-rules`, `--ephemeral` (no session files on disk), `--strict-config` (error on unrecognized config keys — **useful as a version-compat canary**).

## 4. Standing approvals — Codex has native support

**This is the key correction to the design brief.** Codex has *two* native persistent-allowlist concepts, plus a session-scoped one.

### (a) Execpolicy `.rules` files — the persistent per-command allowlist

`.rules` files live in a `rules/` folder next to any active config layer, e.g. `$CODEX_HOME/rules/default.rules` or `<repo>/.codex/rules/` (trusted projects only). They are written in Starlark. [Source: [Rules](https://developers.openai.com/codex/agent-configuration/rules)]

```python
prefix_rule(
    pattern = ["gh", "pr", "view"],
    decision = "allow",          # allow | prompt | forbidden  (default: allow)
    justification = "Viewing PRs is allowed",
    match = ["gh pr view 7888"],
    not_match = ["gh pr --repo openai/codex view 7888"],
)
```

- `decision = "allow"` means "run the command **outside the sandbox** without prompting" — i.e. exactly a Standing Approval.
- Most restrictive wins across matching rules: `forbidden` > `prompt` > `allow`.
- `pattern` elements may be a literal or a union of literals (`["view","list"]`).
- Shell wrappers (`bash -lc`, `sh -c`, `zsh -c`) are **split by tree-sitter** into individual commands when the script is a linear chain of plain words joined by `&&`, `||`, `;`, `|`; each is evaluated separately and the most restrictive result wins. So allowing `git add` does **not** auto-allow `git add . && rm -rf /`. Scripts using redirection, substitution, env assignment, wildcards, or control flow are **not** split and are evaluated as one `["bash","-lc","<full script>"]` invocation.
- The TUI already writes to `$CODEX_HOME/rules/default.rules` when a user allowlists a command.
- Rules are marked **experimental**.

There is a first-class test/lint command, verified present locally:

```
$ codex execpolicy check --help
Usage: codex execpolicy check [OPTIONS] --rules <PATH> <COMMAND>...
  -r, --rules <PATH>  Paths to execpolicy rule files to evaluate (repeatable)
      --pretty        Pretty-print the JSON output
```

**This is the mechanism to implement per-Repository Standing Approvals for commands.** Write a generated `.rules` file into the per-Repository staged `CODEX_HOME/rules/`, and validate it with `codex execpolicy check` before use. `--ignore-rules` (on `codex exec`) disables rule loading if the app ever needs a clean run.

### (b) In-band amendment via the approval response

The approval protocol can *create* a standing rule as part of answering a prompt. From the locally generated `CommandExecutionApprovalDecision` schema:

```json
{ "acceptWithExecpolicyAmendment": { "execpolicy_amendment": ["cmd", "..."] } }
```

described as "User approved the command, and wants to apply the proposed execpolicy amendment so future matching commands can run without prompting." The request itself carries `proposedExecpolicyAmendment` (`array|null`), so Codex proposes the prefix and the client only has to render it. There is a parallel `applyNetworkPolicyAmendment` carrying `{action: allow|deny, host}` for persistent network rules.

This means the app can offer "Always allow this command" directly in the approval card and let Codex compute the correct prefix — no prefix-parsing logic in the app.

Note: when Smart approvals are enabled (default), "Codex may propose a `prefix_rule` for you during escalation requests. Review the suggested prefix carefully before accepting it." The app should show the exact proposed prefix, not just a button.

### (c) Session-scoped: `acceptForSession`

Both command and file-change decisions support `acceptForSession`:
- command: "future prompts in the same session-scoped approval cache should run without prompting"
- file change: "future changes to the same files should run without prompting"

### (d) Blanket file-edit permission for a repo — weakest area

There is no clean documented equivalent of `.rules` for file writes. The options are:
- `sandbox: workspace-write` with the repo as a writable root — the honest answer; edits inside the repo just don't prompt.
- `sandbox_workspace_write.writableRoots` / `--add-dir` to extend the writable set.
- Beta **permission profiles** (`[permissions.<name>]`, `default_permissions`) with `filesystem` rules of `read`/`write`/`deny` scoped to `:workspace_roots`, globs, and explicit paths. Built-ins: `:read-only`, `:workspace`, `:danger-full-access`.
- `FileChangeRequestApprovalParams.grantRoot` — but it is explicitly marked **`[UNSTABLE]`** in the installed schema: *"When set, the agent is asking the user to allow writes under this root for the remainder of the session (**unclear if this is honored today**)."* **Do not build on `grantRoot`.**

**Important caveat on permission profiles:** they do **not** compose with the older sandbox settings. "If `sandbox_mode` appears in any loaded config file, you pass `--sandbox`, or the selected config profile sets `sandbox_mode`, Codex uses those older sandbox settings instead of `default_permissions`." [Source: [Permissions](https://developers.openai.com/codex/permissions)] So the app must choose one system and stick to it. Given permission profiles are Beta and the two-mode UI is simple, **use `sandbox_mode` and never emit `default_permissions`.**

## 5. Programmatic approval: `codex exec` cannot do it

### `codex exec` auto-rejects — verified

`codex exec --help` on this machine lists **no `-a` / `--ask-for-approval` flag**. Passing it fails:

```
$ codex exec -a never ...
error: unexpected argument '-a' found
```

Approval policy on `exec` can only be set via `-c approval_policy=...` or config. And when a prompt *would* be raised, `exec` rejects it rather than emitting an event. Verified with `approval_policy=untrusted`, `--sandbox read-only`, asking the agent to create a file:

```
{"type":"thread.started","thread_id":"019fbef8-58f8-7e93-ad32-0f67ed2e90bc"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'll create `newfile.txt` ..."}}
ERROR codex_core::tools::router: error=patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"I couldn't create `newfile.txt`: the workspace is read-only, and approval settings prohibit writes..."}}
{"type":"turn.completed","usage":{...}}
```

No approval event of any kind appears on the `--json` stream. **`codex exec` cannot support an "Ask" mode.**

### `codex app-server` — the mode a GUI should use

Transport: newline-delimited JSON-RPC 2.0 over stdio by default; `--listen` also supports `unix://`, `ws://IP:PORT`, `off`. Requires an `initialize` request followed by an `initialized` notification. Experimental fields require `initialize.params.capabilities.experimentalApi = true`.

The installed binary can emit its own exact protocol contract — this is the strongest possible source and should be vendored per supported Codex version:

```
codex app-server generate-json-schema --out <DIR>     # 40 JSON Schema files + v1/v2 bundles
codex app-server generate-ts                          # TypeScript bindings
```

**Server-initiated request methods** (extracted from the locally generated `ServerRequest.json`, 0.146.0):

```
account/chatgptAuthTokens/refresh
applyPatchApproval                  (legacy v1)
attestation/generate
execCommandApproval                 (legacy v1)
item/commandExecution/requestApproval
item/fileChange/requestApproval
item/permissions/requestApproval
item/tool/call
item/tool/requestUserInput
mcpServer/elicitation/request
```

#### Command execution approval

Request `item/commandExecution/requestApproval`, params (required: `itemId`, `startedAtMs`, `threadId`, `turnId`):

| Field | Type | Notes |
| --- | --- | --- |
| `threadId`, `turnId`, `itemId` | string | scope UI state |
| `startedAtMs` | int64 | |
| `command` | string \| null | |
| `cwd` | path \| null | |
| `commandActions` | array \| null | "Best-effort parsed command actions for friendly display" |
| `reason` | string \| null | |
| `approvalId` | string \| null | null for regular shell/unified_exec approvals |
| `environmentId` | string \| null | |
| `proposedExecpolicyAmendment` | array\<string\> \| null | see §4 |
| `proposedNetworkPolicyAmendments` | array \| null | |
| `networkApprovalContext` | object \| null | when present this is a **network** prompt (`host`, `protocol`), not a shell-command prompt — render differently |
| `additionalPermissions` | — | only with `experimentalApi`; paths are absolute on the wire |

Response: `{"decision": <CommandExecutionApprovalDecision>}` where the decision is one of
`"accept"`, `"acceptForSession"`, `"decline"`, `"cancel"`,
`{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["..."]}}`,
`{"applyNetworkPolicyAmendment":{"network_policy_amendment":{"action":"allow"|"deny","host":"..."}}}`.

`decline` → agent continues the turn. `cancel` → turn is immediately interrupted.

#### File change approval

Request `item/fileChange/requestApproval`, params: `itemId`, `startedAtMs`, `threadId`, `turnId` (required), plus `reason` and `grantRoot` (both nullable; `grantRoot` is `[UNSTABLE]`).

Response: `{"decision": "accept" | "acceptForSession" | "decline" | "cancel"}`.

#### Structured questions — `item/tool/requestUserInput` (EXPERIMENTAL)

Params: `threadId`, `turnId`, `itemId`, `questions[]`, `autoResolutionMs` (int|null).
Each question: `{id, header, question, options?: [{label, description}], isOther=false, isSecret=false}`.
Response: `{"answers": { "<questionId>": { "answers": ["..."] } }}`.

Note the installed schema does **not** impose the "1–3 questions" limit that older notes recorded; it is an unbounded array. Options are nullable, so a question can be free-text only. `isSecret` is new and should suppress echo/logging in the UI.

#### Permission requests

`item/permissions/requestApproval` with `threadId`, `turnId`, `itemId`, `environmentId`, `cwd`, optional `reason`, and requested network/filesystem permissions. Respond with `permissions` containing **only the granted subset**; `scope: "session"` persists the grant for the session, otherwise it is turn-scoped.

#### Resolution notification

After any answer — or if the request is cleared by turn start/completion/interruption — the server emits `serverRequest/resolved` with `{threadId, requestId}`. The app must treat this as the authority on whether a pending card is still live.

### Live end-to-end proof

Staged `CODEX_HOME`, `approvalPolicy: "untrusted"`, `sandbox: "read-only"`, `config: {model_reasoning_effort: "low"}`, `developerInstructions` set; asked the agent to create a file. Abridged real transcript:

```json
{"id":1,"result":{"userAgent":"probe/0.146.0 ...","codexHome":"/private/var/.../staged-codex-home", ...}}
{"id":2,"result":{"thread":{"id":"019fbef9-b63d-7ae1-be49-d2396d1c963e","sessionId":"019fbef9-...","path":".../sessions/2026/08/01/rollout-2026-08-01T14-17-44-019fbef9-....jsonl","cwd":"...","cliVersion":"0.146.0","historyMode":"legacy","modelProvider":"openai","status":{"type":"idle"}, ...}}}
{"method":"thread/started","params":{...}}
{"method":"mcpServer/startupStatus/updated","params":{"threadId":"...","name":"codex_apps","status":"ready","error":null,"failureReason":null}}
{"id":3,"result":{"turn":{"id":"019fbef9-b6ce-71e2-9a2a-d1f5495a164b","status":"inProgress", ...}}}
{"method":"turn/started","params":{...}}
{"method":"item/started","params":{"item":{"type":"userMessage", ...}}}
{"method":"item/started","params":{"item":{"type":"agentMessage","id":"msg_...","text":"","phase":"commentary"}}}
{"method":"item/agentMessage/delta","params":{"itemId":"msg_...","delta":"I"}}
...
{"method":"item/started","params":{"item":{"type":"fileChange","id":"exec-a255d075-...","changes":[{"path":"/private/var/.../probe.txt","kind":{"type":"add"},"diff":"abc\n"}],"status":"inProgress"}}}
{"method":"thread/status/changed","params":{"status":{"type":"active","activeFlags":["waitingOnApproval"]}}}
{"method":"item/fileChange/requestApproval","id":0,"params":{"threadId":"...","turnId":"...","itemId":"exec-a255d075-...","startedAtMs":1785615469786,"reason":null,"grantRoot":null}}
    --> client sent: {"jsonrpc":"2.0","id":0,"result":{"decision":"accept"}}
{"method":"serverRequest/resolved","params":{"threadId":"...","requestId":0}}
{"method":"thread/status/changed","params":{"status":{"type":"active","activeFlags":[]}}}
{"method":"item/completed","params":{"item":{"type":"fileChange", ..., "status":"completed"}}}
{"method":"turn/diff/updated","params":{"diff":"diff --git a/probe.txt b/probe.txt\nnew file mode 100644\nindex 000...\n--- /dev/null\n+++ b/probe.txt\n@@ -0,0 +1 @@\n+abc\n"}}
{"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"total":{"totalTokens":17134,"inputTokens":17073,"cachedInputTokens":11008,"cacheWriteInputTokens":0,"outputTokens":61,"reasoningOutputTokens":0},"last":{...},"modelContextWindow":258400}}}
{"method":"account/rateLimits/updated","params":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":1,"windowDurationMins":10080,"resetsAt":1786163603},"credits":{...},"planType":"plus", ...}}}
{"method":"item/started","params":{"item":{"type":"reasoning","id":"rs_...","summary":[],"content":[]}}}
{"method":"item/started","params":{"item":{"type":"commandExecution","id":"exec-176a...","command":"/bin/zsh -lc \"sed -n '1p' probe.txt\"","cwd":"...","processId":"11935","source":"unifiedExecStartup","status":"inProgress","commandActions":[{"type":"read","command":"sed -n 1p probe.txt","name":"probe.txt","path":"..."}],"aggregatedOutput":null,"exitCode":null,"durationMs":null}}}
{"method":"item/completed","params":{"item":{"type":"commandExecution", ..., "status":"completed","aggregatedOutput":"abc\n","exitCode":0,"durationMs":0}}}
{"method":"item/started","params":{"item":{"type":"agentMessage","id":"msg_...","text":"","phase":"final_answer"}}}
```

This single transcript validates: staged `CODEX_HOME`, protocol `config` injection, `developerInstructions`, kebab-case enums, HITL approval round-trip, inline per-file `diff`, aggregated `turn/diff/updated`, token usage, rate limits, and session file path.

### Docs vs. installed binary — a real discrepancy

The published docs show `"approvalPolicy": "unlessTrusted"`, `"sandbox": "workspaceWrite"`, and `allowedApprovalPolicies: ["onRequest","unlessTrusted"]`. **The installed 0.146.0 binary rejects these:**

```json
{"error":{"code":-32600,"message":"Invalid request: unknown variant `workspaceWrite`, expected one of `read-only`, `workspace-write`, `danger-full-access`"},"id":2}
```

The generated schema confirms `SandboxMode` is `read-only | workspace-write | danger-full-access` and `AskForApproval` is `untrusted | on-request | never`. Note the *nested* `sandboxPolicy` object on `turn/start` **does** use camelCase type tags (`workspaceWrite`, `readOnly`, `dangerFullAccess`, `externalSandbox`) — so both casings exist, on different fields. **Generate bindings from the installed binary; do not transcribe the docs.**

## 6. Stream protocol

### `codex exec --json` (JSONL on stdout)

Real captured output from a `workspace-write` run:

```json
{"type":"thread.started","thread_id":"019fbef7-df3b-7723-b37a-a9666a96eeb7"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'll list the directory first, then update only `greeting.txt`."}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'ls -1'","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'ls -1'","aggregated_output":"greeting.txt\n","exit_code":0,"status":"completed"}}
{"type":"item.started","item":{"id":"item_2","type":"file_change","changes":[{"path":"/private/var/.../greeting.txt","kind":"add"}],"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"/private/var/.../greeting.txt","kind":"add"}],"status":"completed"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Updated `greeting.txt` to say `hello world`."}}
{"type":"turn.completed","usage":{"input_tokens":52474,"cached_input_tokens":45312,"cache_write_input_tokens":0,"output_tokens":238,"reasoning_output_tokens":0}}
```

Observations, all significant:

- **`snake_case` types and fields** (`thread.started`, `command_execution`, `aggregated_output`) — a *different* naming convention from app-server's `camelCase`. Two distinct adapters, not one.
- **`file_change.changes[]` carries only `{path, kind}` — there is no `diff`.** `codex exec --json` cannot render an inline patch. App-server's `fileChange` item *does* carry `diff` per change, plus `turn/diff/updated` with a full `git diff`-format unified diff. **This alone rules out `exec` for a diff-rendering GUI.**
- No approval events (see §5), no `serverRequest/resolved`.
- No streaming deltas — `item.completed` only for agent messages in this run; documented event types are `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, `error`.
- Stderr carries progress and Rust `ERROR` lines; stdout is the JSONL stream. Treat them separately.
- **Gotcha:** with `--json` and an attached stdin, Codex prints `Reading additional input from stdin...` and blocks. Always redirect `< /dev/null` (or write the prompt on stdin deliberately).

`--output-schema <FILE>` constrains the final response to a JSON Schema; `-o/--output-last-message <FILE>` writes the final message to a file.

### `codex app-server` items and deltas

`ThreadItem` union (documented set): `userMessage`, `agentMessage` (`{id,text,phase}`, phase ∈ `commentary`|`final_answer`), `plan`, `reasoning` (`{id,summary,content}`), `commandExecution` (`{id,command,cwd,status,commandActions,aggregatedOutput?,exitCode?,durationMs?}`), `fileChange` (`{id,changes,status}` with `changes[] = {path, kind, diff}`), `mcpToolCall`, `dynamicToolCall`, `collabToolCall`, `webSearch`, `imageView`, `enteredReviewMode`, `exitedReviewMode`, `contextCompaction`.

`PatchChangeKind` is a tagged object, not a bare string: `{"type":"add"}`, `{"type":"delete"}`, `{"type":"update","move_path":string|null}`. (`codex exec --json` uses a bare `"add"` string — another adapter divergence.)

Lifecycle: `item/started` (full item when work begins) and `item/completed` (**authoritative** final state).

Deltas: `item/agentMessage/delta`, `item/plan/delta`, `item/reasoning/summaryTextDelta` (+ `summaryIndex`), `item/reasoning/summaryPartAdded`, `item/reasoning/textDelta`, `item/commandExecution/outputDelta`.

`item/fileChange/outputDelta` is **deprecated** — "Current app-server versions no longer emit it; use `fileChange` items and `turn/diff/updated` instead."

Turn events: `turn/started`, `turn/completed` (status `completed`|`interrupted`|`failed`), `turn/diff/updated` (aggregated unified diff), `turn/plan/updated` (`plan[] = {step, status}`), `hook/started`, `hook/completed`, `model/rerouted`, `model/safetyBuffering/updated`, `model/verification`, `thread/tokenUsage/updated`.

Caveat from the docs, confirmed by the transcript: "`turn/diff/updated` and `turn/plan/updated` currently include empty `items` arrays even when item events stream. Use `item/*` notifications as the source of truth."

Also observed live but not in the item list: `thread/status/changed` with `activeFlags: ["waitingOnApproval"]` — a clean signal for showing a blocked-on-user state; `mcpServer/startupStatus/updated`; `account/rateLimits/updated`.

**Errors.** On failure the server emits `error` with `{error:{message, codexErrorInfo?, additionalDetails?}}` then completes the turn with `status: "failed"`. `codexErrorInfo` values: `ContextWindowExceeded`, `UsageLimitExceeded`, `HttpConnectionFailed`, `ResponseStreamConnectionFailed`, `ResponseStreamDisconnected`, `ResponseTooManyFailedAttempts`, `BadRequest`, `Unauthorized`, `SandboxError`, `InternalServerError`, `Other`, with `httpStatusCode` when available.

**`apply_patch`.** Codex's patch tool surfaces as `fileChange` items rather than a raw `apply_patch` tool call on the app-server stream; the legacy raw text path is the deprecated `item/fileChange/outputDelta`. There is a separate `codex apply <TASK_ID>` subcommand that applies a Codex Cloud diff as a `git apply` to the local tree — unrelated to local run streaming. [Sources: [App Server](https://developers.openai.com/codex/app-server); local `codex apply --help`]

## 7. Session continuity

**IDs.** `thread/start` returns `thread.id` and `thread.sessionId`. Per the docs: "Root threads use their own thread id as the session id; forked threads keep the session id of the root they came from. Clients should read the session id from `thread.sessionId` instead of deriving it from the thread id."

**Resume.** `thread/resume` accepts `threadId`, and per the installed `ThreadResumeParams`, three routes: by `thread_id`, by in-memory `history`, or by `path`. Precedence for non-running threads: `history` > non-empty `path` > `thread_id`. If `thread_id` names a *running* thread, app-server rejoins it and treats a non-empty `path` as a consistency check. `thread/fork` also exists. Resume accepts the same config overrides as start. Resuming does not bump `updatedAt` until a turn starts. Resuming with a different model emits a warning and applies a one-time model-switch instruction.

**CLI equivalents.** `codex resume [SESSION_ID] [PROMPT]` with `--last`, `--all`, `--include-non-interactive`; `codex exec resume [SESSION_ID] [PROMPT]` with `--last`, `--all`. Also `codex fork`, `codex archive`, `codex unarchive`, `codex delete`. Session ID may be a UUID or a session name, "UUIDs take precedence if it parses."

**On-disk location — verified.** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl`. Real example from the staged home:

```
.../staged-codex-home/sessions/2026/08/01/rollout-2026-08-01T14-17-44-019fbef9-b63d-7ae1-be49-d2396d1c963e.jsonl
```

The live `thread/start` result returns this path directly as `thread.path` — the app should record that rather than reconstructing it. Archived sessions move to `$CODEX_HOME/archived_sessions/`. There is a `$CODEX_HOME/session_index.jsonl` and SQLite state (`state_5.sqlite`); `CODEX_SQLITE_HOME` / `sqlite_home` can relocate the SQLite portion.

`codex exec --ephemeral` runs without persisting session files.

Because the app runs multiple Ideas concurrently, **never use `--last`** — always persist and pass the explicit thread/session id.

## 8. MCP

### Registering an MCP server for a run

Config table in `config.toml` (user, project, or staged home):

```toml
[mcp_servers.offer_response_options]
command = "node"
args = ["/path/to/server.js"]
cwd = "/path"
env_vars = ["SOME_TOKEN"]
startup_timeout_sec = 10       # default 10
tool_timeout_sec = 60          # default 60
enabled = true
required = true                # startup FAILS if this server can't initialize
enabled_tools = ["offer_response_options"]
default_tools_approval_mode = "auto"   # auto | prompt | writes | approve

[mcp_servers.offer_response_options.env]
MY_VAR = "value"
```

STDIO keys: `command` (required), `args`, `env`, `env_vars`, `cwd`, `experimental_environment`. Streamable HTTP keys: `url` (required), `auth`, `bearer_token_env_var`, `http_headers`, `env_http_headers`. Per-tool override: `[mcp_servers.<name>.tools.<tool>] approval_mode = "..."`. [Source: [MCP](https://developers.openai.com/codex/extend/mcp)]

**Three ways to register per-run without touching the user's config:**
1. `-c 'mcp_servers.offer_response_options.command="node"'` etc. (CLI, works on every subcommand)
2. `mcp_servers` inside the app-server `thread/start.config` object
3. a `config.toml` inside the staged `CODEX_HOME`

There is also a CLI helper — `codex mcp add <name> --env K=V -- <command>` — but it **writes to the user's config**, so the app must not use it.

`required = true` is worth setting for the response-options server: "If you configure an enabled MCP server with `required = true` and it fails to initialize, `codex exec` exits with an error instead of continuing without that server," and `thread/start`/`thread/resume` likewise fail. That converts a silent degradation into a visible failure.

Startup is observable: the live transcript shows `mcpServer/startupStatus/updated` with `{threadId, name, status: "starting"|"ready", error, failureReason}`.

Codex reads the MCP `instructions` field returned at initialization and uses it as server-wide guidance; "Keep the first 512 characters self-contained."

### The two directions — distinction

- **Codex as MCP *client*** — `[mcp_servers.*]` config above. This is what the app needs for its `offer_response_options` tool.
- **Codex as MCP *server*** — `codex mcp-server` ("Start Codex as an MCP server (stdio)", confirmed in local `--help`) exposes Codex itself as a tool to *another* MCP host. **Not** what this app wants.
- **`codex mcp`** is neither — it is the management CLI for the client-side server registry (`list`, `get`, `add`, `remove`, `login`, `logout`).

Note the app's own MCP server will be invoked as a tool call, and MCP tool calls are subject to approval: `default_tools_approval_mode = "auto"` avoids prompting on a UI-only tool. Also relevant is the separate `mcpServer/elicitation/request` server request (`mode: "form" | "openai/form" | "url"`), which is a *different* channel for an MCP server to ask the user something — potentially a cleaner fit than a custom tool, though the `openai/form` variant requires opting in with `initialize.params.capabilities.mcpServerOpenaiFormElicitation`.

## 9. Skills, prompts, and instruction files

**Skills.** Codex has a native skill concept. Invoked with `$<skill-name>` in user text (ChatGPT web uses `@`). Over app-server, include both the `$name` in text **and** a `skill` input item so the server injects the full instructions rather than relying on the model to resolve the name:

```json
"input": [
  {"type":"text","text":"$skill-creator Add a new skill for triaging flaky CI."},
  {"type":"skill","name":"skill-creator","path":"/Users/me/.codex/skills/skill-creator/SKILL.md"}
]
```

Skills live under `$CODEX_HOME/skills/` (present locally) and can also arrive via plugins (`$CODEX_HOME/plugins/`). There is a `skill_approval` category in the granular approval policy.

**Slash commands.** Codex has TUI slash commands (`/permissions`, `/status`, `/mcp`, `/personality`, `/goal`). These are TUI-only affordances, **not** a programmatic surface — the app should drive the equivalent settings through config/protocol fields instead.

**AGENTS.md discovery** [Source: [Custom instructions with AGENTS.md](https://developers.openai.com/codex/agent-configuration/agents-md)]:

1. **Global**: in `CODEX_HOME`, `AGENTS.override.md` if present, else `AGENTS.md`. First non-empty file only.
2. **Project**: from the project root (usually the git root) walking down to cwd. In each directory: `AGENTS.override.md`, then `AGENTS.md`, then names in `project_doc_fallback_filenames`. At most one file per directory.
3. **Merge**: concatenated root → cwd, blank-line joined; later files (closer to cwd) win.

Empty files are skipped; loading stops at `project_doc_max_bytes` (32 KiB default). The instruction chain is built **once per run**.

**Injecting a methodology document per run — three options, best first:**

1. **`thread/start.developerInstructions`** (or `baseInstructions`) — a plain string over the protocol. No files, no size heuristics, no interaction with the user's `AGENTS.md`. Verified accepted by the live probe. **This is the right mechanism.**
2. Staged `CODEX_HOME/AGENTS.md` — verified working (`STAGED-HOME-OK`), but it *replaces* the user's global AGENTS.md rather than adding to it.
3. Writing `AGENTS.md` into the user's repo — intrusive; avoid.

Helpfully, `thread/start`, `thread/resume`, and `thread/fork` return **`instructionSources`**, an array of loaded instruction-file paths. The app can display exactly which instruction files were in effect for a run.

Related: `codex debug prompt-input` renders the model-visible prompt input list as JSON — useful for verifying injection during development.

## 10. Model and reasoning effort

**Model.** `-m/--model <MODEL>` on root, `exec`, and `resume`; `model` in config; `model` on `thread/start` and `turn/start`. `--oss` / `--local-provider <lmstudio|ollama>` for local providers; `modelProvider` on `thread/start`.

**Effort.** `model_reasoning_effort` in config, values `minimal | low | medium | high | xhigh` ("Responses API only; `xhigh` is model-dependent"). Over the protocol, `turn/start.effort`. There is no `--effort` CLI flag on `codex exec` in 0.146.0 — use `-c model_reasoning_effort=low` (verified working).

Note the installed `ReasoningEffort` schema is deliberately open: `{"description":"A non-empty reasoning effort value advertised by the model.","type":"string","minLength":1}`. It is **not** a closed enum on the wire. The app must therefore discover valid values rather than hard-coding them — use `model/list`, which returns model ids, display names, the default model, input modalities, `defaultReasoningEffort`, and `supportedReasoningEfforts`. `codex debug models` renders the raw model catalog as JSON. A local `models_cache.json` exists in `CODEX_HOME`.

`plan_mode_reasoning_effort` is a separate key. `service_tier` / Fast mode is a separate axis again.

## What has changed since the earlier research in this repo

Checked against `local-cli-harness-capabilities.md` (2026-07-30) and `t3-code-executable-discovery.md`.

**Still correct:**
- Codex should use `codex app-server` over stdio JSONL — now confirmed to be *mandatory*, not merely preferred.
- `thread/start` / `thread/resume` / `thread/fork` / `turn/start` / `turn/interrupt` structure.
- `model/list` for models and efforts; `skills/list` and the `skill` input item.
- `turn/interrupt` → `status: "interrupted"`.
- Persist the thread/session id per Idea; never rely on "last session".
- Generating bindings per Codex version rather than copying doc examples — this research found a concrete case where that matters.
- Same installed version, `codex-cli 0.146.0` at `/opt/homebrew/bin/codex`.
- T3 Code's approach of probing Codex via an `app-server` `initialize` handshake and reading the version out of the returned `userAgent` — confirmed accurate; the live probe returned `"userAgent":"probe/0.146.0 (Mac OS 26.3.0; arm64) ..."`.

**Needs correcting or sharpening:**

1. **`local-cli-harness-capabilities.md` says the structured-question API is "1–3 questions".** The installed `ToolRequestUserInputParams` schema places **no bound** on the `questions` array, and adds `isSecret` (not previously recorded). Options are nullable.
2. **It describes approvals only as "server-initiated command/file/permission requests with accept/decline/cancel decisions."** That undersells the decision set materially: `acceptForSession`, `acceptWithExecpolicyAmendment`, and `applyNetworkPolicyAmendment` are the mechanisms that make Standing Approvals implementable natively.
3. **It presents `codex exec --json` as a viable "bounded background job" surface** without noting that it **auto-rejects approvals** and **emits no diff on `file_change`**. Both are hard limits worth recording.
4. **It does not mention `on-failure`** — worth recording that it is now deprecated/removed, since older integrations may still emit it.
5. **New since that note:** `thread/start.config`, `developerInstructions`/`baseInstructions`, `instructionSources`, execpolicy `.rules` + `codex execpolicy check`, permission profiles (Beta), `approvals_reviewer` / Auto-review, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--strict-config`, `--add-dir`, `thread/status/changed` with `waitingOnApproval`.
6. **`t3-code-executable-discovery.md`** notes T3 Code does not verify Codex with `codex --version`. Both work here; `codex --version` prints `codex-cli 0.146.0` and the app-server handshake yields the same number in `userAgent`. Either is fine; the handshake additionally proves auth and protocol compatibility, so it remains the better probe.

## Recommended design for this app

**Transport.** One long-lived `codex app-server` child process per Idea (or one shared, multiplexed by `threadId`). Handshake `initialize` → `initialized`. Set `capabilities.experimentalApi = true` only if `tool/requestUserInput` or `additionalPermissions` are needed, and feature-detect. Set `serviceName` and `threadSource` — the live probe defaulted `source` to `"vscode"`, which is wrong for this app.

**Per-run injection.** Per-Repository staged `CODEX_HOME` (created once, reused) holding `rules/standing-approvals.rules`, a minimal `config.toml`, and a symlink to the user's `auth.json`. Everything else — policy, sandbox, model, effort, methodology — goes through `thread/start` fields and `thread/start.config`. **The user's `~/.codex` is never written to.**

**Mode mapping.**

```
Ask          → approvalPolicy: "untrusted",  sandbox: "workspace-write"
Full access  → approvalPolicy: "never",      sandbox: "danger-full-access"
```

**Standing Approvals.**
- *Command* standing approvals → generate `prefix_rule(pattern=[...], decision="allow")` into the staged `rules/` file; validate with `codex execpolicy check --rules <file> -- <cmd>` before writing. Offer "Always allow" on the approval card backed by `acceptWithExecpolicyAmendment` using the server's own `proposedExecpolicyAmendment`.
- *Repo-wide file edits* → express as `sandbox: workspace-write` with the repo as a writable root. Do **not** rely on `grantRoot`.
- *Network hosts* → `applyNetworkPolicyAmendment`.

**Diffs.** Render from `fileChange.changes[].diff` per file, and `turn/diff/updated` for the turn-level `git diff`. Treat `item/completed` as authoritative.

**Safety.** Never emit `default_permissions` (it silently disables `sandbox_mode`). Never use `--full-auto`, `--yolo`, or `--dangerously-bypass-approvals-and-sandbox`. Track `serverRequest/resolved` so stale approval cards are dismissed. Use `--strict-config` in development to catch config keys the installed version does not recognize.

## Open questions / could not verify

- **Does `untrusted` + `workspace-write` prompt on in-workspace file writes?** The live probe used `untrusted` + `read-only`, where the write was an escalation and *did* prompt. The docs describe the `workspace-write` row as "can read and edit files but asks for approval before running untrusted commands," implying in-workspace edits do **not** prompt. Not verified directly. If the product needs a prompt on every edit, test this specific combination before shipping.
- **Does `thread/start.config` accept the full config surface, or a subset?** The schema is `additionalProperties: true` with no documented allowlist. Only `model_reasoning_effort` was verified. Whether `mcp_servers`, `sandbox_workspace_write`, or `rules` paths are honoured through this channel is unverified — test each key the app relies on.
- **Are `.rules` files loadable from an arbitrary directory without a full staged `CODEX_HOME`?** `codex execpolicy check` takes `--rules <PATH>`, but the runtime loader is documented only as scanning `rules/` under active config layers. No `--rules` flag exists on `codex`/`codex exec`. Unverified whether a `-c` key can point at a rules file.
- **Exact behaviour of `acceptWithExecpolicyAmendment`** — whether it persists to `$CODEX_HOME/rules/default.rules` (as the TUI allowlist flow is documented to do) or only to session state. Not verified; this determines whether the app must mirror the amendment into its own Standing Approvals store.
- **`grantRoot`** — explicitly `[UNSTABLE]` and "unclear if this is honored today" per the installed schema. Not tested.
- **Whether `codex exec --json` ever emits reasoning items.** The captured runs used `model_reasoning_effort=low` and produced none (`reasoning_output_tokens` 0 and 34). Documented item types include reasoning, but the shape on the `exec` stream was not observed.
- **Turn-level `usage` vs `thread/tokenUsage/updated` reconciliation** across resumed threads — not investigated.
- **`--remote` / `remote-control` / `exec-server`** — experimental app-server daemon modes were not evaluated. They may matter if the app wants one daemon shared across Ideas.
- **Cost/latency of a staged `CODEX_HOME`.** The probe home pulled down a full `plugins/cache/` tree on first use. Whether this can be suppressed (and how much it costs per Repository) was not measured.
- **Windows/Linux behaviour** — out of scope; all local verification was macOS 26.3.0 arm64.

## Primary sources

Official documentation (all fetched as Markdown via the documented `.md` URL suffix):

- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Non-interactive mode](https://developers.openai.com/codex/non-interactive-mode)
- [Agent approvals & security](https://developers.openai.com/codex/agent-approvals-security)
- [Permissions (profiles, Beta)](https://developers.openai.com/codex/permissions)
- [Sandboxing](https://developers.openai.com/codex/sandboxing)
- [Config basics](https://developers.openai.com/codex/config-file/config-basic)
- [Advanced Config](https://developers.openai.com/codex/config-file/config-advanced)
- [Config Reference](https://developers.openai.com/codex/config-file/config-reference)
- [Environment Variables](https://developers.openai.com/codex/config-file/environment-variables)
- [Rules (execpolicy)](https://developers.openai.com/codex/agent-configuration/rules)
- [Custom instructions with AGENTS.md](https://developers.openai.com/codex/agent-configuration/agents-md)
- [MCP](https://developers.openai.com/codex/extend/mcp)
- [MCP Server](https://developers.openai.com/codex/mcp-server)
- [Skills & Plugins](https://developers.openai.com/codex/skills-and-plugins)
- [Default Auto-review policy (source)](https://github.com/openai/codex/blob/main/codex-rs/core/src/guardian/policy.md)

Local primary evidence captured on this machine (codex-cli 0.146.0):

- `which codex`, `codex --version`
- `codex --help`, `codex exec --help`, `codex resume --help`, `codex exec resume --help`, `codex app-server --help`, `codex mcp --help`, `codex mcp-server --help`, `codex sandbox --help`, `codex debug --help`, `codex execpolicy --help`, `codex execpolicy check --help`, `codex apply --help`
- Flag-acceptance probes for `--full-auto` / `--yolo` / a control invalid flag on both root and `exec`
- `codex app-server generate-json-schema --out <dir>` — 40 schema files plus `codex_app_server_protocol.v2.schemas.json` (537 definitions), the authoritative contract for the installed build
- Live `codex exec --json` runs: staged-`CODEX_HOME` instruction test; `workspace-write` command+file-change run; `untrusted`/`read-only` approval auto-rejection test
- Live `codex app-server` JSON-RPC session: `initialize` → `thread/start` → `turn/start` → `item/fileChange/requestApproval` → `{"decision":"accept"}` → `serverRequest/resolved` → `turn/diff/updated`
- `~/.codex/` directory listing (file and directory names only; no file contents, tokens, or credentials were read or reproduced)

Prior research in this repo, cross-checked: `.scratch/research/local-cli-harness-capabilities.md`, `.scratch/research/t3-code-executable-discovery.md`.
