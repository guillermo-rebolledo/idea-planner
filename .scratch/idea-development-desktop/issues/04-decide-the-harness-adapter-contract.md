# Decide the harness adapter contract

Type: grilling
Status: resolved
Blocked by: 03

## Question

What stable application-level contract should normalize Codex and Claude Runs, events, Suggested Responses, skill invocation, permissions, cancellation, resumption, and errors without erasing harness-specific capabilities?

## Answer

Use separate Codex and Claude adapters behind a versioned, internal, capability-negotiated event-stream contract. The renderer may send only typed Run commands and receive validated normalized events and derived Run state; executable paths, process handles, provider streams, hooks, and diagnostics remain behind the Electron process boundary. There is no public adapter API in the MVP.

The conceptual adapter surface is:

```ts
interface HarnessAdapter {
  probe(): Promise<HarnessCapabilities>
  prepareRun(input: RunPreparation): Promise<PreparedRun>
  startTurn(input: TurnSubmission): AsyncIterable<RunEvent>
  answerChoice(input: ChoiceAnswer): Promise<void>
  decideApproval(input: ApprovalDecision): Promise<void>
  cancel(reason: CancelReason): Promise<void>
  dispose(): Promise<void>
}
```

### Event and persistence guarantees

- Each Run owns an ordered, append-only normalized event stream. Every envelope carries a stable event ID, monotonic Run sequence, timestamp, Idea ID, Run ID, Harness Session ID when known, contract version, adapter version, and provider protocol/version metadata.
- Runtime validation occurs before persistence or renderer delivery. Unknown noncritical provider activity degrades to a generic collapsed activity event; an unknown event required for correctness stops the Run as an incompatibility.
- User submissions are persisted before provider contact and carry stable submission IDs. Automatic retry is allowed only when the adapter can prove the harness did not accept the turn. An uncertain outcome must be inspected by resuming the session or exposed as **Recover Run**, never resent blindly.
- Assistant deltas render immediately and persist as coalesced partial-message checkpoints rather than per-token writes. A completed message is authoritative. Stopped, interrupted, or crashed partial messages remain visible and labeled incomplete.
- Draft Artifact truth comes from the managed-file supervisor's validated filesystem snapshots, not provider file-change events. Provider tool events are activity hints only. Incomplete writes never replace the last complete atomic Draft Artifact snapshot.
- Persist the normalized stream plus an allowlisted diagnostic projection containing protocol structure, identifiers, timing, statuses, safe error codes, and usage. Complete raw frames exist only briefly in process memory. Message content, reasoning, paths, commands, tool arguments, environment values, and unknown raw fields are not persisted as diagnostics.

### Run and process lifecycle

- One Run remains one user submission followed by AI work until waiting, completion, failure, or Stop. One blocking choice or approval may be outstanding per Run; Stop is always available.
- Each active Run owns one supervised provider process tree. Codex starts App Server, initializes it, starts or resumes the Idea thread, executes one turn, and shuts down. Claude starts one stream-JSON process, starts or resumes its session, executes the turn, and exits.
- A process remains alive only while its turn is executing or waiting for an in-turn choice or approval. Completion, failure, Stop, app exit, and update must terminate and verify the entire process tree.
- Provider-managed transient retries may continue with visible retry activity. A terminal retry always requires user action.
- If the app exits or crashes during a pending question, preserve the partial response and question but mark the old Run interrupted. Answering after restart creates a new Run and submission ID with the question in its handoff. Security approvals expire and are never replayed.

### Capabilities, configuration, and continuity

- Probe harness readiness at startup and refresh discoverable model/effort choices when the picker opens. Capability probes outrank exact version locks: warn on untested versions, but block only failed handshakes or missing required capabilities.
- Freeze an immutable Run snapshot containing executable identity, harness/protocol versions, capabilities, model, effort, resolved skill identity/path/hash, and permission profile. Installation or configuration changes apply only to later Runs.
- A Conversation may span Harness Sessions. Model or effort changes resume the current provider session when supported and create a visible configuration boundary; incompatibility falls back to a fresh session.
- Switching Codex ↔ Claude always starts a fresh provider session and creates a visible harness boundary. The app makes a deterministic handoff without a hidden AI Run: current phase, workflow, decisions, Artifact paths, and recent turns go inline, while the complete normalized Conversation is available as local Markdown.
- If a saved provider session is missing or cannot resume, automatically create a replacement from that handoff and show **Provider session restored from local history**. Provider sessions improve continuity but are never the source of truth.

### Conversation, choices, skills, and activity

- Native structured choices are preferred. Parse plain Markdown options only when unambiguous, and always retain a custom typed response.
- Every selected option becomes a normal readable user message in the permanent Conversation while the adapter also sends the native structured answer. Structured protocol metadata is not the durable meaning.
- Security approvals use separate activity cards and operational events. They do not become Conversation messages or enter cross-harness handoffs; when relevant, the Conversation may retain only a neutral consequence.
- Hard-blocked actions are denied automatically and shown as compact blocked activity. Only policy-allowable actions may produce approval cards, and there is no **allow anyway** path.
- Preserve the user's prompt verbatim. Workflow invocation is Run metadata plus a visible marker such as **Grill Me started · via Claude · based on Matt Pocock's skill**. The adapter separately sends Codex's explicit skill item/`$skill` syntax or Claude's slash command and records resolved provenance.
- Detect harness and skill readiness before submission. The app never installs skills; when missing, show the copyable `npx skills@latest add mattpocock/skills` command, Matt Pocock's GitHub repository, and a readiness re-check action.
- Normalize a small product-owned activity vocabulary with sanitized summaries. Provider tool names may appear as secondary labels; raw arguments never reach the renderer.
- Normalize only provider-supplied reasoning summaries, plans, and progress. They remain collapsed, provider-attributed activity and do not enter the portable Conversation or handoff unless they contain an explicit user-facing decision. Never request or persist hidden chain-of-thought.
- `turn-ended` describes transport completion, not workflow completion. A separate `workflow-completion-suggested` event may come only from a native choice or unambiguous completion prompt. It may reveal **Create MVP Spec** but never advances phase automatically.

### Usage and failures

- Usage fields are optional and provider-reported: input, cached input, output, total tokens, and context-window limit, each tagged `live`, `final`, or `unavailable`. Per-Idea cross-provider totals are informational. Do not infer quota remaining, subscription allowance, or cost.
- Map provider failures into stable categories: harness unavailable/incompatible, authentication, usage/rate limit, model/effort unavailable, context exhausted, skill missing/incompatible, permission/policy, filesystem conflict, protocol, provider, process crash, and cancelled.
- Each failure exposes a safe message, retryability, recommended recovery, and diagnostic reference. Sanitized provider wording may supplement but never replace the product category.
- Use T3 Code's bounded PATH-hydration pattern with explicit-path fallback and native probes. Executing login-shell startup files requires one-time consent.
