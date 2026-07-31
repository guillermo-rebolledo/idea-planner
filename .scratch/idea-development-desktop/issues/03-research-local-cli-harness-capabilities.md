# Research local CLI harness capabilities

Type: research
Status: resolved

## Question

What supported capabilities and integration surfaces do the currently available Codex and Claude CLI tools provide for starting and resuming sessions, selecting models and reasoning effort, streaming output, representing structured choices, invoking installed skills, observing tool activity, cancellation, and handling process failure?

## Answer

Both installed harnesses can support the MVP, but through separate adapters: use Codex App Server's bidirectional JSONL protocol for first-class threads, turns, model/effort discovery, choices, skills, events, approvals, interruption, and typed failures; use Claude's print-mode stream JSON plus an app-owned `PreToolUse` hook/IPC bridge for `AskUserQuestion` choices. Normalize stable product events, retain raw harness events for diagnostics, and always keep typed-answer fallbacks because Codex's choice request is experimental and Claude's CLI bridge is indirect.

Full evidence and integration guidance: [Local CLI harness capabilities](../research/local-cli-harness-capabilities.md).
