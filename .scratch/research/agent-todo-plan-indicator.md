# The agent todo/plan indicator: protocols, clients, and how to show one here

Research date: 2026-08-08

Sources read at these refs:

- **Codex CLI** — installed `codex-cli 0.146.0`; the real Rust binary is at
  `/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`
  (the `codex` on PATH is an npm JS shim). Cross-checked against a shallow clone of
  `github.com/openai/codex`, branch `main`, commit `646f7c0a91b8e327d263335da68ae8ef212895ce` (2026-08-09),
  and against the binary's own `codex app-server generate-json-schema --experimental --out <dir>`.
- **Claude Code** — the installed CLI and SDK type definitions on this machine, plus first-party docs
  at docs.claude.com, read 2026-08-08. See §1.
- **T3 Code** — installed `T3 Code (Alpha) 0.0.31`
  (`/Applications/T3 Code (Alpha).app/Contents/Info.plist`, `CFBundleShortVersionString = 0.0.31`).
  Its `app.asar` ships complete source maps with `sourcesContent`, so every citation below is the
  app's own TypeScript, extracted to a scratch tree; paths are given as `src-server/…` and `src-web/…`
  relative to that extraction. Its live state DB at `~/.t3/userdata/state.sqlite` was read read-only.
- **OpenAI web (ChatGPT / deep research)** — first-party pages only. See §3.
- **This repo** — working tree at branch `gortizdev/mem-98-add-guarded-run-undo-using-app-owned-git-snapshots`.

This note **extends** rather than repeats:

- `.scratch/research/codex-permissions-and-protocol.md` — Codex app-server transport, approval methods, config injection.
- `.scratch/research/claude-code-permissions-and-protocol.md` — Claude `stream-json` frame shapes and permission plumbing.
- `.scratch/research/agent-conversation-ux-comparison.md` — the four-product conversation-model comparison. Its §5 argues for a *durable, multi-session* plan object; **this note is about the other thing**: the ephemeral per-turn checklist a Run is working through right now.

## Question and scope

How do Claude Code and Codex expose the checklist an agent is working through; how do real hosts consume and render it; and where would such a thing enter this repo's domain model and UI?

Two mechanisms are constantly confused and must be kept apart throughout:

| | The **todo/checklist** | **Plan mode** |
| --- | --- | --- |
| What it is | A live, statused list of steps, rewritten wholesale as work proceeds | A one-shot Markdown proposal the user approves before work starts |
| Claude Code | `TodoWrite` tool | `ExitPlanMode` tool |
| Codex | `update_plan` tool → `turn/plan/updated` | `ThreadItem { type: "plan", text }`, `item/plan/delta` |
| Shape | `{step, status}[]` | free-form Markdown |
| Durable? | Codex: **no**. See §2.4 | Codex: yes, an item |

Codex says this in its own source: *"`update_plan` is a todo/checklist tool; it is not related to plan-mode updates"* — `codex-rs/app-server/src/bespoke_event_handling.rs:1251`. T3 Code says it to Codex in its injected instructions too (`src-server/src/provider/CodexDeveloperInstructions.ts:24-28`): *"`update_plan` is a checklist/progress/TODOs tool; it does not enter or exit Plan Mode."*

**This note is about the first column.** Plan mode appears only where it would otherwise be mistaken for the checklist.

## Executive conclusion

1. **Both harnesses already send everything needed, and this repo already throws both away.** Codex's `turn/plan/updated` is in `IGNORED_METHODS` (`app/src/core/harness/codex.ts:182`); Claude's `TodoWrite` degrades to a pathless `tool` event that `core/conversation.ts:1260-1263` drops. The generated Codex bindings for the payload are already in the tree and correct. This is a small feature that is currently at exactly zero.
2. **`TodoWrite` is disabled by default as of Claude Code v2.1.142**, replaced by `TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList`. This repo's own recorded fixture (`fixtures/claude-subagent.jsonl:1`, `claude_code_version: 2.1.224`) lists the Task tools and no `TodoWrite`. **Building against `TodoWrite` alone ships a feature that shows nothing on the installed CLI.** Ship Codex first, Claude Task tools second, `TodoWrite` third as a fallback.
3. **Codex does not persist plans.** `EventMsg::PlanUpdate` is classified "Transient, non-durable" in the rollout policy. A host that wants the plan to survive a restart must store it itself — which settles the "durable entry or live-only?" question by removing the choice.
4. **Every protocol sends the whole list every time.** Claude's own tool description: *"Send the full list each call; it replaces the previous one."* Normalize to one snapshot event modelled on this repo's existing `subagent` event, whose docstring already describes this exact bargain.
5. **Both TUIs converged on the same UI: a persistent `n/m` count with the list collapsed behind a toggle.** Codex puts `Tasks n/m` in the *terminal title*; Claude computes `done/total` and hides the list behind `app:toggleTodos`. Neither shows a progress bar. Both strike through completed steps instead of removing them.
6. **Recommendation: extend the existing `RunWorkingIndicator` row, don't build a second dock.** A todo update is ~1.4% of tool traffic (measured in T3's live DB) — the Subagents dock's justification (*"report themselves many times a minute"*) does not transfer. The current-step + `3/7` + elapsed fits the one-row discipline that component already has, expanding in place.
7. **Do not append a block per update.** That is a terminal limitation Codex has no way around; a GUI does, and six `update_plan` calls would otherwise produce six near-identical transcript blocks.
8. **OpenAI's consumer products are a negative result.** ChatGPT agent documents narration and an on-demand progress summary but no plan UI; Codex cloud documents logs, summary and diff; the Responses API has **no plan/todo item type at all**. Only deep research documents a plan surface, and it is a pre-flight editable *plan-mode* artifact plus a log of steps taken.

---

## 1. Claude Code: `TodoWrite`, and the fact that it is off by default

### 1.0 The headline

**`TodoWrite` is disabled by default as of Claude Code v2.1.142**, superseded by four structured Task tools. Anything built against `TodoWrite` alone will show an empty indicator on the version this repo actually drives.

From https://code.claude.com/docs/en/tools-reference, the tools table row verbatim:

> `TodoWrite` | Manages the session task checklist. **Disabled by default as of v2.1.142** in favor of `TaskCreate`, `TaskGet`, `TaskList`, and `TaskUpdate`. Set `CLAUDE_CODE_ENABLE_TASKS=0` to re-enable | Permission required: No

And https://code.claude.com/docs/en/agent-sdk/todo-tracking:

> As of TypeScript Agent SDK 0.3.142 and Claude Code v2.1.142, sessions use the structured Task tools `TaskCreate`, `TaskUpdate`, `TaskGet`, and `TaskList` instead of `TodoWrite`. The Python SDK gets this change from the Claude Code CLI it launches, not from the Python package version…

The gate is in the binary. Installed CLI is `/Users/guillermoortizrebolledo/.local/bin/claude` → `/Users/guillermoortizrebolledo/.local/share/claude/versions/2.1.225` — a 267 MB Bun-compiled Mach-O with the JS bundle embedded as plain strings (`VERSION:"2.1.225"`, `GIT_SHA:"d4b76e8c…"`, `BUILD_TIME:"2026-08-07T19:37:58Z"`, at offset ~264954000). Because it is a compiled binary, citations below are **byte offsets**, not line numbers.

```js
// offset 253867739
function hL(){if(te.CLAUDE_CODE_ENABLE_TASKS===!1)return!1;return!0}
```

combined with the tool's own `isEnabled(){return!hL()&&!wse()}` — i.e. TodoWrite is enabled only when Tasks are disabled.

**Verified live on this machine.** Running `claude -p … --output-format stream-json --allowedTools TodoWrite` on 2.1.225 without the env var: the `system/init` tool list contains no `TodoWrite`, `ToolSearch select:TodoWrite` answered `"No matching deferred tools found"`, and the model fell back to `TaskCreate` (`{"subject":"Step one","description":"Step one","activeForm":"Doing step one"}` → `{"task":{"id":"1","subject":"Step one"}}`). With `CLAUDE_CODE_ENABLE_TASKS=false`, `TodoWrite` appeared and worked.

**This repo's own recorded fixture already proves it.** `app/src/core/harness/fixtures/claude-subagent.jsonl:1` is a real recording (`"claude_code_version":"2.1.224"`) whose `system/init` `tools` array contains `TaskCreate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, `TaskUpdate` — **and no `TodoWrite`**. The repo has physical evidence of this on disk today.

Readiness declares `conversation.minimumVersion: '2.1.0'` and `untestedFrom: '2.2.0'` for Claude (`app/src/main/readiness.ts:97-101`), so the supported band straddles 2.1.142. Both mechanisms are in scope; neither alone is.

### 1.1 The `TodoWrite` input schema

`~/.bun/install/cache/@anthropic-ai/claude-agent-sdk@0.2.117@@@1/sdk-tools.d.ts` — the SDK's tool-input types, generated from the CLI's JSON Schema. Lines 532-541:

```ts
export interface TodoWriteInput {
  /** The updated todo list */
  todos: {
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm: string;
  }[];
}
```

Lines 2462-2480:

```ts
export interface TodoWriteOutput {
  /** The todo list before the update */
  oldTodos: { content: string; status: "pending"|"in_progress"|"completed"; activeForm: string; }[];
  /** The todo list after the update */
  newTodos: { content: string; status: "pending"|"in_progress"|"completed"; activeForm: string; }[];
  verificationNudgeNeeded?: boolean;
}
```

`TodoWriteInput` is in the `ToolInputSchemas` union (`sdk-tools.d.ts:26`), `TodoWriteOutput` in `ToolOutputSchemas` (`:48`).

The zod source of truth inside the binary (offset ~256463171) confirms the same three fields and that both strings are non-empty:

```js
kLb=…Nr(["pending","in_progress","completed"]),
xLb=…Se({content:N().min(1,"Content cannot be empty"),status:kLb(),
        activeForm:N().min(1,"Active form cannot be empty")}),
cwt=…dt(xLb())
```

`var Gz="TodoWrite"` sits at offset 250528100, immediately beside `var Hq="TaskCreate"`.

**`activeForm` is the field a host must not ignore.** Claude's schema is the only one of the three protocols in this note that ships a *second* label for the same step: the imperative `content` ("Add focused tests") and the present-continuous `activeForm` ("Adding focused tests"). The tool's own prompt (offset ~258528689) says: *"Always provide both content (imperative) and activeForm (present continuous)."* The short description variant (`AYb`, offset ~258527000) is worth quoting in full because it is the clearest statement of the contract anywhere:

> "Create and update a task list for the current session. **The list is rendered to the user as your working plan.** — Each todo has `content`, `status` ("pending" | "in_progress" | "completed"), and `activeForm` (present-tense label shown while in progress). — **Send the full list each call; it replaces the previous one.** — Keep one item `in_progress` at a time…"

"Send the full list each call; it replaces the previous one" is the wholesale-rewrite property that §5 has to design around, stated by the vendor.

### 1.2 How a `stream-json` host actually sees it

**There is no dedicated event.** It is an ordinary `assistant` message carrying a `tool_use` block named `TodoWrite`. Evidence:

- `grep -in "todo"` over the SDK's `sdk.d.ts`, `bridge.d.ts`, `assistant.d.ts`, `browser-sdk.d.ts`, `agentSdkTypes.d.ts` returns **zero hits**. The only typed todo surface in the whole SDK is `TodoWriteInput` / `TodoWriteOutput` in `sdk-tools.d.ts`.
- The `SDKMessage` union (`sdk.d.ts:2804`) has 29 members — `SDKAssistantMessage | SDKUserMessage | … | SDKToolProgressMessage | SDKToolUseSummaryMessage | …` — none todo-specific. `SDKAssistantMessage` (`sdk.d.ts:2186`) is `{type:'assistant'; message: BetaMessage; parent_tool_use_id; error?; uuid; session_id}`; `SDKPartialAssistantMessage` (`sdk.d.ts:2855`) is `{type:'stream_event'; event: BetaRawMessageStreamEvent; …}`.
- The binary's stream-json emitter (offset ~268773031) enumerates every event it yields; there is no todo case. There *is* an `@internal` `set_expanded_view` system event with `expanded_view: "none"|"tasks"|"teammates"` (offset 268652371) — but the emitter has `case "set_expanded_view": break;`, so it is **never yielded to a host**.

Live capture (`CLAUDE_CODE_ENABLE_TASKS=false claude -p … --output-format stream-json --verbose`) — exactly two lines carry the state:

```json
{"type":"assistant","message":{"model":"claude-sonnet-5","id":"msg_011Cdr…","type":"message","role":"assistant",
 "content":[{"type":"tool_use","id":"toolu_01D3vTbp…","name":"TodoWrite",
   "input":{"todos":[{"content":"Step one","status":"in_progress","activeForm":"Doing step one"},
                     {"content":"Step two","status":"pending","activeForm":"Doing step two"}]},
   "caller":{"type":"direct"}}]},"parent_tool_use_id":null,"session_id":"…","uuid":"…"}
```

```json
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01D3vTbp…","type":"tool_result",
  "content":"Todos have been modified successfully. …"}]},"parent_tool_use_id":null,
 "tool_use_result":{"oldTodos":[],"newTodos":[{"content":"Step one","status":"in_progress","activeForm":"Doing step one"},…]}}
```

Note the non-standard **`tool_use_result`** sibling on the `user` message carrying `{oldTodos, newTodos}` — typed only as `tool_use_result?: unknown` (`sdk.d.ts` ~2884). It is the same undocumented channel this repo already reads for file changes (`app/src/core/harness/claude.ts:30-38`, whose comment says *"It is undocumented, so it is parsed strictly and pinned by a recorded fixture"*). A host can read either the `tool_use` input or that result; the input arrives earlier.

The official page https://code.claude.com/docs/en/agent-sdk/todo-tracking prescribes exactly this consumption pattern:

```ts
if (message.type === "assistant") {
  for (const block of message.message.content) {
    if (block.type === "tool_use" && block.name === "TodoWrite") {
      const todos = block.input.todos;
```

and, for the in-progress case: `const text = todo.status === "in_progress" ? todo.activeForm : todo.content;`

### 1.3 The Task tools, which are what actually fires now

Same docs page gives the migration shapes:

- `TaskCreate` input `{subject, description, activeForm?, metadata?}`
- `TaskUpdate` input `{taskId, status?, subject?, description?, activeForm?, addBlocks?, addBlockedBy?, owner?, metadata?}`, with `status: "deleted"` to delete
- **the assigned id arrives only in the `tool_result`**, as `{task:{id, subject}}`
- and, verbatim: *the streamed `tool_use` input is the raw model output — key repair (`id`/`task_id`→`taskId`, `active_form`→`activeForm`) happens after the stream, so read defensively.* The repair function is in the binary at offset ~256463000 (`cAn`, with `CLb=["id","task_id"], ALb=["active_form"]`).

This is materially harder to consume than `TodoWrite`: it is **incremental** (create/update deltas) rather than a wholesale snapshot, and the id correlating an update to a create only exists in the result frame. A host must maintain a task map keyed by `taskId` across the Run and project the list itself. T3 Code does exactly that — `context.claudeTasks`, re-deriving the whole plan on each Task tool call (`src-server/src/provider/Layers/ClaudeAdapter.ts:1845-1875`), tagged `explanation: "Claude Tasks"`.

`TaskCreated` and `TaskCompleted` also exist as **hook events** (`HOOK_EVENTS`, `sdk.d.ts:687`).

### 1.4 Hooks

`TodoWrite` is a normal matchable tool name for `PreToolUse`/`PostToolUse` — but this is **not stated in the docs**. https://code.claude.com/docs/en/hooks documents only *"What the matcher filters: **tool name** — Example matcher values: `Bash`, `Edit|Write`, `mcp__.*`"*, and neither that page nor https://code.claude.com/docs/en/hooks-guide contains the string "todo" anywhere. **There are no todo-specific hooks.** The 28 `HOOK_EVENTS` (`sdk.d.ts:687`) are `PreToolUse, PostToolUse, PostToolUseFailure, Notification, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged`.

Verified live with a `PostToolUse` hook matching `TodoWrite`; it fires, with `tool_response` carrying the full diff:

```json
{"hook_event_name":"PostToolUse","tool_name":"TodoWrite",
 "tool_input":{"todos":[{"content":"Alpha","status":"in_progress","activeForm":"Alpha"}]},
 "tool_response":{"oldTodos":[],"newTodos":[{"content":"Alpha","status":"in_progress","activeForm":"Alpha"}]},
 "tool_use_id":"toolu_016DrC…","duration_ms":0,"permission_mode":"acceptEdits"}
```

**But a hook is the wrong mechanism here** and the reason is architectural, not aesthetic: this repo already reads `stream-json` for everything else, a hook would need a second out-of-band transport back into the app, and the tool's `checkPermissions` always returns `{behavior:"allow"}` (offset ~258529900) so there is no permission prompt to piggyback on. Read the stream.

### 1.5 How the CLI renders it — not what folklore says

The familiar `☐`/`☒` checkbox-with-strikethrough rendering is **not** what 2.1.225 does.

- The tool renders nothing of its own: `userFacingName(){return""}` and `renderToolUseMessage(){return null}` (offset ~258529900). There is no "⏺ Update Todos" tool line.
- `☐` (U+2610) and `☒` (U+2612) occur in the binary only twice each (offsets 248878906/248878927, 250161442/250161463), and every occurrence is inside the vendored **`figures`** table (`checkboxOn:"☒", checkboxOff:"☐"`, with Windows fallbacks `[×]`/`[ ]`). Every traced *usage* (offsets 264945743, 264947008) is a config/form field renderer — multi-select and boolean fields — not the todo list. All `strikethrough` hits are in the bundled `ansi-styles`/`chalk`/`yoctocolors` tables.
- What todos actually feed is a unified background-work model. Offset ~265433900:

```js
function X3l(e){ if(!e||e.length===0)return[];
  return e.map((t)=>({id:`todo:${xdt(t.content).toString(36)}`, kind:"todo",
    label:cct(t.status==="in_progress"?t.activeForm:t.content),
    startedAt:t.status==="pending"?void 0:0,
    doneAt:t.status==="completed"?0:void 0})); }
```

Three things to take from those five lines. **(a)** The label rule is exactly the documented one: `activeForm` while in progress, `content` otherwise. **(b)** The item **id is a hash of `content`** — Claude's own answer to "how do you keep identity across a wholesale rewrite" is *key by the step text*. **(c)** Status collapses into two optional timestamps, so pending/in-progress/completed is reconstructed from presence rather than stored as an enum.

That list is then reduced to a counter at offset ~267838600:

```js
let r=t.filter((o)=>o.kind==="todo");
if(r.length>0) return `${br(r,(o)=>o.doneAt!==void 0)}/${r.length}`;
```

— a plain **`done/total`** string. And at offset ~259367943, `if(n.kind==="todo"||n.doneAt!==void 0)continue;` **excludes todos from the background-task summary line**, so the count is the only always-visible trace. The full panel is behind a keybinding action `app:toggleTodos` (offset 265322844) which flips `expandedView` between `"none"` and `"tasks"`.

So Claude Code and Codex independently arrived at the same UI: **a persistent `n/m` count, with the list itself collapsed behind an explicit toggle.**

**UNVERIFIED:** the exact glyphs and ANSI used *inside* the expanded "tasks" panel. Those literals could not be located in the binary; the panel appears to be assembled from generic status components shared with agents and shell jobs.

### 1.6 Other host-relevant mechanics

- **Todo state is per-agent in-memory app state, not a file.** `AppState.todos` is `{[agentId]: Todo[]}` (initialised `todos:{}` at offset 269441222). `~/.claude/todos` appears only in retention-sweep and cleanup allowlists (offsets 263347528, 269712918) and **does not exist on this machine**. Do not build on reading it.
- **When every todo is `completed`, the stored app-state list is cleared to `[]`** while the emitted `newTodos` still carries the full completed list (`call({todos:e})`, offset ~258529900: `let s=e.every((a)=>a.status==="completed")?[]:e`). A host reading the *stream* sees the finished list; the CLI's own indicator empties. §5 says which behaviour to copy.
- **Resume rehydration**: on `--resume` the CLI reconstructs todos by scanning the transcript backwards for the last assistant `tool_use` named `TodoWrite` and zod-parsing `.todos` (function `MTv`, offset ~265385000). Same "latest snapshot wins" rule as everywhere else in this note.
- **A synthetic `todo_reminder` user message** is injected when TodoWrite has not been used for N turns (offset 259287596). It reaches the stream as a user message with `isMeta:true`, text beginning `"The TodoWrite tool hasn't been used recently…"`, optionally followed by `"Here are the existing contents of your todo list:\n\n[1. [pending] …]"`. Gated by `CLAUDE_CODE_TODO_REMINDER_MODE`. **A host that renders every user message will show this to the user as if they had typed it** — filter on `isMeta`.
- TodoWrite is in the CLI's 10-second-timeout set (`eFb`, offset 256680663) and in the read-only/auto-approved tool set `O6S` (offset 261507160), alongside Read/Glob/Grep/Skill/Task*.

---

## 2. Codex: `update_plan` → `turn/plan/updated`

### 2.1 The tool the model is given

`codex-rs/protocol/src/plan_tool.rs` (whole file, verbatim shape):

```rust
// Types for the TODO tool arguments matching codex-vscode/todo-mcp/src/main.rs
#[serde(rename_all = "snake_case")]
pub enum StepStatus { Pending, InProgress, Completed }

#[serde(deny_unknown_fields)]
pub struct PlanItemArg { pub step: String, pub status: StepStatus }

#[serde(deny_unknown_fields)]
pub struct UpdatePlanArgs {
    /// Arguments for the `update_plan` todo/checklist tool (not plan mode).
    #[serde(default)] pub explanation: Option<String>,
    pub plan: Vec<PlanItemArg>,
}
```

Two fields, that is all: an optional `explanation` and a `plan` of `{step, status}`. `deny_unknown_fields` and `additionalProperties: false` mean a host must not invent extra fields.

The tool spec handed to the model is built in `codex-rs/core/src/tools/handlers/plan_spec.rs:8-58` (`create_update_plan_tool()`); the description string at `:44-48` is verbatim:

```
Updates the task plan.
Provide an optional explanation and a list of plan items, each with a step and status.
At most one step can be in_progress at a time.
```

Field descriptions: `step` → *"Task step text."*; `status` → enum `["pending","in_progress","completed"]`, *"Step status."*; `explanation` → *"Optional explanation for this plan update."*; `plan` → *"The list of steps"*. `required: ["plan"]`, `strict: false`. Both the description and the "at most one" sentence were confirmed present in the installed 0.146.0 binary via `strings`.

The handler (`codex-rs/core/src/tools/handlers/plan.rs`) is **fire-and-forget**: tool name `update_plan` (`:56`), refused in Plan mode with *"update_plan is a TODO/checklist tool and is not allowed in Plan mode"* (`:87-91`), emits `EventMsg::PlanUpdate(args)` (`:93-97`), and returns the literal string `"Plan updated"` to the model (`PLAN_UPDATED_MESSAGE`, `:22`). **No plan state is kept server-side.**

### 2.2 What the system prompt promises the user

`codex-rs/protocol/src/prompts/base_instructions/default.md` matters because it tells you what a host is expected to do:

- `:54` — *"You have access to an `update_plan` tool which tracks steps and progress and renders them to the user…"*
- `:58` — *"Do not repeat the full contents of the plan after an `update_plan` call — **the harness already displays it**. Instead, summarize the change made…"*
- `:271` — *"call `update_plan` with a short list of 1-sentence steps (no more than 5-7 words each)"*
- `:273` — *"There should always be **exactly one** `in_progress` step until everything is done. You can mark multiple items as complete in a single `update_plan` call."*
- `:275` — *"If all steps are complete, ensure you call `update_plan` to mark all steps as `completed`."*

The 0.146.0 binary carries a stricter GPT-5.2 variant (verified via `strings` on the binary): *"Maintain statuses in the tool: exactly one item in_progress at a time; mark items complete when done; post timely status transitions. Do not jump an item from pending to completed: always set it to in_progress first. Do not batch-complete multiple items after the fact. Finish with all items completed or explicitly canceled/deferred before ending the turn."*

Note the disagreement: the **tool schema** says *at most one* `in_progress`; the **prompt** says *exactly one*. A host must tolerate zero and must tolerate more than one, because only the prompt — not the schema — forbids it. And the prompt explicitly tells the model not to restate the plan in prose **because the host is displaying it** — so a host that swallows `turn/plan/updated` (as this repo does today, §6.1) leaves the user with strictly less information than Codex assumed.

The first-party cookbook says the same, and calls `update_plan` a TODO tool outright — https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide, "Plan tool" section: *"Plan closure: Before finishing, reconcile every previously stated intention/TODO/plan. Mark each as Done, Blocked (with a one-sentence reason and a targeted question), or Cancelled (with a reason). Do not end with in_progress/pending items. … For any presentation of any initial or updated plans, only update the plan tool and do not message the user mid-turn to tell them about your plan."* It lists `todo_write/update_plan` among default solver tools, described as *"our default TODO tool"*.

**The user-facing docs do not document this at all.** `developers.openai.com/codex/*` now 308-redirects to `learn.chatgpt.com/docs/*`, and neither `learn.chatgpt.com/docs/codex/cli` nor the config-file pages mention `update_plan`, the plan tool, or todo display. The cookbook is the only first-party prose.

### 2.3 What reaches a host on the app-server wire

`EventMsg::PlanUpdate` is converted at `codex-rs/app-server/src/bespoke_event_handling.rs:1246-1265` into the `turn/plan/updated` notification. Method-name table: `codex-rs/app-server-protocol/src/protocol/common.rs:1717` → `TurnPlanUpdated => "turn/plan/updated" (v2::TurnPlanUpdatedNotification)`.

The generated schema from **this machine's binary** (`codex app-server generate-json-schema --experimental --out …`, `codex_app_server_protocol.v2.schemas.json`):

```json
"TurnPlanUpdatedNotification": {
  "type": "object", "required": ["plan","threadId","turnId"],
  "properties": {
    "explanation": {"type": ["string","null"]},
    "plan": {"type":"array","items":{"$ref":"#/definitions/TurnPlanStep"}},
    "threadId": {"type":"string"}, "turnId": {"type":"string"}}}
"TurnPlanStep": {"type":"object","required":["status","step"],
  "properties":{"status":{"$ref":"#/definitions/TurnPlanStepStatus"},"step":{"type":"string"}}}
"TurnPlanStepStatus": {"type":"string","enum":["pending","inProgress","completed"]}
```

This repo's generated bindings already match exactly:

- `app/src/core/harness/codex-protocol/v2/TurnPlanStep.ts:6` — `{ step: string, status: TurnPlanStepStatus }`
- `app/src/core/harness/codex-protocol/v2/TurnPlanStepStatus.ts:5` — `"pending" | "inProgress" | "completed"`
- `app/src/core/harness/codex-protocol/v2/TurnPlanUpdatedNotification.ts:6` — `{ threadId, turnId, explanation: string | null, plan: TurnPlanStep[] }`
- `app/src/core/harness/codex-protocol/ServerNotification.ts:79` — `{ "method": "turn/plan/updated", "params": TurnPlanUpdatedNotification }`

**Wire-format asymmetry worth writing down.** The *tool arguments the model emits* are snake_case (`in_progress`); the *app-server notification* re-serialises to camelCase (`inProgress`). The conversion is `impl From<CorePlanItemArg> for TurnPlanStep` at `codex-rs/app-server-protocol/src/protocol/v2/turn.rs:450-465`; the types themselves are at `:426`, `:436`, `:443`, all `#[serde(rename_all = "camelCase")]`. A normalizer that reads both spellings costs nothing and survives whichever surface it is pointed at.

### 2.4 Not persisted — a host must cache it

`codex-rs/rollout/src/policy.rs`, `should_persist_event_msg`: `EventMsg::PlanUpdate(_)` sits at `:167`, inside the arm commented *"Transient, non-durable events."* (`:122`), falling through to `=> false` at `:182`.

**Consequence:** a host resuming a Codex thread cannot recover the current plan from the rollout. If you want the plan to survive a restart, *you* have to store it. This is the single most important integration fact in §2.

Do not confuse this with `TurnItem::Plan` / `ThreadItem::Plan { id, text }` (`codex-rs/app-server-protocol/src/protocol/v2/item.rs:254`, mapping at `:834`; core enum `codex-rs/protocol/src/items.rs:48`). That is **Plan mode** — streamed Markdown, marked EXPERIMENTAL — and it *is* persisted (`policy.rs:90` special-cases it). `PlanDeltaNotification` / `item/plan/delta` belong to plan mode too:

```ts
// app/src/core/harness/codex-protocol/v2/PlanDeltaNotification.ts:5-9
/** EXPERIMENTAL - proposed plan streaming deltas for plan items. Clients should
 *  not assume concatenated deltas match the completed plan item content. */
export type PlanDeltaNotification = { threadId: string, turnId: string, itemId: string, delta: string, }
```

**UNVERIFIED:** whether any code path emits `item/plan/delta` for `update_plan` output. Nothing found in the Rust tree does; the reading is that it is plan-mode-only.

### 2.5 Per-turn or cumulative?

Each notification carries `turnId` and is a **full snapshot** — the model resends every step on every call; there is no server-side accumulation. The TUI treats plan state as per-turn (`saw_plan_update_this_turn` and `plan_delta_buffer` are cleared in `reset_turn_flags()`, `codex-rs/tui/src/chatwidget/transcript.rs:58-67`), but core never resets anything: if the model simply does not call `update_plan` in turn N+1, no notification arrives and a host keeps whatever it last saw.

The correct host rule is therefore **"latest snapshot wins, keyed by thread; `turnId` is informational."** Notably, `last_plan_progress` — the counter behind the terminal title — is *not* reset per turn either (`codex-rs/tui/src/chatwidget/turn_runtime.rs:509`), which is Codex itself making the same call.

### 2.6 How Codex renders it

**TUI** — `codex-rs/tui/src/history_cell/plans.rs`, `PlanUpdateCell` (`:170`), `impl HistoryCell` (`:175`). The symbol/style table verbatim, `:186-192`:

```rust
let (box_str, step_style) = match status {
    StepStatus::Completed  => ("✔ ", Style::default().crossed_out().dim()),
    StepStatus::InProgress => ("□ ", Style::default().cyan().bold()),
    StepStatus::Pending    => ("□ ", Style::default().dim()),
};
```

- Header, `:204`: `lines.push(vec!["• ".dim(), "Updated Plan".bold()].into());`
- `explanation` rendered `dim().italic()` above the steps (`:178-185`, `:207-214`).
- Empty plan → `"(no steps provided)"`, dim italic (`:218`).
- Body indented with a tree prefix, `:224`: `prefix_lines(indented_lines, "  └ ".dim(), "    ".into())`.
- Wrapping at width − 4, continuation indent two spaces (`:194-196`).
- Plain-text/transcript form (`:229-246`): header `Updated Plan`, then `format!("{status:?}: {step}")` per step.

The actual rendered output, from the checked-in insta snapshot
`codex-rs/tui/src/history_cell/snapshots/codex_tui__history_cell__tests__plan_update_without_note_snapshot.snap`:

```
• Updated Plan
  └ □ Define error taxonomy
    □ Implement mapping to user messages
```

Three design decisions are visible and all three are deliberate:

1. **Completed steps are struck through and dimmed, not removed.** The list stays the same length.
2. **In-progress is distinguished by weight and colour, not by a different glyph** — `□` for both pending and in-progress; only `crossed_out().dim()` vs `cyan().bold()` vs `dim()` separate the three.
3. **No collapsing, and no in-place replacement.** `codex-rs/tui/src/chatwidget/turn_runtime.rs:498-512` (`on_plan_update`) ends with `self.add_to_history(history_cell::new_plan_update(update));` — every `update_plan` call **appends a new "Updated Plan" block** to scrollback. A terminal has no other option; a GUI does, and this is the one Codex choice not to copy (§5).

The only aggregated state is a `(completed, total)` counter kept for the **terminal title**: `last_plan_progress` (`turn_runtime.rs:509`), consumed by `codex-rs/tui/src/chatwidget/status_surfaces.rs:972-979` → `format!("Tasks {completed}/{total}")`. **Codex's own answer to "where does the persistent progress indicator live" is: outside the transcript, in the window chrome, as `n/m`.**

Non-interactive `codex exec` uses different symbols — `codex-rs/exec/src/event_processor_with_human_output.rs:340-361`: explanation in italic, then `✓` green / `→` cyan / `•` dim, two-space indent, printed to **stderr**.

Notification → TUI conversion (camelCase back to the core enum) is `codex-rs/tui/src/chatwidget/protocol.rs:101-113`.

> Line numbers in the Rust tree are at `main@646f7c0a`, ~9 days newer than the 0.146.0 binary. The tool description, the "exactly one in_progress" prompt text, `Updated Plan`, and `(no steps provided)` were each re-verified inside the 0.146.0 binary with `strings`. **TUI line numbers specifically are UNVERIFIED against 0.146.0.**

---

## 3. ChatGPT / OpenAI web

**Access caveat, stated first because it bounds confidence.** `openai.com`, `help.openai.com` and `platform.openai.com` return 403 to direct fetching from this environment (Cloudflare). What was read byte-for-byte: OpenAI's own CDN-hosted PDFs (`cdn.openai.com`) and the official `openai/openai-openapi` spec repository. The HTML pages were read through a text-extraction proxy rendering the first-party URLs; the *content* is OpenAI-authored, but that layer could not be verified byte-for-byte. Quotes below are marked accordingly by which source they came from.

### 3.1 ChatGPT agent — narration, not a plan

https://openai.com/index/introducing-chatgpt-agent/ (via proxy):

> "As it performs your task, an **on-screen narration** provides visibility into exactly what ChatGPT is doing. You can interrupt and take control of the browser whenever needed…"

> "If a task takes longer than anticipated or feels stuck, you can pause it, **ask it for a progress summary**, or stop it entirely and receive partial results."

Note the shape: narration plus an *on-demand* progress summary. A summary the user has to ask for is not a plan widget.

The help article https://help.openai.com/en/articles/11752874-chatgpt-agent describes the virtual-browser screenshots, takeover mode, watch mode, confirmations and source links — and contains **no description of a plan, step list, todo list, or activity pane**. That is an explicit negative finding.

The system card (read byte-for-byte from https://cdn.openai.com/pdf/839e66fc-602c-48bf-81d3-b21eacc3459d/chatgpt_agent_system_card.pdf) confirms the trajectory is a user-visible surface, but only as a safety concern:

> "Leaking harmful info via Visible Trajectory: In some circumstances, users could see disallowed biorisk information briefly appear outside a final answer, such as in a **chain of thought summary or an agent's trajectory**…"

**UNVERIFIED:** the search index suggests the ChatGPT agent help article now carries a deprecation banner pointing to ChatGPT Work / "Using cloud browser in ChatGPT"; the live page could not be fetched (403) and the proxy served a pre-banner version. The successor article (https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt) documents approvals, screenshots and stopping — again **no plan/step UI**.

### 3.2 Deep research — the one documented plan UI OpenAI has

https://openai.com/index/introducing-deep-research/, verified byte-for-byte against OpenAI's own PDF at https://cdn.openai.com/API/docs/deep_research_blog.pdf:

> "Once it starts running, **a sidebar appears with a summary of the steps taken and sources used**."

https://help.openai.com/en/articles/10500283-deep-research-faq (via proxy) is the strongest plan-UI documentation OpenAI publishes anywhere:

> "3. ChatGPT creates a **proposed research plan. You can review and modify it before the research begins.**
> 4. You can follow progress as it runs and interrupt at any time to refine the focus…"

> "Completed research opens in a fullscreen report view… including: A table of contents… A sources used section… **An activity history showing how the research progressed**"

> "What controls do I have while research is running?" — "You can **edit the research plan before it kicks off**, view progress in real time, interrupt the research to adjust focus…"

So deep research has all three: a pre-flight *editable* plan, a live progress sidebar, and a post-hoc activity history. It is the only OpenAI product for which any of that is documented — and note that its editable plan is **plan mode**, not a checklist; the sidebar is "steps taken and sources used", i.e. a log.

### 3.3 Codex cloud — logs, summary, diff; no plan display

https://openai.com/index/introducing-codex/ (via proxy):

> "Task completion typically takes between 1 and 30 minutes… and you can **monitor Codex's progress in real time**."
> "Codex provides verifiable evidence of its actions through **citations of terminal logs and test outputs**…"

https://developers.openai.com/codex/cloud: *"You can watch the task logs or let the task run in the background."* / *"Review the summary and diff."*

The surfaced units are logs, citations, summary, diff. **No first-party description of a plan or todo list in the Codex cloud UI**, despite `update_plan` being a core CLI mechanism (§2). Another explicit negative.

### 3.4 The API side — an explicit negative

From OpenAI's own OpenAPI spec (https://github.com/openai/openai-openapi, `openapi.yaml`), the Responses API `OutputItem` union is exactly:

`OutputMessage, FileSearchToolCall, FunctionToolCall, FunctionToolCallOutputResource, WebSearchToolCall, ComputerToolCall, ComputerToolCallOutputResource, ReasoningItem, Program, ProgramOutput, ToolSearchCall, ToolSearchOutput, AdditionalTools, CompactionBody, ImageGenToolCall, CodeInterpreterToolCall, LocalShellToolCall, LocalShellToolCallOutput, FunctionShellCall, FunctionShellCallOutput, ApplyPatchToolCall, ApplyPatchToolCallOutput, MCPToolCall, MCPListTools, MCPApprovalRequest, MCPApprovalResponseResource, CustomToolCall, CustomToolCallOutputResource`

**There is no plan, todo, checklist, task or step item type.** A grep for `todo|plan_item|task_list|checklist` across the spec returns only Go SDK `context.TODO()` boilerplate. All a UI can render for progress is `ReasoningItem.summary`, per-item `status` fields, and `WebSearchToolCall.action` (`search`/`open_page`/`find_in_page`) — the primitives behind "Searching for X" chips.

The one plan-shaped thing OpenAI ships in an API is in **ChatKit**, not Responses: the beta thread-item union includes `chatkit.task` (*"Task emitted by the workflow to show progress and status updates"*, with `task_type: custom|thought`, `heading`, `summary`) and `chatkit.task_group`. But it has **no completion state and no ordering semantics** — it is a progress log, not a mutable plan.

### 3.5 What §3 is worth

| Product | Plan artifact | Progress narration | Persistent pane |
| --- | --- | --- | --- |
| ChatGPT agent | not documented | yes — narration + on-demand summary | not documented |
| Deep research | **yes — editable pre-flight plan** | yes | yes — sidebar of steps + sources; post-hoc activity history |
| Codex cloud | not documented | yes — real-time logs | logs / summary / diff |
| Responses API | **none exists** | `reasoning.summary`, tool-call `status` | n/a |
| ChatKit API | `chatkit.task` / `task_group` (log, not plan) | same | same |

For this app's purposes §3 is mostly a **negative result, and that is useful**: OpenAI's consumer surfaces do not ship the checklist indicator that its own CLI does. The design precedent worth borrowing is narrow and specific — deep research's *sidebar of steps taken, running alongside the answer rather than inside it* — and it is a log of the past, not a forecast of the remaining work. Everything in §5 about *remaining* steps is grounded in Codex, Claude Code and T3 Code, not here.

---

## 4. T3 Code: the only host studied that already solved this

T3 Code is the most useful source in this note, because it is a **multi-harness host with the same problem this repo has**, it is installed here, and it ships its own TypeScript in source maps.

### 4.1 One canonical event, five harness-native inputs

`src-server/packages/contracts/src/providerRuntime.ts`:

- `:165` — `"turn.plan.updated"` in `ProviderRuntimeEventType`
- `:75` — `const RuntimePlanStepStatus = Schema.Literals(["pending", "inProgress", "completed"])`
- `:377-387` — `RuntimePlanStep = Schema.Struct({ step, status })`, `TurnPlanUpdatedPayload = Schema.Struct({ explanation?, plan: Schema.Array(RuntimePlanStep) })`
- `:736-741` — `ProviderRuntimeTurnPlanUpdatedEvent`

The canonical shape is therefore **exactly Codex's**: `{ plan: {step, status: "pending"|"inProgress"|"completed"}[], explanation?: string }`. T3 adopted the Codex spelling (`inProgress`) as its internal one and normalises everything else into it.

Five adapters feed it:

| Harness | Source | Where |
| --- | --- | --- |
| Claude Code | `TodoWrite` tool input | `src-server/src/provider/Layers/ClaudeAdapter.ts:664, 673-690, 2223-2245` |
| Claude Code | `TaskCreate`/`TaskUpdate`/`TaskList` tools | `ClaudeAdapter.ts:695-697, 737, 818, 1845-1875, 2449` |
| Codex | `turn/plan/updated` notification | `src-server/src/provider/Layers/CodexAdapter.ts:800-819` |
| ACP (Grok, Cursor) | ACP `plan` session update | `src-server/src/provider/acp/AcpRuntimeModel.ts:527-542` |
| Cursor | custom `params.todos` extension | `src-server/src/provider/acp/CursorAcpExtension.ts:89-110` |

`src-server/src/provider/Layers/OpenCodeAdapter.ts` does **not** participate: its only case-insensitive "plan" match is `:1461`, `input.interactionMode === "plan"`, unrelated.

### 4.2 The Claude mapping, in full

```ts
// ClaudeAdapter.ts:664
function isTodoTool(toolName: string): boolean {
  return toolName.toLowerCase().includes("todowrite");
}
// ClaudeAdapter.ts:673-674
function extractPlanStepsFromTodoInput(input: Record<string, unknown>): PlanStep[] | null {
  // TodoWrite format: { todos: [{ content, status, activeForm? }] }
```

`todo.content` → `step` (fallback to the literal `"Task"` when empty); `completed` → `completed`, `in_progress` → `inProgress`, everything else → `pending` (`:681-690`).

Two things to note. First, **`activeForm` is parsed and discarded** — it appears in T3's own code exactly once, in that comment at `:674`. Second, and more interesting: the plan update fires from **streaming partial tool input**, not from the tool result — `:2223-2245`, inside the `input_json_delta` handler:

```ts
// Emit plan update when TodoWrite input is parsed
if (parsedInput && isTodoTool(nextTool.toolName)) {
  const planSteps = extractPlanStepsFromTodoInput(parsedInput);
  ...offerRuntimeEvent({ type: "turn.plan.updated", ... payload: { plan: planSteps } })
```

That is a latency choice: the checklist updates as the model *writes* the tool call, not when the tool returns. It is only available to a host reading partial JSON deltas.

The Codex mapping (`CodexAdapter.ts:800-819`) decodes `V2TurnPlanUpdatedNotification`, trims each `step` (fallback `"step"`), and passes `status` through only if it is already `completed`/`inProgress`, else `pending`. Cursor's extension (`CursorAcpExtension.ts:89-110`) reads `content ?? title` and accepts **both** `in_progress` and `inProgress` — evidence that tolerating both spellings is what real integrations end up doing.

### 4.3 Storage — an activity row, not a table

Ingestion turns the runtime event into a thread activity: `src-server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:432-449` → `{ tone: "info", kind: "turn.plan.updated", summary: "Plan updated", payload: { plan, explanation? } }`, stored in `projection_thread_activities` (`activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence`), projected from `orchestration_events` rows of `event_type = 'thread.activity-appended'`.

Read-only census from this machine's `~/.t3/userdata/state.sqlite`:

```
context-window.updated 389 | tool.started 351 | tool.completed 351 | tool.updated 234
task.updated 32 | checkpoint.captured 27 | turn.plan.updated 5 | task.started 4
task.progress 4 | runtime.error 1
```

and a real `payload_json` (from a Claude Code session in *this* repo — i.e. observed `TodoWrite` pass-through, end to end):

```json
{"plan":[{"step":"Read the integration spec, domain context, ADRs, and existing architecture","status":"completed"},
         {"step":"Add focused tests at the integration seams and implement the GitHub workflow","status":"inProgress"},
         ...],
 "explanation":"The user confirmed both the product decision and the TDD seams."}
```

**Frequency is the headline number.** 5 plan updates against 351 tool starts, in the same corpus. A todo list is a rare, low-frequency, high-signal event — roughly 1.4% of the tool traffic. That justifies a very different treatment from the per-tool activity stream: it is cheap to keep, cheap to redraw, and worth a permanent surface.

The contract exposes `payload` as `Schema.Unknown` (`src-server/packages/contracts/src/orchestration.ts:313-323`, streamed as `ThreadActivityAppendedPayload` at `:1104-1107`), so the `{plan}` shape is not schema-enforced on the wire and T3's own renderer re-validates it defensively. Any host must do the same.

### 4.4 The derivation rule — and why it matters

`src-web/src/session-logic.ts:510-560`, `deriveActivePlanState()`:

```ts
const allPlanActivities = ordered.filter((activity) => activity.kind === "turn.plan.updated");
// Prefer plan from the current turn; fall back to the most recent plan from any turn
// so that TodoWrite tasks persist across follow-up messages.
```

It then re-validates each entry defensively — drops entries whose `step` is not a string, coerces any unrecognised `status` to `pending` — and returns `null` when zero valid steps survive.

**"Latest plan wins, falling back across turns"** is exactly the rule §2.5 derived independently from the Codex source. Two implementations converging on it from opposite directions is about as strong as a design signal gets here. It exists because `TodoWrite` re-sends the whole list on every call rather than deltas, and because an agent that finishes a turn without touching the list has not thereby abandoned it.

### 4.5 How T3 renders it

`src-web/src/components/PlanSidebar.tsx` (284 lines), mounted from `ChatView.tsx:82, 145, 1222, 1292` and `RightPanelTabs.tsx`.

`stepStatusIcon()` at `:36-56`:

| status | glyph | container |
| --- | --- | --- |
| `completed` | `CheckIcon` | `size-5` circle, `bg-success/10 text-success-foreground` |
| `inProgress` | `LoaderIcon className="animate-spin"` | `size-5` circle, `bg-primary/10 text-primary` |
| `pending` | a `size-1.5` dot | `size-5` circle, `border-border/60 bg-muted/30` |

Row and text treatment, `:211-233`:

```tsx
step.status === "inProgress" && "bg-blue-500/5",
step.status === "completed" && "bg-emerald-500/5",
…
step.status === "completed"
  ? "text-muted-foreground/50 line-through decoration-muted-foreground/20"
  : step.status === "inProgress" ? "text-foreground/90" : "text-muted-foreground/70",
```

with `transition-colors duration-200` on the row. `explanation` renders as a muted paragraph above the list (`:199-203`); the list is preceded by a small uppercase `Steps` label (`:207-210`).

Notable choices:

- **A sidebar, not an inline transcript block** — the opposite of the Codex TUI, and the only choice available to a host that wants one surface rather than n appended blocks. There is a `settings.autoOpenPlanSidebar` preference (`ChatView.tsx`), and a responsive `mode: "sheet" | "sidebar" | "embedded"` switch.
- **Same three-way visual language as Codex**: strike-through + dim for done, accent + motion for current, muted for pending.
- **No `n/m` count anywhere.** T3 shows the list and nothing else; Codex shows `Tasks n/m` but only in the terminal title. Neither shows both. Nobody shows a progress *bar*.
- **A real defect worth not copying:** the row key is `` `${step.status}:${step.step}` `` (`:212`). The key changes the moment a step's status changes, so React unmounts and remounts the row instead of transitioning it — which throws away the `transition-colors duration-200` on the exact transition it was written for. Key by step **text** (or index), never by anything that changes.

### 4.6 T3's separate plan-mode pipeline (for contrast)

Do not conflate. Plan-mode output is `turn.proposed.delta` / `turn.proposed.completed` (`providerRuntime.ts:166-167`) with payload `{ planMarkdown }` — free-form Markdown, no steps, no statuses. Claude's source is `ExitPlanMode` (`ClaudeAdapter.ts:1800-1842`), Cursor's is `extractPlanMarkdown` (`CursorAcpExtension.ts:85-87`). It gets its own SQLite table, `projection_thread_proposed_plans (plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at, implemented_at, implementation_thread_id)`, plus `projection_threads.has_actionable_proposed_plan` and `projection_turns.source_proposed_plan_id`. `PlanSidebar` renders both, with copy / download / save-to-workspace actions for the Markdown one.

So the durable thing gets a table; the ephemeral checklist gets an activity row. That split is the right one and this repo should make the same one.

### 4.7 Evidenced negatives

- `planStep` (6 hits in `bin.mjs`) and `checklist` (1) occur only as substrings of `PlanStep` / the Codex instructions prose.
- `plan_update` as a wire name: 0 hits. `PlanUpdate` hits are all TS identifiers (`AcpPlanUpdate`, `TurnPlanUpdatedType`).
- `activeForm` appears in T3's own code exactly once, in the comment at `ClaudeAdapter.ts:674`. Not stored, not emitted, not rendered. Every other hit is `parse5`'s `activeFormattingElements`.
- No todo/plan-step table exists in `state.sqlite`. Checklist state lives entirely inside `payload_json`.

---

## 5. Display: what the real clients do, and what this app should do

### 5.0 The convergent facts

Five independent implementations agree on these, and they are the constraints any design here inherits:

1. **The list is a wholesale snapshot, not a delta.** Claude's own tool description: *"Send the full list each call; it replaces the previous one."* Codex resends every step on every `update_plan`. (The exception is Claude's newer Task tools, §1.3, which *are* incremental — a host must project them into a snapshot itself.)
2. **Three states, and only three.** `pending | in_progress | completed` everywhere, modulo spelling.
3. **Exactly one in progress**, by prompt convention rather than by schema. A host must tolerate zero and more than one anyway.
4. **It is rare.** 5 plan updates against 351 tool starts in T3's live DB (§4.3) — ~1.4% of tool traffic. This is not a high-frequency stream.
5. **Nobody renders a progress bar.** Codex and Claude both render an `n/m` count; T3 renders neither.
6. **Everyone strikes through completed steps rather than removing them.** Codex `crossed_out().dim()`; T3 `line-through text-muted-foreground/50`.
7. **Identity across a rewrite is the step text.** Claude hashes `content` into the item id (§1.5); T3 keys rows by step text (and gets it wrong by also including status, §4.5).

### 5.1 Where it lives: the shape of the answer

| Client | Placement | Always-visible trace | Expanded form |
| --- | --- | --- | --- |
| Codex TUI | new block appended to scrollback per update | `Tasks n/m` in the **terminal title** | the appended block itself |
| Claude Code TUI | not in the transcript at all | `done/total` counter | panel behind `app:toggleTodos` |
| T3 Code | right sidebar / sheet | none | the full list, always |
| Deep research | sidebar beside the answer | — | steps taken + sources |

**Recommendation: a collapsed one-line indicator in the Run's live footer, expanding in place; not a new dock, and not a block per update.**

The reasoning is this repo's own, from `SubagentDock.tsx:1-24`. The dock exists because subagents *"report themselves many times a minute, and threading each report into the transcript would bury the prose the transcript is for."* That justification does not transfer: a todo list updates a handful of times per Run. Adding a second dock for a 1.4%-frequency event would spend the app's most expensive layout real estate on its rarest signal, and would put two competing collapsible right-hand surfaces on screen at once.

The natural home already exists: `RunWorkingIndicator` in `app/src/renderer/src/components/Conversation.tsx:1513-1556`, documented as *"the composing orb, the current step shimmering as it streams, and how long the Run has been at it. One quiet row rather than a panel."* That row today shows *the last command or write* as "the current step". **A todo list is a strictly better answer to the same question**, and it is the same question: what is it doing now?

Concretely:

```
◐  Adding focused tests at the integration seams        3/7   1m 24s   ⌄
```

- The orb, elapsed time and single-row discipline are unchanged.
- The shimmering "current step" text becomes the `in_progress` step's **`activeForm`** when Claude supplies one, its `content` otherwise, and Codex's `step` otherwise. Falls back to today's command/write sentence when there is no plan — which is most Runs.
- `3/7` is the count, exactly as both TUIs compute it (`doneAt !== undefined` / `last_plan_progress`).
- The chevron expands the full list **in place**, pushing the transcript up rather than overlaying it. Default collapsed; sticky per Session, not per Run.

**Do not append a block per update.** Codex does this only because a terminal cannot mutate scrollback. A GUI can, and a Run with six `update_plan` calls would otherwise produce six near-identical "Updated Plan" blocks — the transcript becomes a diff log of a list instead of a record of work. *This is the one Codex behaviour to deliberately reject.*

**Do write one durable entry when the Run ends.** The live indicator disappears with the Run; the record of what the agent set out to do, and what it finished, is worth re-reading — the same argument `shared/conversation.ts:623-632` makes for keeping subagents durable. One entry per Run holding the final list, not one per update.

### 5.2 Row treatment

Follow the convergent language; both real clients already agree and there is no reason to invent:

| state | mark | text |
| --- | --- | --- |
| `completed` | check, muted | struck through, muted |
| `in_progress` | this repo's `Spinner` (`Conversation.tsx:1500-1511`) | normal weight, foreground, `shimmer` while the Run is live |
| `pending` | empty ring | muted |

Two repo-specific constraints. First, `SubagentDock.tsx:56-60` states the house rule outright: *"Colouring them apart would spend this app's roles — green is an addition, red is a deletion or a failure."* So **completed steps must not be green.** Struck-through and muted carries it; T3's `bg-emerald-500/5` does not belong here. Use `text-status-running` for the in-progress mark, which is already the product's one brand-colour use for "in flight".

Second, `SubagentDock.tsx:21-24` states: *"There is deliberately no progress bar… a bar advancing on elapsed time would be inventing a denominator."* A todo list is the one case where the denominator is **not** invented — the agent named it. `3/7` is honest. A *bar* is still wrong, because the steps are not equal-sized and step 7 may be 80% of the work; the count is honest and the bar implies a rate. **Count, never bar.**

### 5.3 Handling the wholesale rewrite

This is where implementations go wrong, so it is worth being exact.

**Key rows by step text, never by index and never by anything containing status.** Claude hashes `content` (offset ~265433900); T3 keys by `` `${status}:${step}` `` (`PlanSidebar.tsx:212`) and thereby remounts every row the instant its status changes — destroying the `transition-colors duration-200` written for exactly that transition. Copy Claude's rule, not T3's.

For duplicate step texts, disambiguate with an occurrence ordinal (`text#2`) rather than falling back to index; index-keying makes an inserted step at position 2 re-key everything after it.

**Diff by identity, then animate only the transitions:**

- *Same text, new status* → same row, animate the mark and the text treatment. This is the overwhelmingly common case and must never flicker.
- *New text* → row enters. Fade + height, ~150ms.
- *Text gone* → row leaves. Agents do reword steps mid-Run, and a reword reads as a delete plus an insert; a short leave animation keeps that from looking like a glitch.
- *Reordering* → do not animate position. Agents reorder rarely and a moving list is harder to read than a jumping one.

**Do not clear the list when everything completes.** Claude's CLI does (§1.6: the stored list is emptied when every todo is `completed`, though the *stream* still carries the full list). Copying that would make the indicator vanish at the exact moment the user wants to see `7/7`. Keep the completed list, show `7/7`, let it fade with the Run.

**"Latest snapshot wins, keyed by Session — not per Run."** This is the rule §2.5 derived from Codex's source and §4.4 found T3 had already implemented, with the comment *"so that TodoWrite tasks persist across follow-up messages."* An agent that does not touch the list on turn N+1 has not abandoned it. Reset only on an explicit new list.

**Ignore an empty list.** Both `TodoWrite` with `todos: []` and Codex's `(no steps provided)` occur. Treat zero valid steps as "no plan", not as "a plan of nothing" — T3's `deriveActivePlanState` returns `null` in exactly that case.

**Throttle nothing.** At ~1.4% of tool traffic there is no reason to coalesce. The one exception is Claude's Task tools, where a burst of `TaskCreate` calls arrives as several frames in a row; coalesce those to one paint, which this repo's read model already does through `requestPaint` (`selected-conversation-read-model.ts:52-53`).

### 5.4 Accessibility

- The expanded list is `<ol>` — the steps are ordered, and `role="list"` on a `div` is a workaround for a case that does not apply here.
- Each row carries its state in text, not in colour alone: a visually-hidden `Done` / `In progress` / `Not started` inside the row, with the mark `aria-hidden`. This is the pattern `SubagentDock.tsx:75-88` already uses (`StatusMark` renders its `STATUS_TEXT` as real text beside an `aria-hidden` dot).
- **`aria-live` on the collapsed row only, `polite`, and only its summary.** Announcing seven rows on every update is unusable. Announce the shape the row already shows: `"Step 3 of 7: adding focused tests"`. The expanded list must **not** be a live region — a user who has expanded it is reading it.
- Respect `prefers-reduced-motion`: `motion-reduce:animate-none` on the spinner and the shimmer, as `SubagentDock.tsx:82` and `Conversation.tsx:1508` already do. Row enter/leave should collapse to instant under reduced motion.
- The disclosure is a real `<button aria-expanded aria-controls>`, keyboard-reachable in transcript order.

### 5.5 What not to build

- **A second dock.** §5.1.
- **A progress bar.** §5.2.
- **A block per update in the transcript.** §5.1.
- **An editable plan.** Deep research is the only product that offers one (§3.2) and it is a pre-flight *plan-mode* artifact, not a live checklist. Neither harness accepts an edited checklist back: Codex's `update_plan` handler is fire-and-forget with no inbound path (§2.1), and Claude's TodoWrite is model-owned app state (§1.6). An editable checklist would be a control that silently does nothing.
- **A durable, cross-Session plan object.** That is a different and much larger idea, argued in `.scratch/research/agent-conversation-ux-comparison.md` §5. This indicator is deliberately the small version: it shows what the harness already says.

---

## 6. Integration into this repo

### 6.1 Where the events enter today — and where they are dropped

Both harnesses already deliver everything needed, and this repo currently discards both.

**Codex.** `turn/plan/updated` and `item/plan/delta` are both listed in `IGNORED_METHODS` at `app/src/core/harness/codex.ts:182` and `:186`, under a comment describing that set as *"Protocol this Adapter understands and deliberately shows nothing for, so genuinely unknown protocol stays distinguishable from what was skipped."* Separately, `case 'plan':` and `case 'todoList':` at `codex.ts:657-658` return `[]`. Note that `todoList` is **not** a variant of the generated `ThreadItem` union (`codex-protocol/v2/ThreadItem.ts` lists 18 variants and `todoList` is not among them) — it is a defensive case for a name the current binary does not emit. `case 'plan'` **is** real, and is plan mode (§2.4), not the checklist.

The generated bindings are already correct and already imported: `ServerNotification.ts:79` carries `{ "method": "turn/plan/updated", "params": TurnPlanUpdatedNotification }`.

**Claude.** A `TodoWrite` tool_use falls through `describeAssistant` (`app/src/core/harness/claude.ts:436-461`) to the generic branch and becomes `{type:'tool', name:'TodoWrite', summary:'Called Claude tool TodoWrite'}` with no `path`. `core/conversation.ts:1260-1263` then drops it: *"A tool call that read a file is a step of the Run's record; one that names no file stays in the sanitized activity stream only."* So today the user sees, at most, one line in the sanitized activity log saying a tool was called — and only when a Run ends badly (`Conversation.tsx:2514`).

The block's `input` is already captured — `contentBlockSchema` has `input: z.unknown().optional()` at `claude.ts:26` — so no schema change is needed to reach the payload.

**Neither fixture contains a plan.** `grep -ci todowrite` over `app/src/core/harness/fixtures/*.jsonl` returns 0 for every file, and the Codex fixture contains no `plan` method. New recordings are required before any of this can be tested against reality, per `docs/agents/codex-protocol.md` (`pnpm codex:record`).

### 6.2 The normalized event

One new `HarnessEvent` variant in `app/src/shared/conversation.ts`, beside `subagent`. It should be modelled on `subagent` deliberately, because it makes the identical bargain — the comment at `:198-202` already articulates it:

> "The whole state travels every time, so a later event supersedes an earlier one and nothing has to be assembled from a sequence of deltas — the same bargain `command` makes, for the same reason: the Harnesses report a subagent by repeatedly describing it, not by describing what changed."

That is precisely the todo contract, and the sentence needs no editing to apply.

```ts
/** What a step of the agent's plan is: not started, being worked on, or done. */
export const planStepStatusSchema = z.enum(['pending', 'in-progress', 'completed'])

export const planStepSchema = z.object({
  /** What the step is, imperative, as the agent wrote it. */
  step: z.string().min(1).max(500),
  /**
   * What to call it while it is the one being worked on. Claude supplies a
   * present-continuous form of its own; Codex supplies none, and the step
   * itself is what the surface says instead of inventing a tense.
   */
  activeForm: z.string().min(1).max(500).nullable().default(null),
  status: planStepStatusSchema
})

// …in harnessEventSchema:
z.object({
  type: z.literal('plan'),
  /** Why the plan changed, when the Harness says. Codex's `explanation`. */
  explanation: z.string().max(2_000).nullable().default(null),
  /** The whole plan, every time. A later event supersedes an earlier one. */
  steps: z.array(planStepSchema).min(1).max(MAX_PLAN_STEPS)
})
```

Naming: **`plan`**, not `todo`. `CONTEXT.md` is written in this register throughout and "todo" is a developer word; `Run`, `Checkout`, `Subagent` are the neighbours. A `**Plan**` / `**Plan step**` entry belongs in `CONTEXT.md` under `### Conversation`, with `_Avoid_: todo list, checklist, task list, TODO`. Note the collision risk: `.scratch/research/agent-conversation-ux-comparison.md` §5 uses "plan" for a durable multi-Session object. If both ideas ever ship, this one is the **Run Plan** and that one is the Plan — worth resolving in `CONTEXT.md` before either lands.

Spelling: **`'in-progress'`**, kebab-case. Codex says `inProgress`, Claude says `in_progress`, T3 chose `inProgress`. This repo's own enums are kebab (`'rate-limit'`, `'context-exhausted'`, `'workspace-write'`, `'skipped-diverged'`), so neither vendor spelling is house style, and adopting one vendor's would misleadingly imply a passthrough.

`MAX_PLAN_STEPS` should be about 50, in the spirit of `MAX_UNDO_OUTCOMES = 500` and its comment (`:101-105`) — a list beyond that is not one anybody reads. Codex's own prompt asks for 5-7-word steps and a short list.

### 6.3 The two adapters

**Codex** — remove `'turn/plan/updated'` from `IGNORED_METHODS` (`codex.ts:182`) and map it. Leave `'item/plan/delta'` ignored: it is plan mode, experimental, and its own docstring warns *"Clients should not assume concatenated deltas match the completed plan item content"* (`PlanDeltaNotification.ts:5-8`).

```ts
// status mapping, tolerating both wire spellings (§2.3)
const CODEX_PLAN_STATUS: Record<string, PlanStepStatus> = {
  pending: 'pending',
  inProgress: 'in-progress',
  in_progress: 'in-progress',
  completed: 'completed'
}
```

`activeForm` is `null` for every Codex step; there is no such field. `explanation` maps straight across. Validate with zod as the adapter does everywhere else — `docs/agents/codex-protocol.md` is explicit that *"generated types describe the shapes, they do not check them"*.

**Claude** — intercept `TodoWrite` in `describeAssistant` before the generic `tool` branch, exactly where `SUBAGENT_TOOL` is intercepted at `claude.ts:440` and for the same stated reason (*"not a tool call worth a line of its own"*). `in_progress` → `'in-progress'`. Prefer reading the `tool_use` **input** over the `tool_use_result.newTodos`: it arrives one frame earlier and the repo already has the input in hand.

The Task tools are the harder half and should be a **second increment, not the first**. They need a `Map<taskId, {subject, activeForm, status}>` living beside `subagents` and `pendingCommands` in the adapter's closure, populated from `TaskCreate` results (where the id first appears) and mutated by `TaskUpdate`, re-emitting the whole projected list each time. Read keys defensively: the docs say the streamed input is raw model output and that `id`/`task_id`→`taskId` and `active_form`→`activeForm` repair happens after the stream (§1.3).

Which increment ships first is a real decision, and the honest ordering is: **Codex first** (one method, generated types already present, zero state), **then Claude Task tools** (what actually fires on 2.1.225), **then TodoWrite** (a fallback for `CLAUDE_CODE_ENABLE_TASKS=0` and pre-2.1.142 installs). Shipping `TodoWrite` alone would produce a feature that shows nothing on the default configuration of the installed CLI.

### 6.4 Durable projection and the live path

**Live.** `LiveRun` in `app/src/renderer/src/lib/selected-conversation-read-model.ts:21-30` gains `plan: LivePlan | null`, in the manner of `subagents: LiveSubagent[]` (`:19`) whose comment explains the need: *"a dock that only redrew on the durable read would be a dock describing what the fleet was doing a moment ago."* Same argument, weaker urgency given the frequency; but the plumbing is free.

**Durable.** One `ConversationEntry` per **Run**, not per update — `kind: 'plan'`, `id: \`plan:${runId}\``, rewritten in place on each event. That mirrors how the `subagent` entry is repeatedly rewritten under a stable `dispatchId` while keeping `startedAt` separate from `at` (`shared/conversation.ts:633-656`); the same `startedAt` trick is worth copying so a plan that has been running two minutes does not read as having just appeared.

This is also what fixes the fact that **Codex does not persist plans at all** (§2.4). Writing the entry is what lets the indicator survive a restart, and there is no alternative — the rollout does not have it.

Session-scoped carry-over (§5.3, "latest snapshot wins, keyed by Session") then falls out for free: the fold in `core/conversation.ts` keeps the newest `plan` entry across Runs, and the renderer reads the last one. No extra rule.

**Cost of the alternative.** Not writing a durable entry means the plan lives only in `LiveRun`, vanishes on Run end, and cannot be recovered for Codex at all. Given that a Run's plan is a plain statement of what the agent set out to do — and this repo already argues that commands and subagents are *"worth re-reading after the Run that spawned it is gone"* — the durable entry is the cheaper choice.

### 6.5 Renderer

- Extend `RunWorkingIndicator` (`Conversation.tsx:1513-1556`): when `live.plan` (or the Session's newest durable plan entry) has an `in-progress` step, that step's `activeForm ?? step` becomes `current`, and `3/7` renders beside `RunElapsed`. The existing command/write fallback stays for Runs with no plan.
- Add the disclosure and the `<ol>` beneath it, in the same component. No new dock, no new panel, no route.
- Reuse `Spinner` (`:1500-1511`) for the in-progress mark and the existing `shimmer` class for the current step's text.
- Follow `SubagentDock`'s accessibility pattern verbatim: state as real text, mark `aria-hidden`, `motion-reduce:animate-none`.

### 6.6 Checks this needs

- `codex.test.ts` and `claude.test.ts` gain plan cases — but they must be driven by **new recordings**, since no existing fixture contains a plan (§6.1). For Codex that is `pnpm codex:record` per `docs/agents/codex-protocol.md`; for Claude it means a recorded `stream-json` run with `CLAUDE_CODE_ENABLE_TASKS=false` (for TodoWrite) and one without (for the Task tools).
- A `conversation.test.ts` case proving the durable entry is **rewritten, not appended**, over several updates in one Run.
- A read-model case proving the plan survives a Run boundary (the Session-scoped rule), which is the behaviour a reviewer is most likely to think is a bug.
- Do not add a `readiness.ts` minimum-version bump for this. A harness that never sends a plan is a Run with no plan, which is already the common case and must degrade silently.

### 6.7 Open questions

- **Should a Subagent's plan surface?** Claude scopes todos per agent (`AppState.todos` is `{[agentId]: Todo[]}`, §1.6) and this adapter already drops frames carrying `parent_tool_use_id` (`claude.ts:176`). Suggested answer: no — `CONTEXT.md:64` says a Subagent's own work *"never appear[s] as steps the Run took"*, and that settles it. **UNVERIFIED** whether Codex subagent threads emit their own `turn/plan/updated`; the `threadId` on the notification suggests they could.
- **Should the `explanation` show?** Codex supplies it, Claude has no equivalent, T3 renders it as a muted paragraph above the list. A field that is null under one of two harnesses is the kind of thing `shared/conversation.ts:551-552` warns about — *"a field that is null everywhere is a promise the record cannot keep"*. It is not null *everywhere*, so keep it, but render it only when present and never reserve space for it.
- **UNVERIFIED:** whether Claude's Task tools also fire for the CLI's own internal background tasks (the `TaskCreated`/`TaskCompleted` hook events suggest a broader mechanism than a user-facing checklist). If so, a naive projection would show internal machinery as plan steps, and the adapter would need to filter.
