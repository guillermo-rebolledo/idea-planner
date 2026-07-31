# Local CLI harness capabilities

Research date: 2026-07-30

## Question

What supported capabilities and integration surfaces do the currently available Codex and Claude CLI tools provide for starting and resuming sessions, selecting models and reasoning effort, streaming output, representing structured choices, invoking installed skills, observing tool activity, cancellation, and handling process failure?

## Executive conclusion

Both installed harnesses can power persistent, explicitly invoked Idea conversations without asking users for separate API keys. They should not share one lowest-common-denominator transport:

- **Codex should use `codex app-server` over stdio JSONL.** OpenAI describes it as the interface for rich product integrations and exposes first-class threads, turns, model discovery, effort selection, streamed items, approvals, structured user questions, skill discovery/invocation, interruption, and typed failures. Its structured-question method is currently experimental, so the app needs a text-question fallback and version/capability checks.
- **Claude should use `claude -p` with `--input-format stream-json --output-format stream-json --verbose --include-partial-messages`, plus an app-owned `PreToolUse` hook bridge.** The stream is adequate for messages, tool calls/results, retries, costs, and session IDs. `AskUserQuestion` normally cannot complete in non-interactive print mode; an app-owned hook must relay its structured payload over local IPC, wait for the UI answer, and return `permissionDecision: "allow"` with the original questions plus an `answers` object. Anthropic’s Agent SDK offers a cleaner native callback, but that is a distinct integration dependency rather than “drive the already installed CLI.”
- Keep a harness-neutral app state machine, but write **separate Codex and Claude adapters**. Normalize only stable product events (`session-ready`, `assistant-delta`, `activity`, `choice-request`, `approval-request`, `turn-ended`, `retrying`, `failed`, `cancelled`); retain raw harness events for diagnostics.

Local inspection found `codex-cli 0.146.0` at `/opt/homebrew/bin/codex` (npm package `@openai/codex`) and Claude Code `2.1.220` at `~/.local/bin/claude` (native arm64 binary).

## Capability matrix

| Capability | Codex 0.146.0 | Claude Code 2.1.220 | MVP implication |
| --- | --- | --- | --- |
| Start / resume | App Server `thread/start`, `thread/resume`, then `turn/start`; CLI also has `codex exec resume` | `-p`, `--session-id`, `--resume`, `--continue`, `--fork-session` | Persist the harness session/thread ID on each Idea. Never rely on “last session” because multiple Ideas can run concurrently. |
| Model selection | App Server `model/list`; per-thread and per-turn `model` | `--model` accepts alias or full ID; no documented machine-readable model-list command | Codex picker can be discovered dynamically. Claude picker needs a conservative alias list plus custom ID entry; do not claim exhaustive availability. |
| Reasoning effort | `model/list` returns supported/default efforts; `turn/start.effort` overrides | `--effort`; installed help lists `low`, `medium`, `high`, `xhigh`, `max` | Render only harness-supported choices. Codex can discover them. Claude should use the intersection advertised by the installed help/version, not a hard-coded global list. |
| Streaming / machine output | App Server bidirectional JSON-RPC over JSONL; `codex exec --json` for one-shot automation | `stream-json` input/output; partial token events; final result contains cost/session metadata | Use long-lived App Server connection for Codex. Use one Claude print-mode process per active session/run, or resume by ID for the next user turn. |
| Structured choices | Experimental `item/tool/requestUserInput`: 1–3 questions, options, free-form `isOther` | `AskUserQuestion`: questions, 2–4 options, multi-select, custom text; print mode requires a hook to supply answers | Normalize to cards with option buttons and a custom-response composer. Preserve harness-specific limits. Always support plain-text fallback. |
| Installed skills | `skills/list`, change notifications, and explicit `skill` input item plus `$name` text | Skills invoke as `/skill-name`; skill discovery follows user/project/plugin locations | Resolve and verify Matt Pocock skills before offering them. Attribute the methodology in product UI; do not infer availability from a hard-coded name alone. |
| Tool / event visibility | Item start/completion and deltas for messages, reasoning summaries, commands, file changes, MCP calls, plans; approval requests | Stream messages contain assistant blocks, `tool_use`, tool results, partial API events; optional hook and nested-subagent events; `system/init` identifies loaded tools/plugins/MCP | The activity feed can be rich for both, but event shapes are adapter-specific. Use final item/tool results as authoritative. |
| Cancellation | `turn/interrupt` yields final `interrupted` status | Send SIGTERM; it aborts the turn, terminates running Bash process trees, runs end hooks, exits 143 | Expose Stop. Treat Codex interrupted status and Claude exit 143 after an app-issued SIGTERM as user cancellation, not failure. |
| Permissions | Thread/turn approval and sandbox policies; server-initiated command/file/permission requests | `--permission-mode`, allow/deny tool rules, `--permission-prompt-tool`, and hooks | Default the Idea workspace to its own writable root. Surface every unresolved approval in the conversation. Never use bypass modes on the host by default. |
| Failure handling | JSON-RPC request errors; `error` event followed by failed turn with typed `codexErrorInfo` | `system/api_retry`, final result/error metadata, stderr, and process exit; startup stream reports plugin/MCP load errors | Supervise the child process, parse protocol errors, retain stderr separately, time out startup/handshakes, and offer retry/resume without duplicating a submitted answer. |

## Codex findings

### Recommended transport

OpenAI explicitly positions App Server as the integration used to power rich clients, including authentication, conversation history, approvals, and streamed agent events. Its default stdio transport is newline-delimited JSON-RPC, with a required `initialize`/`initialized` handshake. Threads contain turns; turns contain typed items and incremental notifications. This is a materially better desktop integration surface than scraping the terminal UI or treating repeated `codex exec` processes as chat. [OpenAI: Codex App Server](https://developers.openai.com/codex/app-server)

The installed CLI confirms `codex app-server` is present and can generate TypeScript bindings or JSON Schema for the exact installed protocol. The product should generate or vendor bindings per supported Codex version and feature-detect optional fields rather than copying examples from the documentation.

### Sessions and turns

`thread/start` creates a conversation and `thread/resume` reopens a recorded thread by ID; later `turn/start` calls append user input. The server also supports `thread/fork`. A resume can override configuration, and a required MCP server failing to initialize makes start/resume fail instead of silently continuing. [OpenAI: App Server threads](https://developers.openai.com/codex/app-server#threads)

The simpler non-interactive surface persists sessions too: `codex exec resume --last` or `codex exec resume <SESSION_ID>` continues an earlier run. Its `--json` mode emits JSONL events including thread/turn lifecycle, item events, tool activity, and errors, while `--output-schema` constrains the final response. This is useful for bounded background jobs, but App Server is better for a live HITL conversation. [OpenAI: Non-interactive mode](https://developers.openai.com/codex/noninteractive)

### Models and effort

`model/list` returns picker-visible model IDs, display names, the default model, input modalities, `defaultReasoningEffort`, and `supportedReasoningEfforts`. `turn/start` accepts per-turn `model` and `effort` overrides, which then become defaults for later turns. [OpenAI: App Server models and turns](https://developers.openai.com/codex/app-server#models)

This supports a truthful dynamic picker: the app should query the installed harness and avoid showing model/effort combinations the current account/catalog does not advertise.

### Structured choices

The server-initiated `item/tool/requestUserInput` request represents 1–3 short questions. Options may mark a free-form alternative with `isOther`; the host sends the user’s answer in the matching response. The API is documented as experimental. [OpenAI: App Server request user input](https://developers.openai.com/codex/app-server#toolrequestuserinput)

This maps closely to the desired UI: render each question as a card, option labels as buttons, and keep an adjacent custom-answer input. Because the surface is experimental and model use is not guaranteed, the adapter must also recognize an ordinary assistant question and present it as text.

### Skills

App Server can enumerate installed skills with `skills/list`, refresh the cache, watch for changes, and invoke a chosen skill by including both `$<skill-name>` in the text and a `skill` input item containing its resolved name/path. The explicit item is recommended because it injects the full instructions without asking the model to locate the skill. [OpenAI: App Server skills](https://developers.openai.com/codex/app-server#skills)

The app can therefore check that the user’s installed `grill-me` or `wayfinder` skill exists before showing it as runnable. “Based on Matt Pocock’s methodology” is product attribution; the generated assistant message remains attributed to the selected Codex model/harness.

### Visibility, permissions, cancellation, failures

The server streams authoritative `item/started` and `item/completed` objects plus deltas for agent text, reasoning summaries, command output, file changes, MCP progress, and plan changes. Command and file approvals are server-initiated requests with accept/decline/cancel decisions. Sandbox and approval policy can be scoped at thread or turn creation. [OpenAI: App Server events and approvals](https://developers.openai.com/codex/app-server#items)

`turn/interrupt` requests cancellation and the turn finishes with `status: "interrupted"`. Failed turns first emit an `error` event and then complete with `status: "failed"`; documented categories distinguish context exhaustion, usage limits, HTTP/stream failures, bad requests, auth failures, sandbox failures, and internal errors. [OpenAI: App Server errors](https://developers.openai.com/codex/app-server#errors)

## Claude findings

### Recommended CLI mode

Claude’s `-p/--print` mode is the documented programmatic CLI surface. `--output-format stream-json --verbose --include-partial-messages` yields newline-delimited events and token deltas; the final result includes response text, cost, and session metadata. `--input-format stream-json` allows a caller to send multiple user messages over stdin. [Anthropic: Run Claude Code programmatically](https://code.claude.com/docs/en/headless)

A practical launch shape is:

```text
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --include-hook-events \
  --model <selected-model> \
  --effort <selected-effort> \
  --permission-mode <selected-policy> \
  --settings <app-owned-settings>
```

The exact stream input envelope should come from the installed version’s protocol/examples and be covered by an adapter contract test. The CLI is a native binary here, so there is no installed JavaScript package source to import as an API.

### Sessions, models, and effort

The CLI can continue the most recent project-scoped conversation, resume a specific session ID or name, and optionally fork on resume. JSON output exposes the session ID, which the app should capture immediately and store on the Idea. [Anthropic: CLI reference](https://code.claude.com/docs/en/cli-reference)

The installed binary accepts `--model` aliases or full IDs and `--effort low|medium|high|xhigh|max`. Anthropic’s current reference notes that available effort levels depend on the selected model. Unlike Codex App Server, the Claude CLI reference does not document a machine-readable available-model catalog, so the app must not imply that a static list is complete or available to every account. [Anthropic: CLI `--model` and `--effort`](https://code.claude.com/docs/en/cli-reference#cli-flags)

### Structured choices require a bridge

Claude’s `AskUserQuestion` tool has the desired structure: question text, short header, 2–4 labeled/described options, optional multi-select, and custom free text. The normal Agent SDK integration exposes this through a `canUseTool` callback. [Anthropic: Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)

However, `AskUserQuestion` normally blocks in `-p` non-interactive mode. Anthropic documents the CLI-compatible escape hatch: a `PreToolUse` hook can receive the question payload, collect an answer through another UI, and return `permissionDecision: "allow"` with `updatedInput` containing the original `questions` plus the `answers` mapping. “Allow” without answers is insufficient. [Anthropic: Hooks reference — `AskUserQuestion`](https://code.claude.com/docs/en/hooks#askuserquestion)

For this desktop app, the hook should be app-owned and communicate over a per-run local Unix socket or similarly authenticated local IPC channel:

1. Claude invokes `AskUserQuestion`.
2. The hook forwards the JSON payload and blocks.
3. The adapter emits a normalized `choice-request`.
4. The UI displays option buttons and a custom response field.
5. The adapter returns the selected label(s) or custom text to the hook.
6. The hook writes the required updated input and exits.

The bridge must have cancellation and timeout behavior so a crashed desktop process cannot leave an orphaned hook/Claude process waiting forever. If the bridge is unavailable, fail the turn visibly; do not auto-select an answer.

The cleaner alternative is Anthropic’s TypeScript Agent SDK, whose callback directly supports permission and `AskUserQuestion` flows. Anthropic recommends the SDK for custom applications, but adopting it should be a conscious architecture decision because it is not merely invoking the user’s installed CLI. [Anthropic: Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

### Skills

Claude discovers personal, project, and plugin skills and invokes them explicitly as `/skill-name`. Skills may be marked `disable-model-invocation: true`, which still permits direct user invocation while preventing automatic model invocation. [Anthropic: Extend Claude with skills](https://code.claude.com/docs/en/slash-commands)

The adapter can submit `/grill-me <initial idea>` or `/wayfinder <initial idea>` as explicit user input after verifying the relevant skill files exist. The app should not silently let the model choose one of these user-only workflows.

### Visibility, permissions, cancellation, failures

Stream JSON exposes assistant content blocks, tool calls/results, optional partial API events, and optional hook events. `system/init` reports the selected model, available tools, MCP servers, loaded plugins, capability strings, and plugin/MCP startup errors. Nested subagent text can also be forwarded on current versions. Retryable API failures emit `system/api_retry` with attempt count, delay, HTTP status, and a categorized reason. [Anthropic: Headless streaming and retry events](https://code.claude.com/docs/en/headless#stream-responses)

Permission modes range from read-oriented/default and plan modes through allowlisted `dontAsk`, edit-accepting, model-classified auto, and dangerous bypass. Allow/deny tool rules and hooks layer on top. The app should default to a narrow Idea workspace and an interactive policy; it should never activate `bypassPermissions` merely to avoid implementing approvals. [Anthropic: Permission modes](https://code.claude.com/docs/en/permission-modes)

Anthropic documents SIGTERM as graceful external cancellation for `claude -p`: it aborts the turn, terminates any running Bash process tree, runs `SessionEnd` hooks, and exits 143. Non-zero exits, malformed/truncated streams, a final error result, exhausted retries, and startup errors must remain distinct in diagnostics. [Anthropic: Headless process lifecycle](https://code.claude.com/docs/en/headless)

## Adapter requirements

### Shared normalized events

Use a small stable union in the application layer:

```text
session-ready { harness, sessionId, model, effort, capabilities }
assistant-delta { text }
assistant-completed { text }
activity-started | activity-updated | activity-completed
choice-request { requestId, questions[] }
approval-request { requestId, action, risk, choices[] }
retrying { attempt, delayMs, category }
turn-ended { status, usage? }
failed { category, message, retryable, rawRef }
cancelled
```

Store raw JSONL alongside normalized events (with secret redaction) so adapter bugs can be diagnosed without making raw protocol shapes part of the UI domain model.

### Process supervision

- Resolve the executable path and version on app startup; show harness unavailable or unsupported states before a user begins.
- Spawn with an explicit Idea working directory and explicit permission policy.
- Persist the session/thread ID as soon as the harness emits it.
- Treat stdout as protocol-only and capture stderr separately.
- Bound initialization, IPC question, and shutdown waits.
- On Stop, use `turn/interrupt` for Codex and SIGTERM for Claude; escalate only after a short grace period and record the forced termination.
- After an app crash, offer resume from the recorded session ID. Never replay an answer automatically unless the app can prove the prior turn did not accept it.
- Classify authentication, quota/usage, model unavailable, context exhausted, permission denial, tool failure, malformed protocol, process crash, and cancellation separately.

## Product decision enabled by this research

The MVP can support both local harnesses while preserving the explicitly-invoked, human-in-the-loop workflow. The first implementation should build the Codex adapter on App Server and the Claude adapter on stream JSON plus the hook/IPC question bridge. Structured option buttons should be treated as a progressive enhancement over a universally supported typed reply, not as the sole way a conversation can advance.

## Primary sources

- [OpenAI Codex App Server](https://developers.openai.com/codex/app-server)
- [OpenAI Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [OpenAI Codex skills](https://developers.openai.com/codex/skills)
- [Anthropic Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Anthropic: Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Anthropic: Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Anthropic Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Anthropic Claude Code permission modes](https://code.claude.com/docs/en/permission-modes)
- [Anthropic Claude Code skills](https://code.claude.com/docs/en/slash-commands)
- [Anthropic Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
