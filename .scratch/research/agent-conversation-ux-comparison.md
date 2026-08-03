# Agent↔user conversation models: opencode, Codex CLI, T3 Code, Claude Code

Research date: 2026-08-03

Sources read at these refs:

- **opencode** — `github.com/sst/opencode`, branch `dev`, commit `9535a8f929eeeb4116f3d06d2a8391e0ec72cff5` (2026-08-04), plus in-repo docs source `packages/web/src/content/docs/*.mdx` spot-checked against opencode.ai.
- **Codex CLI** — `github.com/openai/codex`, branch `main`, commit `1bbfb5cfada8e56280adcd397b23d0c301423894` (2026-08-03), sparse clone of `codex-rs/`; cross-checked against the locally installed `codex-cli 0.146.0` at `/opt/homebrew/bin/codex` via `codex app-server generate-json-schema`.
- **T3 Code** — `github.com/pingdotgg/t3code`, branch `main`, commit `6f04a5cffb8fcad95f709af69eb2da2605c4d472` (2026-08-03); additionally verified against the installed `/Applications/T3 Code (Alpha).app` and its live SQLite database at `~/.t3/userdata/state.sqlite`.
- **Claude Code** — first-party docs at code.claude.com, read 2026-08-03.

## Question and scope

How do these four products model and handle the *conversation* between a coding agent and the user — data model, event protocol, turn-taking and steering, approvals, planning affordances, multi-session UX — and what should this repo adopt or deliberately not adopt?

This note **extends** rather than repeats:

- `.scratch/research/codex-permissions-and-protocol.md` — Codex approval/sandbox mapping, config injection, execpolicy, server-initiated approval methods, rollout path. Not repeated here.
- `.scratch/research/claude-code-permissions-and-protocol.md` — Claude permission modes, rule syntax, `--settings` injection, `stream-json` frames, `--permission-prompt-tool`. Not repeated here.
- `.scratch/research/t3-code-executable-discovery.md`, `.scratch/research/t3-code-provider-update-checks.md` — how T3 Code finds and health-checks provider binaries. Not repeated here.
- `.scratch/research/local-cli-harness-capabilities.md` — the original capability matrix that produced this repo's adapter design.

### What was verifiable, and what was not

Everything in §2 is from source or first-party docs and is cited. T3 Code turned out to be **fully open source and locally installed**, so the "first-party material is thin" risk in the brief did not materialise for its *code* — but it did for its *documentation*: T3 Code has no user documentation covering turn-taking, steering, interruption, checkpoints, compaction, or worktrees, and no in-repo design rationale for its event model. Claims about T3 Code below come from reading its source and its live database, not from prose it publishes about itself.

Claims that could not be pinned to a primary source are marked **UNVERIFIED** inline.

---

## 1. The shape of the problem, stated once

All four products face the same modelling question and answer it four different ways:

| | Durable unit | Streaming unit | Steering primitive |
| --- | --- | --- | --- |
| opencode (V1) | `Message = {info, parts}`, 12 `Part` variants | `message.part.delta`, live-only | implicit: the running loop re-reads the DB |
| opencode (V2) | flat 8-variant `Message` union over an event log | `session.next.*.delta`, live-only | explicit `delivery: "steer" \| "queue"` |
| Codex CLI | `RolloutLine` → `RolloutItem` (8 variants) | `EventMsg` deltas, never persisted | `turn/steer` with `expected_turn_id` |
| T3 Code | orchestration event log → SQL projections | assistant text stored as append-deltas | no queue at all; each adapter steers or restarts |
| Claude Code | JSONL transcript at `~/.claude/projects/<project>/<session-id>.jsonl` | `stream-json` frames | queue in the TUI; `Esc` interrupts |
| **this repo** | `conversation.jsonl`, 9 `ConversationEntry` kinds | `conversation:event` IPC, not durable | **none — composer is disabled while a Run is active** |

The single sharpest structural finding: **three of the four have converged on an append-only event log with a projected read model, and this repo already has that.** The gap is not architecture. It is turn-taking.

---

## 2. Per-tool findings

### 2.1 opencode

opencode currently ships **two parallel conversation models on `dev`** and they must not be conflated.

#### Data model — V1 (the live surface)

`packages/schema/src/v1/session.ts`. A message is `WithParts = {info: Info, parts: Part[]}` (`:493-500`), where `Info = User | Assistant` discriminated on `role` (`:490`).

The `Part` union has **exactly 12 variants** (`:357-370`), all sharing `{id: PartID, sessionID, messageID}`:

`TextPart`, `SubtaskPart`, `ReasoningPart`, `FilePart`, `ToolPart`, `StepStartPart`, `StepFinishPart`, `SnapshotPart`, `PatchPart`, `AgentPart`, `RetryPart`, `CompactionPart`.

Three of those are worth naming because nobody else models them as first-class conversation content:

- **`SnapshotPart`** (`:87-92`) carries a git tree hash. Snapshots live in a *separate shadow git repo* at `join(Global.Path.data, "snapshot", project.id, Hash.fast(worktree))` (`packages/opencode/src/snapshot/index.ts`); `track()` runs `git init` + `add` + `write-tree`, `restore(hash)` runs `read-tree` + `checkout-index -a -f`.
- **`AgentPart`** (`:181-193`) is the `@agent` mention as a durable part with source offsets `{value, start, end}` — the mention is data, not parsed prose.
- **`CompactionPart`** (`:195-202`) — `{auto, overflow?, tail_start_id?: MessageID}` — records where the untouched tail of the conversation begins.

`ToolState` (`:259-313`) is a proper state machine: `pending{input,raw}` → `running{input,title?,metadata?,time{start}}` → `completed{...,time{start,end,compacted?},attachments?}` or `error{...}`.

**IDs are the ordering.** `MessageID.ascending()` and `PartID.ascending()` produce monotonic sortable ids; sessions use `SessionID.descending()` so newest sorts first (`packages/opencode/src/session/session.ts:515`). Fork comparison is literally `msg.info.id >= input.messageID` (`session.ts:708`) and revert uses `msg.info.id < messageID` (`revert.ts:108`).

**Persistence is SQLite, not JSON files** — this contradicts most write-ups. DB at `join(Global.Path.data, "opencode.db")` (`packages/core/src/database/database.ts:53-54`). Tables in `packages/core/src/session/sql.ts`: `session`, `message`, `part`, `todo`, `session_message` (V2), `session_input`, `session_context_epoch`. The event log is `packages/core/src/event/sql.ts`: `event_sequence(aggregate_id, seq, owner_id)` and `event(id, aggregate_id, seq, type, data)`, aggregate = `sessionID`.

Writes are event-sourced: `Session.updateMessage`/`updatePart` only *publish* events (`packages/opencode/src/session/session.ts:631-645`); the projector (`packages/core/src/session/projector.ts:262-330`) upserts into the read tables.

#### Data model — V2 (`packages/schema/src/session-message.ts`)

**No `Part` type at all.** `Message` is a tagged union on `type` (`:200-213`): `AgentSwitched | ModelSwitched | User | Synthetic | System | Shell | Assistant | Compaction`. Assistant content is `AssistantContent[]` = `AssistantText | AssistantReasoning | AssistantTool` (`:159-162`). Several V2 service methods still return `OperationUnavailableError` (`packages/core/src/session.ts:387-424`), so V2 is genuinely partial.

#### Event protocol

`GET /event`, `text/event-stream` (`server/routes/instance/httpapi/groups/event.ts`). Handler details worth stealing (`handlers/event.ts`):

- Envelope is `{id, type, properties}` (`:12-19`).
- **First frame is always `{type: "server.connected"}`** (`:70`).
- **Heartbeat `{type: "server.heartbeat"}` every 10 seconds** (`:63-66`).
- The listener is registered **before** the body fiber starts, with an explicit comment that this is so no events are lost (`:29-30`).
- Headers include `X-Accel-Buffering: no`.

Event names (`packages/schema/src/v1/session.ts:571-676`): `session.created|updated|deleted`, `message.updated`, `message.removed`, `message.part.updated`, `message.part.removed`, `message.part.delta`, `session.diff`, `session.error`. Plus `session.status` (`session-status-event.ts`) with `{type:"idle"} | {type:"retry", attempt, message, action?, next} | {type:"busy"}`; **`session.idle` is explicitly marked deprecated** in favour of it (`:43`).

`message.part.delta` is **live-only, not durable** (`:632-641`). V2 makes the same split explicit: `DurableDefinitions` excludes every `.delta` event, with the comment *"Stream fragments are live-only; `Text.Ended` is the replayable full-value boundary"* (`session-event.ts:209, 448-512`).

⚠️ **The published JS SDK types are stale.** `permission.updated` and an old `Permission` shape (`title`/`callID`/`pattern`) exist in `packages/sdk/js/src/gen/types.gen.ts:440` but not in `packages/schema`; the runtime emits `permission.asked`/`permission.replied` with `patterns`/`always`/`tool`. Anything built against the shipped SDK types on this ref will be wrong about permissions.

#### HTTP API

V1 path table at `groups/session.ts:78-105`: `POST /session/:id/fork {messageID?}`, `/abort`, `/share`, `/summarize`, `/revert {messageID, partID?}`, `/unrevert`, `/init`, `/shell`, `/prompt_async`, `DELETE .../message/:messageID`, `PATCH .../part/:partID`. Permissions answered at `POST /permission/:requestID/reply {reply, message?}` — the per-session variant at `POST /session/:id/permissions/:permissionID` is **deprecated** (`:406`).

V2 adds the resumability that V1 lacks: `GET /api/session/:sessionID/event?after=<seq>` — *"Replay durable events after an aggregate sequence, then continue with new durable events"* (`packages/protocol/src/groups/session.ts:340`).

#### Steering — the best model of the four

V2 has an explicit two-value delivery mode: `Delivery = ["steer", "queue"]` (`packages/schema/src/session-delivery.ts:5`), **defaulting to `steer`** (`packages/core/src/session.ts:366`).

A prompt is **admitted** (durably recorded in `session_input`, event `session.next.prompt.admitted`) then later **promoted** into model context (`session.next.prompted`). `packages/core/src/session/input.ts`:

- `promoteSteers(db, events, sessionID, cutoff)` (`:245-266`) promotes **all** un-promoted `steer` rows with `admitted_seq <= cutoff`.
- `promoteNextQueued(...)` (`:268-288`) promotes **exactly one** un-promoted `queue` row.

The drain loop (`packages/core/src/session/runner/llm.ts:383-406`):

```ts
const hasSteer = yield* SessionInput.hasPending(db, sessionID, "steer")
const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, sessionID, "queue")
...
while (shouldRun) {
  let needsContinuation = true; let step = 1
  while (needsContinuation) {
    const result = yield* runTurn(sessionID, promotion, step)
    ...
    if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, sessionID, "steer")
  }
  shouldRun = yield* SessionInput.hasPending(db, sessionID, "queue")
}
```

So: **steer** joins the current run and keeps the loop alive past the point the model would have stopped; **queue** waits for full settlement and starts a fresh turn. Steering also **resets the agent step budget** to 1 (`:187-195`). The steer cutoff is `EventV2.latestSequence(db, session.id)` (`:188`), so only inputs admitted before this turn began get folded in — an explicit guard against an infinite steer race.

V1's "queueing" is emergent rather than designed: `Runner.ensureRunning` (`packages/opencode/src/effect/runner.ts:115-138`) does not start a second run, it awaits the existing one's `Deferred`, and the running `runLoop` re-reads messages from the DB each iteration (`prompt.ts:1092-1094`), so a new user message is picked up naturally. The TUI shows a ` QUEUED ` badge for any user message whose id exceeds the in-flight assistant message id (`packages/tui/src/routes/session/index.tsx:1373, 1436`).

#### Revert/undo — staged, not destructive

`packages/opencode/src/session/revert.ts`. `revert()` (`:38-88`) asserts not busy, finds the boundary, snaps back to the **last user message** when no `partID` is given (`:59`), captures a pre-revert snapshot so the revert itself can be undone, applies `snap.revert(patches)` for all `PatchPart`s after the boundary, and stores the boundary on `session.revert`. **Messages are not deleted** — deletion happens in `cleanup(session)` (`:100-134`), called at the top of the *next* `prompt()` (`prompt.ts:1056`).

The TUI `/undo` (`routes/session/index.tsx:604-638`) additionally **restores the reverted message's text and files back into the composer**. `/redo` finds the first user message after the boundary, or calls `unrevert()`. Docs note this is git-backed, so *"your project needs to be a Git repository"* (`tui.mdx:190-272`).

#### Fork

`Session.fork({sessionID, messageID?})` (`session.ts:693-734`) creates a **new root session** (no `parentID`), titled `"<title> (fork #N)"`, replaying every message with `msg.info.id < messageID` while minting fresh ids and remapping `assistant.parentID` and `CompactionPart.tail_start_id` through an `idMap`.

#### Compaction

`packages/opencode/src/session/compaction.ts`: `PRUNE_MINIMUM = 20_000`, `PRUNE_PROTECT = 40_000`, `TOOL_OUTPUT_MAX_CHARS = 2_000`, `DEFAULT_TAIL_TURNS = 2` (`:28-34`). `select()` keeps the last N turns untouched and records `tail_start_id`; `prune()` erases *older tool outputs* once 40k tokens of tool output are protected — a cheaper intervention than summarising. V2's `compactAfterOverflow` (`packages/core/src/session/compaction.ts:173-225`) can **update the previous summary** rather than nest summaries: the prompt contains a `<previous-summary>` block instructing *"Preserve still-true details, remove stale details, and merge in the new facts."*

#### Permissions

`Action = "allow" | "deny" | "ask"`; `Rule = {permission, pattern, action}` (`packages/schema/src/v1/permission.ts:16-25`). Evaluation is **last matching rule wins**, defaulting to `ask`:

```ts
rulesets.flat().findLast(rule => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern))
  ?? { action: "ask", permission, pattern: "*" }
```
(`packages/opencode/src/permission/index.ts:28-38`)

`ask()` (`:67-107`) blocks the tool's fiber on a `Deferred` after publishing `permission.asked`. `reply()` (`:109-167`) has three behaviours worth noting:

- `"reject"` with a `message` fails with `CorrectedError{feedback}` rather than a bare rejection — **the denial carries instruction back to the model**.
- `"reject"` also **rejects every other pending permission in the same session** (`:129-138`).
- `"always"` pushes the tool-supplied `always` patterns into an in-memory `approved` list and then **auto-resolves any other pending request in the session that the new rules now allow**, publishing `permission.replied {reply:"always"}` for each (`:145-166`). It is process-scoped, not persisted to config.

Defaults (`packages/opencode/src/agent/agent.ts:119-136`) include `doom_loop: "ask"` — fired *"when the same tool call repeats 3 times with identical input"* (`permissions.mdx:164`). Nobody else has this.

#### Planning

Plan mode is **a permission posture, not a runtime**. The built-in `plan` agent (`agent.ts:141-265`) gets `edit: {"*": "deny", ".opencode/plans/*.md": "allow"}` — it can write only plan files. Transitions are *tools*: `plan_enter`/`plan_exit` (`packages/opencode/src/tool/plan.ts`). `PlanExitTool` (`:15-60`) asks the user a structured `Question` — *"Plan at `<path>` is complete. Would you like to switch to the build agent and start implementing?"* — and on Yes synthesises a new `User` message with `agent: "build"`.

Todos: `Todo.Info = {content, status, priority}` with `pending|in_progress|completed|cancelled` (`packages/schema/src/session-todo.ts:7-15`), stored in a `todo` table keyed `(session_id, position)`, surfaced as `todo.updated` and `GET /session/:id/todo`.

Subagents (`packages/opencode/src/tool/task.ts`): params include **`task_id?`** — *"resume a previous task ... will continue the same subagent session"* (`:43-62`). Depth-limited via the `parentID` chain (`:104-117`). Subagents are **child sessions** with `parentID` set, titled `"<description> (@<agent> subagent)"`, with automatically denied `todowrite` and nested `task` (`:143-172`).

⚠️ The `scout` subagent is documented (`agents.mdx:87-91` and on opencode.ai) but **absent from the source** at this ref. Docs and code disagree; `.env` default is another (docs say `deny`, `agent.ts:130-135` sets `ask`).

#### Multi-session

Parent/child via `SessionInfo.parentID` and `GET /session/:id/children`. TUI navigation is a tree: `session_child_first: <leader>down`, `session_child_cycle: right`, `session_parent: up` (`packages/tui/src/config/keybind.ts:103-116`). Sharing auto-shares only **root** sessions (`packages/opencode/src/share/session.ts:39-46`); URLs are `opncd.ai/s/<share-id>` (`share.mdx:20`); kill switch `OPENCODE_DISABLE_SHARE`.

---

### 2.2 Codex CLI

The existing `.scratch/research/codex-permissions-and-protocol.md` covers approvals, config injection, execpolicy, and the rollout path. What follows is what it does not.

#### Rollout persistence

The unit of persistence is a `RolloutLine`, not a message (`protocol/src/protocol.rs:3400`):

```rust
pub struct RolloutLine {
    pub timestamp: String,
    pub ordinal: Option<u64>,
    #[serde(flatten)] pub item: RolloutItem,
}
```

`RolloutItem` (`:3205`) is 8 variants: `SessionMeta`, `ResponseItem`, `InterAgentCommunication`, `InterAgentCommunicationMetadata`, `Compacted`, `TurnContext`, `WorldState`, `EventMsg`.

**Two parallel record kinds go in the same file.** `ResponseItem` is the raw model-visible history; `EventMsg` is the UI-facing stream. What gets written is decided by `rollout/src/policy.rs` — the single most useful file for anyone reconstructing a Codex conversation.

Three structures are worth adopting conceptually:

- **`TurnContextItem`** (`:3283`) is the turn-boundary marker *and* a durable settings snapshot: `turn_id`, `cwd`, `workspace_roots`, `approval_policy`, `sandbox_policy`, `permission_profile`, `model`, `effort`, `collaboration_mode`, `current_date`, `timezone`. Its doc comment says it is persisted *"once per real user turn after computing that turn's model-visible context updates, and again after mid-turn compaction."* This is how Codex answers "what settings were in force at turn N" on resume.
- **`CompactedItem`** (`:3240`) records compaction as a **window chain**: `message`, `replacement_history`, `window_number`, `first_window_id`, `previous_window_id`, `window_id`. Compaction is not a lossy overwrite; it is a linked list of context windows.
- **`SessionMetaLine`** (`:3168`) is line 1 and carries `git: Option<GitInfo>` (`commit_hash`, `branch`, `repository_url`), `forked_from_id`, `parent_thread_id`, `history_mode`, `context_window`, and sub-agent identity (`agent_nickname`/`agent_role`/`agent_path`).

**What is deliberately not persisted** (`policy.rs`): `Error`, `ExecCommandBegin/End/OutputDelta`, `PatchApplyBegin/Updated`, `TurnDiff`, `PlanUpdate`, `StreamError`, every approval request, every `*Delta`, `ItemStarted`, `SessionConfigured`. Codex states the consequence itself in `ThreadRollbackResponse`: *"The ThreadItems stored in each Turn are lossy since we explicitly do not persist all agent interactions, such as command executions."*

**Command output is not recoverable from a Codex rollout file.** This is a real product difference from this repo, which persists command output as a durable Conversation entry.

Two history modes exist (`protocol.rs:700`): `Legacy` (default) and `Paginated`. In `Legacy`, `ItemCompleted` is persisted only for `TurnItem::Plan` and `Extension(Sleep)`; everything else uses the older flat events. **UNVERIFIED:** when `Paginated` is selected — likely feature-flagged, not traced.

On-disk: `$CODEX_HOME/sessions/{YYYY}/{MM}/{DD}/rollout-{YYYY-MM-DDThh-mm-ss}-{thread_id}.jsonl` (`rollout/src/recorder.rs:1549`). **New: rollouts get zstd-compressed** — `COMPRESSED_SUFFIX = ".zst"` (`rollout/src/compression.rs:18`), transparently re-materialized for append. Any external reader must handle both extensions. Sidecars: an append-only `$CODEX_HOME/session_index.jsonl` name index scanned from the end (`rollout/src/session_index.rs:19`), plus a SQLite state DB (`rollout/src/state_db.rs`).

#### Protocol corrections

Three corrections to what the brief assumed:

1. **There is no `Op::UserTurn`.** It was folded into `Op::UserInput`, which now carries `thread_settings: ThreadSettingsOverrides` (`protocol.rs:531`).
2. The delta event names are **`AgentMessageContentDelta`**, **`ReasoningContentDelta`**, **`ReasoningRawContentDelta`**, **`PlanDelta`** — not `AgentMessageDelta`/`AgentReasoningDelta`.
3. Turn lifecycle has a wire-compat quirk: the wire strings are **`task_started` / `task_complete`**, with `turn_started`/`turn_complete` as aliases.

`ThreadSettingsOverrides` (`:459`) is the mid-conversation reconfiguration surface: `approval_policy`, `sandbox_policy`, `permission_profile`, `model`, `effort: Option<Option<..>>` (double-option = set/clear/leave), `collaboration_mode`, `personality`.

**The v1 app-server methods in the brief no longer exist.** `newConversation`, `sendUserMessage`, `sendUserTurn`, `interruptConversation`, `resumeConversation`, `forkConversation`, `listConversations` are gone from the method registry; only `getConversationSummary`, `gitDiffToRemote`, `getAuthStatus` survive (`app-server-protocol/src/protocol/common.rs:1218-1229`). The current surface is `thread/*` + `turn/*` — including `thread/start|resume|fork|rollback|compact/start|list|read|search`, `thread/turns/list`, `thread/items/list`, `thread/inject_items`, `thread/goal/set|get|clear`, `thread/name/set`, and **`turn/start`, `turn/steer`, `turn/interrupt`** (`:855-867`).

`InitializeCapabilities` gained **`opt_out_notification_methods: Option<Vec<String>>`** (`v1.rs:45`) — a client can suppress named notification methods, which is the right escape hatch for high-volume delta channels.

`ThreadStatus`: `NotLoaded | Idle | SystemError | Active{active_flags}` where `ThreadActiveFlag` is `WaitingOnApproval | WaitingOnUserInput`.

#### Steering

`turn/steer` is a **compare-and-swap** (`v2/turn.rs:175`):

```rust
pub struct TurnSteerParams {
    pub thread_id: String,
    pub input: Vec<UserInput>,
    /// Required active turn id precondition. The request fails when it does not
    /// match the currently active turn.
    pub expected_turn_id: String,
    ...
}
```

Core models the outcome explicitly (`core/src/user_message_admission.rs:8`):

```rust
pub enum UserMessageAdmission {
    Started { turn_id: String },
    Steered { turn_id: String },
}
```

Queued input lives in `core/src/session/input_queue.rs` with `InputQueueActivity::{Mailbox, Steer}`; `clear_pending()` on abort.

**UNVERIFIED:** whether steered input joins the current model request or the next loop iteration — inferred from `UserMessageAdmission::Steered`, not traced end to end.

#### Interruption

`TurnAbortReason` is **`Interrupted | Replaced | ReviewEnded | BudgetLimited`**.

- `Replaced` is emitted when a new task pre-empts a running one: `Session::spawn_task` calls `abort_all_tasks(TurnAbortReason::Replaced)` first (`core/src/tasks/mod.rs:282`).
- **Only `Interrupted` triggers `maybe_start_turn_for_pending_work()`** (`:504, 543`) — queued input is drained after an interrupt but *not* after a replace.
- Abort is graceful-then-hard: `select!` on completion vs. `GRACEFULL_INTERRUPTION_TIMEOUT_MS`, then `task.handle.abort()`.
- **An interrupt leaves a marker in model history.** `InterruptedTurnHistoryMarker::{Disabled, ContextualUser, Developer}` (`:99`); the `Developer` variant injects a `role: "developer"` message. The code flushes the rollout before emitting `TurnAborted` *"because some clients synchronously re-read the rollout on receipt of the abort event."*
- Pending approvals are dropped **after** cancellation is observed, deliberately: *"or an in-flight approval wait can surface as a model-visible rejection before TurnAborted."*

**UNVERIFIED:** which marker variant ships as default, and the literal text of `INTERRUPTED_DEVELOPER_GUIDANCE`.

#### Backtrack (esc-esc) is implemented as fork

`tui/src/app_backtrack.rs` module doc:

> - The first `Esc` in the main view "primes" the feature and captures a base thread id.
> - A subsequent `Esc` opens the transcript overlay and highlights a user message when there is a prompt to reuse.
> - `Enter` requests a fork before the selected prompt and reopens it for editing.

`ThreadForkParams` has **`before_turn_id`** (experimental) alongside `last_turn_id` — mutually exclusive; `before_turn_id` excludes that turn and all later ones. Fork also accepts `path` (fork from an arbitrary rollout file), `exclude_turns`, and the full config-override set. **UNVERIFIED:** which of the two the TUI actually passes.

There is also a non-fork alternative: `Op::ThreadRollback{num_turns}` / `thread/rollback`, documented as *"drop the last N user turns from in-memory context. This does not attempt to revert local filesystem changes. Clients are responsible for undoing any edits on disk."*

#### Planning

`update_plan` is a **todo list, explicitly not plan mode** — the source says so. `protocol/src/plan_tool.rs`:

```rust
pub enum StepStatus { Pending, InProgress, Completed }
pub struct PlanItemArg { pub step: String, pub status: StepStatus }
pub struct UpdatePlanArgs { pub explanation: Option<String>, pub plan: Vec<PlanItemArg> }
```

with the annotation *"Arguments for the `update_plan` todo/checklist tool (not plan mode)"*. It is one of only two item kinds kept as `ItemCompleted` in Legacy history mode.

**Plan mode is a collaboration mode.** `ModeKind` = `Plan | Default` (+ hidden `PairProgramming`, `Execute`) with prompt templates shipped at `collaboration-mode-templates/templates/{default,execute,pair_programming,plan}.md`. It is wired through `turn/start.collaborationMode`, `ThreadSettingsOverrides.collaboration_mode`, persisted on `TurnContextItem.collaboration_mode`, echoed on `TurnStartedEvent.collaboration_mode_kind`, and enumerated by `collaborationMode/list`. Doc note: *"Takes precedence over model, effort, and developer instructions if set."*

**Review mode** is a structured second opinion, not chat. `ReviewTarget` = `UncommittedChanges | BaseBranch{branch} | Commit{sha,title} | Custom{instructions}`; `ReviewDelivery::{Inline, Detached}`; `review/start` returns `{turn, review_thread_id}` — for a detached review that is a *new thread id*. Output is structured: `ReviewOutputEvent{findings, overall_correctness, overall_explanation, overall_confidence_score}` with each `ReviewFinding{title, body, confidence_score, priority, code_location{absolute_file_path, line_range}}`. Ending a review aborts the turn with `TurnAbortReason::ReviewEnded`.

**AGENTS.md merging** (`core/src/agents_md.rs`) is precisely specified, and this repo should copy the algorithm if it ever does the same:

> 1. Determine the project root by walking upwards from the cwd until a configured `project_root_markers` entry is found (default `.git`). **An empty marker list disables parent traversal.**
> 2. Collect every `AGENTS.md` from the project root down to the cwd inclusive and concatenate in that order.
> 3. We do **not** walk past the project root.

Filenames: `AGENTS.md`, override `AGENTS.override.md`, plus `config.project_doc_fallback_filenames`. The literal separator between user-level and project-level docs is `const AGENTS_MD_SEPARATOR: &str = "\n\n--- project-doc ---\n\n"`.

#### Multi-session

`thread/list` is the resume-picker API with `cursor`, `limit`, `sort_key: {CreatedAt, UpdatedAt, RecencyAt}`, `archived`, `section_id` (double-option: omit = all, `null` = unsectioned), `cwd` filter, `search_term`, and experimental `parent_thread_id`/`ancestor_thread_id` for sub-agent trees. Summaries carry `first_user_message`, `preview`, `git_branch`/`git_sha`/`git_origin_url`, `created_at` *"from the filename timestamp"*, `updated_at` *"from file mtime"*.

`codex exec` is a **genuinely separate, narrower schema** (`exec/src/exec_events.rs`): `ThreadEvent::{thread.started, turn.started, turn.completed, turn.failed, item.started, item.updated, item.completed, error}` over `ThreadItemDetails::{AgentMessage, Reasoning, CommandExecution, FileChange, McpToolCall, CollabToolCall, WebSearch, TodoList, Error}`. No review mode, no compaction, no plan-vs-todo distinction, no user message item.

Cloud delegation is in-repo: `codex-rs/cloud-tasks/`, `cloud-tasks-client/`, exposed as `codex cloud`, with `codex apply` pulling a cloud diff locally.

#### Version drift against installed 0.146.0

Generated the schema from the installed binary and diffed method names:

| Method | in 0.146.0 |
| --- | --- |
| `turn/steer` | ✅ |
| `thread/rollback` | ✅ |
| `thread/compact/start` | ✅ |
| `thread/fork`, `thread/resume`, `review/start`, `thread/list`, `thread/read`, `thread/inject_items`, `thread/shellCommand` | ✅ |
| `thread/turns/list`, `thread/items/list`, `thread/search`, `collaborationMode/list` | ❌ |

`codex app-server generate-json-schema` remains the correct way to pin per-version, exactly as `docs/agents/codex-protocol.md` already says.

---

### 2.3 T3 Code

T3 Code is the closest analogue to this repo: an Electron desktop app plus a local server driving five provider CLIs (Codex, Claude, Cursor, Grok, opencode). Its normalization layer is the most directly relevant prior art in this note.

#### The canonical event union

`packages/contracts/src/providerRuntime.ts` defines `ProviderRuntimeEventV2` (`:967-1017`), aliased `ProviderRuntimeEvent`. Every adapter's `streamEvents: Stream.Stream<ProviderRuntimeEvent>` emits this and nothing else (`apps/server/src/provider/Services/ProviderAdapter.ts:125`). **48 event types** (`:148-196`) across `session.*`, `thread.*`, `turn.*`, `item.*`, `content.delta`, `request.*`, `user-input.*`, `task.*`, `hook.*`, `tool.*`, plus auth/account/mcp/model/config/deprecation/files and `runtime.warning|error`.

Shared envelope (`:248-262`): `eventId`, `provider`, `providerInstanceId?`, `threadId`, `createdAt`, `turnId?`, `itemId?`, `requestId?`, `providerRefs?`, `raw?`.

Three canonical vocabularies carry the normalization:

- **`CanonicalItemType`** (`:121-133`) — `user_message`, `assistant_message`, `reasoning`, `plan`, the seven `TOOL_LIFECYCLE_ITEM_TYPES` (`:104-112`: `command_execution`, `file_change`, `mcp_tool_call`, `dynamic_tool_call`, `collab_agent_tool_call`, `web_search`, `image_view`), `review_entered/exited`, `context_compaction`, `error`, `unknown`.
- **`CanonicalRequestType`** (`:135-146`) — the approval taxonomy.
- **`RuntimeContentStreamKind`** (`:81-89`) — `assistant_text`, `reasoning_text`, `reasoning_summary_text`, `plan_text`, `command_output`, `file_change_output`, `unknown`.

The per-driver mappers are small and **mostly heuristic**, which is worth knowing before copying the idea wholesale:

- Codex `toCanonicalItemType` (`Layers/CodexAdapter.ts:218-237`) normalizes the provider's item-type string and **substring-matches**: `type.includes("plan") || type.includes("todo") → "plan"`, `includes("compact") → "context_compaction"`.
- Claude `classifyToolItemType(toolName)` (`ClaudeAdapter.ts:596-637`) matches on the *tool name*: `includes("bash"|"command"|"shell") → command_execution`, `includes("edit"|"write"|"patch") → file_change`, `"task"|"agent"|"subagent" → collab_agent_tool_call`.
- ACP (Cursor, Grok) has a real `kind` enum, so `canonicalItemTypeFromAcpToolKind` (`acp/AcpCoreRuntimeEvents.ts:47-61`) is a clean switch.

The native payload is preserved on `RuntimeEventRaw` (`:34-40`) with an enumerated `source` (`:21-31`) — and **never persisted to SQLite**. It goes to rotating NDJSON logs with three parallel streams `"native" | "canonical" | "orchestration"` (`Layers/EventNdjsonLogger.ts:49`, rationale in `ProviderEventLoggers.ts:1-27`), under `<stateDir>/logs/provider/events.log`, 10 MiB × 10 files, 512 MiB / 14-day retention.

The adapter contract is only 126 lines: `startSession`, `sendTurn`, `interruptTurn`, `respondToRequest`, `respondToUserInput`, `stopSession`, `listSessions`, `hasSession`, `readThread`, `rollbackThread`, `stopAll`, `streamEvents` (`ProviderAdapter.ts:45-126`). Adding a driver requires no orchestration, contract, or client change (`docs/internals/providers.md:39-40`).

#### Orchestration model

`packages/contracts/src/orchestration.ts`. Project → Thread → Turn, with four content channels hanging off the thread:

| Type | Line | Note |
| --- | --- | --- |
| `OrchestrationThread` | 352-388 | `messages`, `activities`, `checkpoints`, `proposedPlans`, `session`, `latestTurn`, `runtimeMode`, `interactionMode`, `branch`, `worktreePath`, `archivedAt`, `settledOverride/settledAt`, `snoozedUntil/snoozedAt` |
| `OrchestrationMessage` | 229-239 | `{id, role, text, attachments?, turnId, streaming, createdAt, updatedAt}` — **no parts array** |
| `OrchestrationThreadActivity` | 315-325 | `{id, tone: info\|tool\|approval\|error, kind, summary, payload, turnId, sequence?, createdAt}` — tool calls, approvals, plans, compaction, token usage all land here |
| `OrchestrationLatestTurn` | 335-344 | `{turnId, state: running\|interrupted\|completed\|error, requestedAt, startedAt, completedAt, assistantMessageId, sourceProposedPlan?}` |
| `OrchestrationThreadShell` | 410-438 | List projection; adds `hasPendingApprovals`, `hasPendingUserInput`, `hasActionableProposedPlan`, `latestUserMessageAt` |

**Assistant text is stored as append-deltas on one event type.** `thread.message.assistant.delta` becomes `thread.message-sent {streaming: true, text: <delta>}` (`orchestration/decider.ts:1032-1056`); the projector appends when `streaming` and keeps existing text when a completion carries empty text (`projector.ts:472-492`). Caps `MAX_THREAD_MESSAGES = 2_000`, `MAX_THREAD_CHECKPOINTS = 500`.

A turn ends when its session leaves `running`: `settledTurnStateForSessionStatus` (`projector.ts:50-66`) maps `idle|ready → completed`, `error → error`, `interrupted|stopped → interrupted`.

#### What T3 Code throws away — worth knowing before copying it

`runtimeEventToActivities` (`Layers/ProviderRuntimeIngestion.ts:310-688`) handles only `request.*`, `runtime.error/warning`, `tool.denied`, `turn.plan.updated`, `user-input.*`, `task.*`, `thread.state.changed`, `thread.token-usage.updated`, `item.started/updated/completed` — and `item.*` returns `[]` unless the item type is a tool-lifecycle type (`:618-620, 641-643, 663-665`).

Consequences, all verified:

- **Reasoning is normalized but never persisted or displayed.** `reasoning` is a canonical item type and `reasoning_text` is a stream kind, but only `streamKind === "assistant_text"` becomes a message (`:1457-1459`), and `reasoning` is not a tool-lifecycle type. There is no thinking-block UI anywhere in `apps/web/src`.
- `hook.*`, `tool.progress`, `model.rerouted`, `files.persisted`, `mcp.*`, `account.*`, `session.configured`, and **`turn.aborted`** produce no activity at all.

#### Persistence

`~/.t3/userdata/state.sqlite`, WAL + `foreign_keys=ON`, single-connection synchronous driver guarded by a 1-permit semaphore (`persistence/NodeSqliteClient.ts:264-275`). 35 migrations. Tables verified in the live DB:

```
orchestration_events            -- sequence PK AUTOINCREMENT, event_id UNIQUE, aggregate_kind,
                                --   stream_id, stream_version, event_type, occurred_at, command_id,
                                --   causation_event_id, correlation_id, actor_kind, payload_json
orchestration_command_receipts  -- command_id PK, result_sequence, status  (idempotent retries)
checkpoint_diff_blobs
provider_session_runtime        -- thread_id PK, resume_cursor_json, runtime_payload_json, provider_instance_id
projection_projects / _threads / _thread_messages / _thread_activities
projection_thread_sessions / _turns / _pending_approvals / _thread_proposed_plans
projection_state                -- projector PK, last_applied_sequence  (projector watermark)
```

Note `orchestration_command_receipts` — command-id idempotency is a first-class table, which is the same instinct as this repo's `submissionId`.

There is **no checkpoint table**: checkpoints live on `projection_turns` with `UNIQUE(thread_id, checkpoint_turn_count)` (`persistence/Layers/ProjectionCheckpoints.ts:51-90`). A live row: `checkpoint_ref = refs/t3/checkpoints/NGQzOGI1NTYt…/turn/4` — a base64-encoded thread id under a hidden git ref namespace.

Activity payloads in the live DB, verbatim:

```
tool.updated  | tool  | Tool call             | {"itemType":"dynamic_tool_call","status":"inProgress","detail":"Skill: {\"skill\":\"grilling\",…"}
tool.completed| tool  | Command run           | {"itemType":"command_execution","detail":"Bash: cd … && find …"}
context-window.updated | info | Context window updated | {"usedTokens":31067,"inputTokens":30891,"maxTokens":1000000}
runtime.error | error | Runtime error         | {"message":"Codex CLI (codex) is not installed or not executable."}
```

Details truncate at 180 chars (`:204`). **No retention or pruning of conversation data exists** — no TTL, no event-log compaction, no VACUUM. Archive and delete are soft columns.

#### Transport

**One authenticated Effect-RPC WebSocket at `GET /ws`, JSON serialization.** Not SSE, not tRPC. 79 RPC members, 17 streaming (`packages/contracts/src/rpc.ts:786-866`). Auth on upgrade via a short-lived `wsTicket` query param.

The detail worth stealing: **per-method authorization typed so omission is a compile error.** `RPC_REQUIRED_SCOPES` is declared `satisfies Record<WsRpcMethod, AuthEnvironmentScope>` (`auth/RpcAuthorization.ts:23-103`), enforced by `authorizeEffect`/`authorizeStream` (`ws.ts:420-433`). Holding the socket is not authorization.

`orchestration.subscribeThread` (`ws.ts:1253-1374`) yields `{kind:"synchronized"} | {kind:"snapshot", snapshot} | {kind:"event", event}` and:

1. Attaches the live tail into an unbounded queue **before** reading the snapshot (`:1270-1275`) — same instinct as opencode's listener-before-body.
2. Treats only 6 event types as thread-detail events (`isThreadDetailEvent`, `:270-290`).
3. Replays from `afterSequence` only within `THREAD_RESUME_MAX_GAP = 1_000`, otherwise sends a full snapshot — *because unbounded replay has OOM-killed servers* (comment `:301-305`).
4. Ships the cold-start snapshot over **HTTP** (`GET /api/orchestration/threads/:threadId`, 6 s timeout) so the multi-KB payload travels gzipped, then subscribes with `afterSequence` (`state/threadSnapshotHttp.ts:22-116`).

**Buffered assistant delivery is the default**: `enableAssistantStreaming` defaults to `false` (`contracts/src/settings.ts:471`). Buffering is not "hold until turn end" — `MAX_BUFFERED_ASSISTANT_CHARS = 24_000` spills the accumulated text as one delta, and the buffer flushes at every interaction boundary (approval opened, user input requested, turn finalize) (`ProviderRuntimeIngestion.ts:95, 893-902, 1503-1545`). The sidebar stream separately coalesces at `SHELL_COALESCE_WINDOW = 50ms` (`ws.ts:701-702`).

#### Steering — no queue, and the composer stays open

`thread.turn.start` carries the user message inline plus an optional `bootstrap` that can create the thread, prepare a git worktree, and run setup scripts in the same command (`orchestration.ts:677-704`; handler `ws.ts:908-953` rolls the thread back on failure).

**There is no invariant rejecting a turn start while a turn is running.** No `session.status` check, no `activeTurnId` check; `commandInvariants.ts` (184 lines) contains only existence and archived checks. This is deliberate — sending mid-turn is *steering*, and each adapter decides what that means:

| Driver | Mid-turn `sendTurn` | Citation |
| --- | --- | --- |
| Claude | Offered into the live SDK `promptQueue`; **same `turnId`, no new turn boundary** | `ClaudeAdapter.ts:3729-3738, 3771-3772` |
| opencode | `steeringTurnId = context.activeTurnId`; a failed steer leaves the original turn running | `OpenCodeAdapter.ts:1414-1418, 1495-1500` |
| Cursor / Grok (ACP) | `steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined`; only the last prompt settles the turn | `CursorAdapter.ts:137, 913-917, 1030` |
| **Codex** | **No steer path** — always a fresh `turn/start`. No interrupt-then-resend either | `CodexAdapter.ts:1531-1563`, `CodexSessionRuntime.ts:1280-1329` |

The web composer allows Enter while running (`ChatView.tsx:4559-4568` guards only on send-busy/connecting), and the UI compensates: *"Steering adds a user message to the current running turn without necessarily changing any of the turn timestamps"* (`ChatView.logic.ts:537-544`). The timeline explicitly reasons about "a turn cut short by a steer" (`MessagesTimeline.logic.ts:298, 327, 371`).

**UNVERIFIED (and T3 Code says so itself, by omission):** whether Codex's app-server rejects, queues, or races a `turn/start` issued while a turn is running. T3 Code sends it unconditionally with no guard, no comment, and no test.

**Mobile queues client-side instead.** A durable outbox holds messages until the thread is idle — `resolveThreadOutboxDeliveryAction` returns `"wait"` when `threadBusy` (`apps/mobile/src/state/thread-outbox-model.ts:151-173`), and **queued messages can be edited before delivery** (`use-thread-outbox.ts:29`).

Interruption drops the `turnId` and interrupts **by session** — *"Orchestration turn ids are not provider turn ids"* (`ProviderCommandReactor.ts:1122-1143`). A wrinkle: ingestion maps `turn.completed{interrupted|cancelled}` to session `ready` (`ProviderRuntimeIngestion.ts:1383-1386`), which the server read model then settles as **`completed`**; only the *client* reducer writes `latestTurn.state = "interrupted"`, and only when the interrupt command carried a matching `turnId` (`client-runtime/src/state/threadReducer.ts:208-228`). `turn.aborted` runtime events are not ingested at all. **This repo's `interrupted` flag on commands and its `stopped` recovery category are more honest than T3 Code's read model.**

**Edit-and-resend: not present** on web. **Forking a conversation: not present** — no fork/duplicate/clone command; `OrchestrationThread.branch` is a *git* branch. **Compaction is observed, never commanded** — no `thread.compact`, no `/compact`; Claude's `compact_boundary` and Codex's `thread/compacted` both collapse to one info activity `kind: "context-compaction"`.

Rewind is checkpoint revert, and it reverts the *provider* conversation too: `thread.checkpoint.revert {turnCount}` restores the git checkpoint ref, then computes `rolledBackTurns` and calls `adapter.rollbackThread(threadId, numTurns)` (`CheckpointReactor.ts:690-816`) — Claude truncates `context.turns` and refreshes its resume cursor, Codex sends `thread/rollback`. Refused while running; confirm dialog warns it cannot be undone.

#### Approvals

Four thread-scoped modes: `RuntimeMode = ["approval-required","auto-accept-edits","auto","full-access"]`, **default `full-access`** (`orchestration.ts:118-125`).

Provider translation is where it gets lossy, and T3 Code documents the loss:

- **Codex** (`CodexSessionRuntime.ts:264-297`): `approval-required → {untrusted, read-only, reviewer:user}`; `auto → {on-request, workspace-write, reviewer:auto_review}`; `full-access → {never, danger-full-access}`.
- **Claude** (`ClaudeAdapter.ts:3512-3517`): `auto-accept-edits→acceptEdits`, `auto→auto`, `full-access→bypassPermissions`. **`approval-required` is absent from the map** and yields `undefined` (SDK default).
- **opencode** (`opencodeRuntime.ts:328-344`): `full-access → allow *`; **every other mode gets the identical `ask` ruleset** — it cannot distinguish Supervised from Auto, exactly as `docs/user/permission-modes.md:18-21` admits.

The decision vocabulary is **four values, not approve/deny**: `ProviderApprovalDecision = ["accept","acceptForSession","decline","cancel"]` (`orchestration.ts:133-139`). The UI renders four buttons in this order (`ComposerPendingApprovalActions.tsx:20-52`): **Cancel turn** / **Decline** / **Always allow this session** / **Approve once**. Approvals render **inline in the composer**, which switches into an approval state and blocks normal sending (`ChatComposer.tsx:1150, 3059`).

Structured questions are a *separate* channel (`UserInputQuestion {id, header, question, options[{label,description}], multiSelect}`) with tone `info`, and `tool_user_input` approval requests are explicitly filtered out of approval activities (`ProviderRuntimeIngestion.ts:322-324`) so the two never double-count. This repo makes the same separation (`choices` vs `approval-request`).

#### Planning

`ProviderInteractionMode = ["default","plan"]` per thread, with exactly two standalone slash commands `/plan` and `/default` (`apps/web/src/composer-logic.ts:265-275`). Availability is **provider-declared**: `showInteractionModeToggle` is true for Codex, Claude, Cursor and false for Grok, opencode (`CodexProvider.ts:43`, `OpenCodeProvider.ts:29`, etc.).

The interesting artifact is the **proposed plan**: `turn.proposed.delta` streams markdown, `turn.proposed.completed {planMarkdown}` finalizes. Claude produces it by intercepting **`ExitPlanMode`** and then *denying the tool* with the message `"The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn."` (`ClaudeAdapter.ts:3350-3369`). Stored in its own table (`projection_thread_proposed_plans`) and referenced from `projection_turns`.

The approve-and-implement flow is the closest thing T3 Code has to branching. When a plan turn settles with `implementedAt === null`, a **"Plan Ready"** banner appears and the send button activates on an *empty* draft. Submitting with text = refine (stay in plan mode); submitting empty = implement — the composer sends the literal string `` `PLEASE IMPLEMENT THIS PLAN:\n${planMarkdown}` `` with `interactionMode: "default"` (`apps/web/src/proposedPlan.ts:72-93`). It can implement in the same thread **or spawn a new thread titled `Implement <title>`** carrying `sourceProposedPlan: {threadId, planId}` (`ChatView.tsx:5227-5251, 5361-5387`); the server then marks the source plan implemented.

Todos: `turn.plan.updated {explanation?, plan: RuntimePlanStep[]}` with `pending|inProgress|completed`, fed from Claude's TodoWrite input parsed mid-stream, Codex's `turn/plan/updated`, Cursor's `cursor/update_todos`. The sidebar tab is labelled "Plan" in plan mode and "Tasks" otherwise (`ChatView.tsx:2117`).

**Specs: not present.** No spec-driven concept anywhere in the repo. Skills exist but as provider-installed prompt assets invoked with a `$name` token, not planning primitives.

#### Multi-session

A thread with a non-null `worktreePath` runs there. Worktrees are created by `git worktree add` at `<baseDir>/worktrees/<repoName>/<branch-with-slashes-dashed>` (`vcs/GitVcsDriverCore.ts:2579-2614`), usually inside the turn-start bootstrap, optionally running project scripts flagged `runOnWorktreeCreate`. **Nothing removes a worktree when a thread is deleted or archived** — removal is only via an explicit `vcs.removeWorktree` RPC. Neither the workspace-layout doc nor the source-control doc mentions worktrees at all.

**No global or per-project concurrency limit** — no semaphore, no `maxConcurrent`. The only automatic throttle is `ProviderSessionReaper`: stop sessions idle > 30 min, swept every 5 min, skipping threads with an `activeTurnId` (`ProviderSessionReaper.ts:17-18, 65-74`).

**Resumption is lazy, not boot-time.** `resume_cursor_json` is upserted on every session change, preserving an existing cursor when the caller passes `undefined` (`ProviderSessionDirectory.ts:103-149`). On the next routed operation, `recoverSessionForThread` tries adopt-then-resume and **hard-fails with no cursor**: *"…because no provider resume state is persisted"* (`ProviderService.ts:390-395`). Cursor shapes: Codex `{threadId}`; Claude `{threadId, resume: <session uuid>, resumeSessionAt: <last assistant uuid>, turnCount}`; opencode `{sessionId}` re-adopted via `session.get` with a fresh-session fallback.

**Provider instances** are a user-defined slug (`codex_personal`, `codex_work`) and the only routing key; `ProviderDriverKind` is an *open* branded slug so unknown drivers from forks parse and render as "unavailable" instead of crashing (`packages/contracts/src/providerInstance.ts:10-35, 70-95`). Switching instances mid-thread is gated by a **continuation group key** (`contracts/src/server.ts:119-122`): Codex instances sharing a `CODEX_HOME` can be swapped mid-thread; Claude instances with different `CLAUDE_CONFIG_DIR` cannot (`docs/user/providers-codex.md:103-118`, `docs/user/providers-claude.md`).

**Sharing/export/permalink: not present.** No share, export, publish, or permalink for a conversation anywhere. `docs/internals/remote.md:46-49` states explicitly that a hosted pairing URL gives the hosted app no copy of session state. The only per-conversation export is the plan card's "download .md" / "save to workspace".

Adjacent capabilities worth flagging: full-text search across threads via `orchestration.searchThreads` (a `LIKE` + window-function ranking that puts user matches above assistant matches, `ProjectionSnapshotQuery.ts:725-760`); lifecycle overlays **archived / settled / snoozed** on threads, with `settle`/`snooze` refused while a queued turn start is within a 2-minute grace window (`decider.ts:89-143`); and auto-generated thread titles, commit messages, PR bodies and branch names produced by one-shot runs of the *same* provider CLIs (`apps/server/src/textGeneration/`).

---

### 2.4 Claude Code (for contrast)

The existing `.scratch/research/claude-code-permissions-and-protocol.md` covers permissions and the `stream-json` protocol. What is new here is conversation *management*.

**Checkpointing** (`code.claude.com/docs/en/checkpointing`): *"Every user prompt creates a new checkpoint"*; snapshots for the 100 most recent checkpoints; saved with the conversation so `/rewind` works after a resume; deleted with sessions after 30 days (`cleanupPeriodDays`).

`/rewind`, or `Esc` twice at an empty prompt, opens a menu offering per-prompt: **Restore code and conversation** / **Restore conversation** / **Restore code** / **Summarize from here** / **Summarize up to here** / **Never mind**. The two code options appear only when the checkpoint has tracked changes. *"After restoring the conversation or choosing Summarize from here, the original prompt from the selected message is restored into the input field so you can re-send or edit it."*

The documented limitations are the interesting part, and they are exactly this repo's ADR 0004 position stated by someone who built the alternative:

- *"Checkpointing does not track files modified by bash commands."*
- Subagent edits are not restored: *"Use git to revert those edits."*
- *"Manual changes you make to files outside of Claude Code and edits from other concurrent sessions are normally not captured."*
- Symlinked and hard-linked paths are skipped, with a `Restored the code, but skipped N files` warning.
- *"Think of checkpoints as 'local undo' and Git as 'permanent history'."*

**Sessions** (`/docs/en/sessions`): transcripts are JSONL at `~/.claude/projects/<project>/<session-id>.jsonl` where `<project>` is the working directory path with non-alphanumerics replaced by `-`; *"The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release."*

A resumed session restores conversation history including tool calls and results, model, agent, permission mode (*"`plan` and `bypassPermissions` are never restored"*), active goal, and unexpired scheduled tasks — but **not** `--mcp-config`, `--settings`, `--plugin-dir`, `--fallback-model`, or `--add-dir` directories.

`/branch [name]` copies the transcript and switches the running process to write to it; from the CLI, `claude --continue --fork-session`. The inheritance table is precise: conversation history is copied up to the branch point; *"Allow for this session" permission grants* carry over in-process but **not** across `--fork-session` into a separate process; in-flight background subagents and background bash keep running and *"Their output appears in the new branch you switched into, not in the original session."*

The session picker widens with `Ctrl+W` (all worktrees of the repo), `Ctrl+A` (all projects), `Ctrl+B` (current git branch). Sessions can be named (`claude -n`, `/rename`, `Ctrl+R` in the picker); **accepting a plan names the session from the plan content** unless already named.

**Steering**: `Esc` — *"Stop the current response or tool call mid-turn so you can redirect. Claude keeps the work done so far."* `Ctrl+B` backgrounds a running bash command or agent. `/btw` is a side question available **while Claude is working**: *"The side question runs independently and doesn't interrupt the main turn"*, has no tool access, never enters conversation history, and can be forked into a real session with `f` — *"The fork inherits the parent conversation plus this question and answer as real transcript turns."*

**Task list**: `Ctrl+T` toggles it; *"Tasks persist across context compactions"*; and critically for cross-session planning, *"To share a task list across sessions, set `CLAUDE_CODE_TASK_LIST_ID` to use a named directory in `~/.claude/tasks/`"*.

**Plan mode**: *"Claude reads files, runs shell commands to explore, and writes a plan, but does not edit your source. … edits stay blocked until you approve the plan."* Approval options: **Yes, and use auto mode** / **Yes, manually approve edits** / **No, refine with Ultraplan on Claude Code on the web** / **No, keep planning**. `Ctrl+G` opens the proposed plan in `$EDITOR` before Claude proceeds.

**Ultraplan** (research preview) is the most ambitious planning affordance any of these ship: *"hands a planning task from your local CLI to a Claude Code on the web session running in plan mode. Claude drafts the plan in the cloud while you keep working in your terminal."* The review surface offers **inline comments on individual passages**, emoji reactions, and an outline sidebar. Terminal status is a three-state indicator: `◇ ultraplan` / `◇ ultraplan needs your input` / `◆ ultraplan ready`. On approval you choose **Execute on the web** or **Approve plan and teleport back to terminal**, and the terminal then offers **Implement here** (inject the plan into the current conversation) / **Start new session** (clear context, plan only) / **Cancel** (save the plan to a file and print the path).

**Worktrees**: `claude --worktree <name>` creates `.claude/worktrees/<name>/` on branch `worktree-<name>`; `worktree.baseRef` is `"fresh"` (default branch on the remote) or `"head"`; `--worktree "#1234"` branches from a PR at `.claude/worktrees/pr-<number>`; `.worktreeinclude` (gitignore syntax) copies gitignored files like `.env` into every new worktree; subagents can declare `isolation: worktree` in frontmatter; `git worktree lock` is held while an agent runs. Permission approvals granted in a worktree are saved to the **main checkout's** `.claude/settings.local.json` *"so it applies in the main checkout and in every other worktree of the repository, and it survives the worktree's removal."*

---

## 3. Where this codebase stands today

Product: `argos-desktop` (`app/package.json:2`). Domain language in `CONTEXT.md`; storage decision in `docs/adr/0002-app-owned-session-state.md`; in-place editing in `docs/adr/0004-in-place-primary-checkout.md`; native permissions in `docs/adr/0003-harness-native-permissions.md`.

### The model

**One normalized harness event union**, `harnessEventSchema` — `app/src/shared/conversation.ts:94-216`. 14 variants: `assistant-message`, `reasoning`, `file-change`, `tool`, `command`, `choices`, `approval-request`, `approval-resolved`, `usage`, `thread-ready`, `retrying`, `completed`, `failed`, `unsupported`. The header comment states the invariant: *"Every harness Adapter translates its Harness's protocol into these events, so Core, Main, and the Renderer never see raw Harness frames."* This is structurally the same decision as T3 Code's `ProviderRuntimeEvent`, at roughly a third the surface area.

**One durable conversation entry union**, `conversationEntrySchema` — `app/src/shared/conversation.ts:283-447`. 9 kinds: `message`, `boundary`, `usage`, `thread`, `command`, `read`, `approval`, `file-change`. Compared to opencode's 12 `Part` variants and Codex's 8 `RolloutItem` variants this is well-scoped, and it makes two choices the others do not:

- **Command output is durable Conversation content** (`:340-368`), with `running`, `interrupted`, `exitCode`, `durationMs`. Codex explicitly does not persist this (`rollout/src/policy.rs`), and T3 Code truncates to a 180-char activity detail. This repo's justification is written in the schema: *"what it printed is usually the answer the person was waiting for."*
- **Approvals are durable Conversation entries** with `decision: 'allowed'|'denied'|'abandoned'` (`:38, 391-408`). `abandoned` — *"what an unanswered request becomes when its Run ends first"* — has no equivalent in any of the three others.

**The journal is append-only JSONL with last-write-wins per id**, `app/src/core/conversation.ts:54, 227-247`: entries are read into a `Map` keyed by `entry.id`, so a coalesced streaming checkpoint costs one append. A torn final line is skipped rather than losing the conversation before it (`:238-241`). Streaming persists at most every `CHECKPOINT_INTERVAL_MS = 250` (`:116`).

**Projection with a byte watermark**, `app/src/core/session-state.ts`. `SessionState` carries `journalBytes` — *"Bytes of the journal this was derived from"* (`:54-55`) — and `stateAsOf` rebuilds from the journal whenever the watermark disagrees (`conversation.ts:282-294`). The write order is journal-then-projection precisely so *"a crash between them leaves a projection that is behind rather than ahead"* (`:265-268`).

This is the same pattern as T3 Code's `projection_state.last_applied_sequence`, but self-verifying: T3 Code trusts its watermark, this repo checks it against the artifact on every read.

**Idempotent submissions.** `submit()` (`app/src/core/conversation.ts:336-380`) keys the entry `user:${submissionId}` and, on a resend, returns the existing snapshot unless the text differs — in which case it fails with *"Submission identity was already used for different content."* `startingSubmissionId(sessionId)` (`shared/conversation.ts:562-564`) gives the session-creating message a stable identity. T3 Code's equivalent is a whole table (`orchestration_command_receipts`).

**Recovery is a typed vocabulary**, `conversationRecoverySchema` (`shared/conversation.ts:265-281`): nine categories, each with a `resumableSubmissionId` that is null when resending is not safe. `context-exhausted` deliberately does not offer a resend (`renderer/src/components/Conversation.tsx:83`). Nobody else models "what the person can safely do next" as data.

**Cross-harness handoff.** A Conversation may cross Harness Threads. `run-service.ts:443-467` computes `threadCompatible` (same saved thread, same skill, same model, and for Claude the transcript still exists on disk) and falls back to `deterministicHandoff` (`:1405-1411`) — the Skill in force plus the last 8 message turns as `User:`/`Assistant:` lines. **No other product here can switch harness mid-conversation at all.** T3 Code refuses even to switch *instances* of the same provider across a continuation-group boundary.

**Transport**: one IPC channel per command plus `conversation:event` for live deltas (`app/src/shared/channels.ts:42-45`). `ConversationStreamEvent` is `{sessionId, runId, event}` — *"Pushed to the Renderer as it happens, ahead of any durable projection"* (`shared/conversation.ts:575-581`). The renderer keeps a `LiveRun` (`Conversation.tsx:66-75`) and drops it when `activeRunId` goes null (`:153`).

**Interruption** reaches Codex as `turn/interrupt` JSON-RPC (`core/harness/codex.ts:521-526`); Claude is broadcast-only, `interrupt: () => undefined` (`core/harness/claude.ts:160`), and its `flush()` synthesises `interrupted: true` command events for anything unfinished (`:176-192`).

**Checkout** is `local | worktree` (`shared/checkout.ts:14-18`), and `checkoutRequestSchema` deliberately refuses a raw worktree path — the app creates the linked worktree itself, on a branch derived from the starting message, cut from a chosen base (`:25-34`, ADR 0004).

### What it already does well

1. **Journal + verified projection.** Three of the four studied products converged on event-sourcing; only this one checks the projection against the source artifact on every read.
2. **Honesty about what it does not know.** `interrupted` on commands, `shortened` on diffs, `source: 'harness' | 'checkout'` on file changes (*"the change happened, and nothing in the Conversation accounts for it"*, `shared/conversation.ts:466-470`), `abandoned` approvals, `plainOptions` for prose that only looks like a menu. T3 Code's read model settles an interrupted turn as `completed`; this one refuses to.
3. **Redaction and bounding at the write boundary.** `redactCredentials` before anything is stored (`shared/conversation.ts:619-624`), `MAX_DIFF_LINES = 400`, `MAX_OUTPUT_CHARACTERS = 16_000` keeping the *end* of output because *"a failure says why on its last lines"* (`core/conversation.ts:74-79`).
4. **Native permissions, not app-side interception** (ADR 0003) — validated by opencode's and Codex's own designs, and by T3 Code discovering that its opencode adapter cannot distinguish three of its four modes.
5. **A domain language that already names the hard parts.** `CONTEXT.md` distinguishes Conversation from Run from Harness Thread from Adapter, and Archive from Delete. Codex needed `TurnContextItem` to recover per-turn settings; this repo already records `harness`, `skill`, `model`, `askedPermissionMode` on every `run-started` boundary (`shared/conversation.ts:303-319`).

### The gaps, stated plainly

- **No steering, no queue.** The composer is disabled while a Run is active: `disabled={busy || blocked || activeRunId !== null || !draft.trim()}` (`Conversation.tsx:774`), with the Skill picker, model picker and permission picker likewise disabled at `:740, 758, 766`. Every other product studied lets you type mid-turn. Codex, opencode and T3 Code all have first-class steering; Claude Code has `Esc`-then-redirect plus `/btw`.
- **No rewind, no branch, no edit-and-resend.** `git` is the only undo (ADR 0004), which is defensible for *code* — but every other product also rewinds the *conversation*, which git cannot do.
- **No compaction.** `context-exhausted` is a terminal recovery category telling the person to *"Start a shorter message"* (`Conversation.tsx:83`). opencode prunes tool outputs before summarising; Codex auto-compacts inline and chains windows; Claude Code offers `/compact`, `/rewind → Summarize from here`, and a resume-from-summary dialog.
- **No planning affordances at all.** No plan mode, no todo list, no plan artifact. `reasoning` events are normalized but confined to the activity stream (`shared/run.ts:56-64`). Skills are the only methodology surface.
- **No cross-session anything.** The inbox lists Sessions; nothing relates them. No parent/child, no subagent visibility, no shared task list, no search.

---

## 4. Adoptable best practices, ranked

Each is tied to the source that proves it works and to how it lands here.

### 1. Steering: let the person type while a Run works — *high value, medium cost*

**Proof:** opencode's `Delivery = ["steer","queue"]` with separate `promoteSteers` / `promoteNextQueued` (`packages/core/src/session/input.ts:245-288`); Codex's `turn/steer` with an `expected_turn_id` precondition and an explicit `UserMessageAdmission::{Started, Steered}` outcome; T3 Code shipping mid-turn sends with no server-side guard at all.

**How it lands here.** The Conversation already has the right primitive — `submissionId` idempotency. Add a durable `queued` state to the message entry (a message with `runId: null` while a Run is active), and a `delivery` field on `DevelopSessionInput`. Core owns admission; Main decides delivery per Harness because the capability is not uniform:

- **Codex** — `turn/steer` exists in installed 0.146.0 (verified). The adapter can steer natively.
- **Claude** — this repo runs `claude -p` with `--input-format stream-json`, which accepts further user frames on stdin; T3 Code steers Claude via the SDK `promptQueue` with the same turn id. **UNVERIFIED for the `-p` stdin path specifically** — needs a local probe before it is designed against.

Where a Harness cannot steer, queue: hold the message and start a second Run when the first settles. That path needs no new harness capability and is strictly better than a disabled composer.

Take Codex's precondition idea: a steer carries the `runId` it believes is active, and a mismatch is a queue rather than a lost message. Take T3 Code's mobile lesson too — **a queued message must be editable and cancellable before it is delivered** (`thread-outbox-model.ts`).

Effect boundary: admission and promotion are Core (`ConversationEffects.submit` grows a delivery argument); the per-Harness decision is Main, as harness capability already is. No ESLint boundary is touched.

### 2. Rewind the conversation, not the code — *high value, low cost*

**Proof:** Claude Code's `/rewind` menu separates **Restore conversation** from **Restore code** precisely because they are different operations, and documents that bash-made changes, subagent edits, and external edits are not restorable — *"Think of checkpoints as 'local undo' and Git as 'permanent history'."* opencode's revert is **staged, not destructive**: the boundary is a marker on the session and messages are only deleted at the top of the next `prompt()` (`revert.ts:100-134`). Codex's `thread/rollback` is explicitly conversation-only: *"This does not attempt to revert local filesystem changes."*

**How it lands here.** ADR 0004 says git is the only undo *for code*; it does not say the Conversation cannot be rewound. Add a `boundary` variant — say `rewound` — carrying the entry id the Conversation was rewound to, and have `summarize()` (`core/conversation.ts:1054`) stop folding entries after the newest rewind marker. The journal stays append-only, nothing is deleted, and the projection watermark keeps working unchanged. Then do what both opencode and Claude Code do: **restore the rewound user message's text into the composer** so the obvious next action is edit-and-resend. Since `submissionId` already makes a resend idempotent, an edited resend just needs a new id.

This gets edit-and-resend, branch-in-place, and "undo that bad turn" for one new entry variant and one fold rule.

### 3. Compaction, in the cheap order — *high value, medium cost*

**Proof:** opencode does the cheap thing first — `prune()` erases *older tool outputs* once `PRUNE_PROTECT = 40_000` tokens of tool output are protected, before any summarisation (`compaction.ts:28-34`). Codex records compaction as a **window chain** (`CompactedItem{window_number, first_window_id, previous_window_id, window_id}`) so it is not a lossy overwrite. opencode V2 **updates the previous summary** rather than nesting summaries, with a `<previous-summary>` block instructing *"Preserve still-true details, remove stale details, and merge in the new facts."*

**How it lands here.** This repo's cross-harness handoff (`deterministicHandoff`, `run-service.ts:1405`) is already a crude compactor — last 8 turns plus the Skill. Generalise it:

1. **Prune first.** `HarnessUsage` already carries `contextWindow` and `contextUsed` (`shared/conversation.ts:51-58`). When used crosses a threshold, drop old command *output* from the replayed context — not from the journal. Zero model calls, and this repo already bounds output at 16k chars, so the machinery is half-built.
2. **Then summarise**, as a new `boundary` variant carrying the summary and the id where the untouched tail begins — opencode's `tail_start_id`, Codex's `window_id` chain. Because a rewind marker and a compaction marker are both "the fold stops treating earlier entries as context", they share one mechanism.

Never overwrite the journal. Both opencode and Codex keep the original and layer the summary; Claude Code says the same — *"the original messages stay in the session transcript, so Claude can still reference the details."*

### 4. Denial that carries instruction — *medium value, trivial cost*

**Proof:** opencode's `reply()` with `"reject"` plus a message fails the tool with `CorrectedError{feedback}` rather than a bare rejection (`permission/index.ts:109-167`).

**How it lands here.** `resolveApprovalInputSchema.message` already exists (`shared/run.ts:161`), and the comment says the card no longer collects one — *"the next composer message is where a person says what to do instead."* That reasoning holds **only while the composer is disabled during a Run**. Once steering (item 1) exists, "deny and tell it why" becomes one action instead of two, and the field is already plumbed.

Also worth copying from opencode: a `"reject"` **rejects every other pending approval in the same session** (`:129-138`), and an `"always"` **auto-resolves any other pending request the new rule now allows** (`:145-166`). This repo's `openApprovals` array (`session-state.ts:21-22`) already models a queue; it currently answers them strictly one at a time.

### 5. Heartbeat, first-frame, and listen-before-snapshot on the event stream — *medium value, trivial cost*

**Proof:** opencode emits `server.connected` as the first frame and `server.heartbeat` every 10 s, and registers the listener **before** the body fiber starts with a comment that this is so no events are lost (`handlers/event.ts:29-30, 63-70`). T3 Code attaches the live tail into an unbounded queue **before** reading the snapshot (`ws.ts:1270-1275`), and caps replay at `THREAD_RESUME_MAX_GAP = 1_000` *because unbounded replay OOM-killed servers*.

**How it lands here.** The renderer's `LiveRun` is populated from `conversation:event` while a separate `getConversation` call fetches the snapshot (`Conversation.tsx:126-176`) — the same race, in-process. Subscribe before snapshotting, and have the snapshot carry a journal-byte marker so the renderer can discard events it already folded. `journalBytes` already exists and is exactly the right cursor.

### 6. A per-Run settings snapshot at the turn boundary — *medium value, already 80% done*

**Proof:** Codex's `TurnContextItem`, persisted *"once per real user turn … and again after mid-turn compaction"*, carrying cwd, approval policy, sandbox, model, effort, collaboration mode, date and timezone.

**How it lands here.** The `run-started` boundary already carries `harness`, `skill`, `model`, `askedPermissionMode` (`shared/conversation.ts:303-319`), and `RunConfiguration` (`shared/run.ts:67-95`) carries executable hash, harness version, skill hash and checkout. The gap is that the boundary carries a subset. Widening it means a Conversation read back in six months explains itself without a second lookup — and it is the precondition for resuming a Run with the settings it actually had.

### 7. Detached, structured review — *medium value, medium cost*

**Proof:** Codex's `review/start` returns a **separate `review_thread_id`** for a detached review, and the output is structured — `ReviewFinding{title, body, confidence_score, priority, code_location{absolute_file_path, line_range}}` — not prose. `ReviewTarget` is `UncommittedChanges | BaseBranch | Commit | Custom`.

**How it lands here.** This repo already has a Changed Files panel and a `changedFileSchema` tally (`shared/conversation.ts:455-472`). A review that produces *located findings* rather than a wall of text is a natural second surface for it, and Codex proves the harness can emit it. It also does not disturb the Conversation: a detached review is a different thread.

### What not to adopt

- **T3 Code's default of `full-access`** (`orchestration.ts:118-125`). This repo defaults to Ask, with the reasoning written in the component: *"a Run edits the Project in place, and being asked first is the posture somebody would choose if they were choosing deliberately"* (`Conversation.tsx:117-118`). Keep it.
- **T3 Code's discarding of reasoning, hooks, and `turn.aborted`.** Its adapter normalizes `reasoning` and then drops it on the floor. This repo already routes reasoning to a sanitized activity stream (`shared/run.ts:56-64`), which is the better answer.
- **T3 Code's checkpoint refs under `refs/t3/checkpoints/…`.** Writing hidden refs into the user's repository contradicts ADR 0002 and 0004, and buys what `git stash`/`git diff` already give.
- **opencode's dual V1/V2 models.** Two live conversation schemas in one process is a cost, not a feature; the note above exists partly because it is hard to reason about.
- **Codex's non-persistence of command output.** This repo persists it deliberately and should keep doing so.

---

## 5. Differentiators: planning software engineering projects

Nobody in this comparison plans *projects*. Everybody plans *turns*.

- **Codex** ships `update_plan` and annotates it in its own source as *"the `update_plan` todo/checklist tool (not plan mode)"* — a per-turn checklist that is not even persisted in the default history mode except as one `TurnItem::Plan`.
- **opencode**'s plan agent writes markdown into `.opencode/plans/*.md` and then exits via a Yes/No question. The plan file is real and durable, but nothing in the product tracks it afterwards: no index, no status, no relation to later sessions.
- **T3 Code** has the most developed handoff — a `proposedPlan` table, a "Plan Ready" banner, and implement-in-a-new-thread carrying `sourceProposedPlan: {threadId, planId}`. And then it stops: **no specs, no milestones, no decomposition, no cross-thread rollup.** The plan is a message that spawns a thread.
- **Claude Code** goes furthest — Ultraplan's inline comments on plan passages, `Ctrl+G` to edit a plan in `$EDITOR`, plan-derived session names, and `CLAUDE_CODE_TASK_LIST_ID` to share a task list across sessions. But it is still one plan for one session, and the cloud dependency means it is unavailable on Bedrock, Agent Platform, and Foundry.

**The unclaimed ground: a plan is a first-class, durable, multi-session object with its own state, and Sessions are the work that discharges it.**

Four specific things nobody does, each feasible here for a concrete architectural reason:

### 5.1 A plan that outlives the Session that produced it

Everyone treats a plan as turn output. Here, a plan should be a peer of Session under Project — with milestones, decomposed items, and per-item status derived from *which Session did what*.

**Why feasible here.** ADR 0002 already put durable state in app-owned storage rather than the repository, with the explicit note that *"Portability, if it is ever wanted, is an export action — not a storage architecture."* A Plan is another app-owned aggregate beside Session, in the same journal-plus-projection shape Core already implements. T3 Code needed a new SQL table and two migrations for a much weaker version; here it is one more Core module.

And this repo has already run this experiment: ADR 0002 records that the *pre-pivot* product developed Ideas into specifications and tickets, and that the machinery was removed because the durable output became code. The lesson is not "planning artifacts were wrong" — it is that they must not be **user-editable canonical files** requiring reconciliation. An app-owned plan with an export action has none of that cost.

### 5.2 A plan item knows which Session discharged it, and what it changed

Nobody connects a plan item to the work. T3 Code's `sourceProposedPlan` is the closest and it is one-directional and one-shot.

**Why feasible here.** `changedFileSchema` (`shared/conversation.ts:455-472`) already tallies *"what this Session has done to the Project, one row per file"* across every Run, including changes found by comparing the Checkout that the Harness never reported (`source: 'checkout'`). A plan item that points at a Session automatically inherits a truthful file-level record of what discharging it actually did. Nobody else has a per-session changed-file tally at all — Codex cannot even recover command output.

### 5.3 Milestones that span Checkouts

`Checkout` is already `local | worktree` (`shared/checkout.ts:14-18`) and the app creates worktrees itself on branches derived from the starting message (ADR 0004). Claude Code's worktree support is the best of the four and is still *per-session*: `--worktree <name>`, cleanup prompts on exit, a periodic sweep. Nothing above it groups worktrees into a piece of work.

A milestone with three items, each a Session in its own worktree, each with a branch and a changed-file tally, rolled up into one status — is a view this repo's data model can already produce. **UNVERIFIED whether the inbox can present it usefully; that is a design question, not a data question.**

### 5.4 Cross-harness planning

This is the one nobody can copy.

This repo can already switch Harness mid-Conversation: `run-service.ts:443-467` detects the switch, and `deterministicHandoff` replays the recent turns into the new Harness. T3 Code — the only other multi-provider host studied — cannot even switch *instances of the same provider* across a continuation-group boundary (`docs/user/providers-claude.md`, "Usually, no"), and its Codex adapter has no steer path at all.

So: plan with one Harness, implement with another, review with a third. Codex's `review/start` produces structured `ReviewFinding`s with code locations; Claude's plan mode produces a plan artifact via `ExitPlanMode`. A plan object that is Harness-neutral by construction — because the Conversation contract already is (`shared/conversation.ts:6-15`) — can route each phase to whichever Harness is best at it, and record which one did what on the Run boundary it already writes.

The architectural reason this is available: **the normalized event contract is the product boundary, not an implementation detail.** T3 Code has the same idea and spends it on breadth (five drivers, heuristic string matching in `CodexAdapter.ts:218-237`). Spending it on *depth* — one plan, several harnesses, each doing what it is good at — is the differentiated move.

### The opinionated version

The wedge is not "an app that chats with a coding agent, plus planning." It is: **the unit of work is a plan, not a chat.** You state an outcome; the app decomposes it into items; each item becomes a Session in its own Checkout with the right Harness for the job; the plan shows what is done, what is in flight, and what each item actually changed. The chat is how you steer an item, not how you hold the project in your head.

Everything needed for that already exists here except the plan object and steering. Both are small next to what is built.

---

## 6. Open questions and what to verify next

1. **Can `claude -p` be steered mid-turn?** This repo runs Claude with `--input-format stream-json`. T3 Code steers Claude through the SDK's `promptQueue` (`ClaudeAdapter.ts:3729-3738`), which is not the same transport. **Needs a local probe** before item 4.1 is designed. If it cannot, Claude gets queue-only and Codex gets true steer — an asymmetry the UI must state honestly, exactly as `docs/harness-permission-mapping.md` states the permission asymmetry.
2. **Does `turn/steer` work against installed 0.146.0 in practice?** The method is present in the generated schema (verified). Semantics were not exercised. Also unresolved upstream: whether Codex's app-server rejects, queues, or races a `turn/start` issued while a turn runs — T3 Code sends it unconditionally with no guard and no test.
3. **Does Codex's `thread/rollback` interact usefully with this repo's in-place Checkout?** Its own doc says *"Clients are responsible for undoing any edits on disk"*, which is compatible with ADR 0004 — but the Harness Thread and the Conversation would need to rewind together, and this repo's Conversation can cross Harness Threads.
4. **What triggers Codex's auto-compaction?** `compact_token_budget.rs` exists and is named for it; the threshold constant and its config key were not read. Relevant to whether this repo should compact at all or let the Harness do it — T3 Code's `ThreadTokenUsageSnapshot.compactsAutomatically` shows the Harness can be asked.
5. **When does Codex select `ThreadHistoryMode::Paginated`?** Default is `Legacy`; the earlier probe saw `"historyMode":"legacy"`. Likely feature-flagged. It changes what a rollout file contains, which matters if this repo ever reads one.
6. **Rollout `.zst` compression** (`rollout/src/compression.rs:18`) is new. Nothing here reads Codex rollout files today, but `claudeThreadExists` (`run-service.ts:1414`) already reads Claude's transcript path to decide thread compatibility — the equivalent check for Codex must handle both extensions.
7. **Is `permission.updated` really dead in opencode?** It survives only in the generated JS SDK (`types.gen.ts:440`). If this repo ever adds an opencode adapter, target `packages/schema`, not the published SDK.
8. **Would a rewind boundary break the projection watermark?** The design in §4.2 assumes `advance()` (`session-state.ts:91-155`) can fold a rewind marker without rereading the journal. `deriveState` folds every entry, so a marker that changes the meaning of *earlier* entries may need the fold to be two-pass. **Worth prototyping before committing to the entry shape.**
9. **How does a queued message appear in the inbox?** `describeState` (`session-state.ts:166-177`) returns `blocked`/`running`/`failed`/`idle`. A Session with a running Run and a queued message is none of those cleanly. Ticket 12 owns Session status; this is its question.
