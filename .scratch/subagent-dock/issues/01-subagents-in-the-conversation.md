# 01 — Subagents in the Conversation

**What to build:** When a Run dispatches subagents, the Conversation says so with one pill — "3 subagents created" — and the fleet itself lives in a dock on the right that collapses to a rail. Opening a subagent shows what it was sent to do, what it has done, and what it reported back.

The surface was settled by the prototype at `prototypes/subagent-thread` (variant C, "the fleet has its own dock"); its README carries the verdict and the reasoning. This ticket is the detection and the real implementation behind it.

**Status:** done

## Why the gap exists

Nothing in the app detects a subagent today. Both Harnesses spawn them, and both currently produce a Conversation that is wrong rather than merely incomplete:

- **Claude Code** emits `system` frames with subtypes `task_progress` and `task_updated`, neither of which is in the Adapter's known set. Each one becomes a `protocol` **failure**, so a Run that uses subagents reports itself broken while working perfectly.
- Claude's subagent inner frames carry `parent_tool_use_id`. The Adapter ignores it, so a subagent's commands and reads are recorded as the main agent's own work.
- **Codex** delivers the subagent's items on a *different* `threadId`. The Adapter ignores `threadId`, so a subagent's commands and its final message are merged into the main transcript as if the main agent had said them.

## What each Harness actually gives us

Measured against `claude 2.1.224` and `codex-cli 0.146.0` by spawning a real subagent on each and recording the protocol.

**Claude Code** — everything the dock needs:

| Need           | Where it comes from                                                  |
| -------------- | -------------------------------------------------------------------- |
| dispatch + id  | `assistant` → `tool_use` named `Agent`, its `id`                      |
| name           | `input.description` ("Count notes")                                   |
| kind           | `input.subagent_type` ("Explore")                                     |
| brief          | `input.prompt`, restated on `system/task_started`                     |
| current step   | `system/task_progress`: `description`, `last_tool_name`, `usage`      |
| steps, elapsed | `task_progress.usage.tool_uses`, `usage.duration_ms`                  |
| ended          | `system/task_updated` → `patch.status`; `system/task_notification`    |
| result         | `task_notification.summary`, and the `Agent` tool_result's text       |

**Codex spawns two different ways, and which one depends on the model.** Both are handled.

*Through `subAgentActivity`* (seen on the default model) — enough, but thinner:

| Need          | Where it comes from                                                      |
| ------------- | ------------------------------------------------------------------------ |
| dispatch + id | `item/started` → `subAgentActivity`, its `id`                            |
| name          | `agentPath` (`/root/count_notes_lines`) — a path, not a sentence         |
| thread        | `agentThreadId`, which later items arrive under                          |
| current step  | the subagent thread's own `commandExecution` items                       |
| result        | the subagent thread's final `agentMessage`                               |
| ended         | `subAgentActivity` kind `interrupted`, or the turn ending                |
| brief         | **not available** — `collabAgentToolCall.prompt` is null for a spawn here |

*Through the collab tools* (seen on `gpt-5.3-codex-spark`, which sends **no `subAgentActivity` at all**):

| Need          | Where it comes from                                                                 |
| ------------- | ----------------------------------------------------------------------------------- |
| dispatch + id | `collabAgentToolCall` with `tool: "spawnAgent"`, its `id`                            |
| threads       | `receiverThreadIds` on the completed spawn — one call may start several agents        |
| brief         | `prompt` on the spawn — the one place this Harness does state a brief                 |
| name          | **not available** — numbered in dispatch order, with the brief saying what each is for |
| state         | `agentsStates[threadId].status` on every later collab call                            |
| result        | `agentsStates[threadId].message`, or the agent's own last message on its Thread       |

So the dock states less under Codex, and must not pretend otherwise: no brief section when there is no brief, and a name derived from the agent path or from the dispatch order.

## Decisions

**One event, superseded.** A subagent is a single `subagent` Harness event carrying its whole current state, re-emitted as it progresses, and a single durable entry keyed `subagent:<runId>:<dispatchId>` — the same shape `command` already uses.

**A subagent whose Run ended is `interrupted`.** The stream ending without a report is itself a fact, and both Adapters state it the same way at flush. Leaving it `working` would spin forever in a finished Run; calling it `done` would claim an outcome nobody gave.

**Status is a small closed set**, because it is what the dock draws: `working`, `done`, `failed`, `interrupted`. "Needs attention" is the renderer's word for a subagent that failed; the contract keeps the fact.

**No progress percentage.** Neither Harness reports how much work is left, and a bar advancing on elapsed time would be inventing a denominator. The dock says state, current step, elapsed, and the number of steps taken.

**A subagent's work leaves the main transcript.** Frames carrying `parent_tool_use_id` (Claude) or a subagent `threadId` (Codex) belong to that subagent, not to the Run's own record.

## Acceptance criteria

- [x] A Run that dispatches subagents no longer produces protocol failures, under either Harness
- [x] The Conversation carries one pill per Run that dispatched subagents, saying how many and how many are still working
- [x] The pill opens a dock beside the transcript; the dock resizes from its left edge by pointer and keyboard, as the Files panel does
- [x] The dock collapses to a rail that keeps every subagent's mark and state, and expands from it onto the subagent clicked
- [x] A subagent's card says its name, what it is on now, how long, its state, and how many steps — and no progress bar
- [~] Opening a subagent shows its brief (when the Harness gives one), **how many** steps it took, and what it reported back — see *What was left out*
- [x] A subagent's own commands and reads no longer appear as the Run's own steps
- [x] Contract tests replay a subagent stream recorded from each installed CLI
- [x] `pnpm verify` passes

## What was left out

**A subagent keeps no list of its steps, only a count and its current one.** Neither Harness hands over a step history: Claude re-states one line per `task_progress` and Codex delivers items on the subagent's Thread, so a list would have to be accumulated and capped in the durable entry. That is a second decision about how much of a subagent's own work this app stores, and it is worth taking on its own rather than inside this ticket. The dock says how many steps it took and what it is on now, which is what both Harnesses report honestly.

**`task_progress.last_tool_name` is read but unused.** Claude's own `description` ("Running Count lines in notes.txt") already names the step in prose, and the tool name beside it would say the same thing twice.
