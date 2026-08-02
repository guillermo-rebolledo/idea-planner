# 07a — What the Run did, and what it ran under

**What to build:** A Run stops being partly invisible. When the agent runs a command, the Conversation shows the command and what it printed, as it happens. And the app stops assuming the Harness is running under the permission mode it asked for.

This is split from ticket 07b, the approval loop. They share no code, and this half is what makes that half debuggable: an approval you cannot see the consequences of is worse than none.

## Why the gap exists

Ticket 06 gave the Harness its native tools back, but the Adapter reports only that a tool was *called*. A Run that compiles, tests, or greps says nothing about the result — the person watches "Called Claude tool Bash" and learns nothing. In Codex and T3 Code the output is right there, inline, as it arrives; that is the bar.

`docs/harness-permission-mapping.md` also lists two hazards ticket 06 left unhandled, both of which make the app quietly untrustworthy about its own state.

## Decisions

**Command output is a first-class event.** The Adapter tracks a tool-use id to its name from the assistant frame, then pairs the result to it, so a command can carry what it printed. Other tools stay summary-only: a `Read` of a large file would drown the Conversation in something nobody asked to see.

**Output is durable, redacted, and capped**, exactly as a file change is. A build log can be enormous, and a command prints whatever it prints — including secrets.

**A mode mismatch is surfaced, not fatal.** If managed settings force a mode other than the one chosen, the Run still works; the person simply needs to know it is not running what they picked.

## What "as it happens" can actually mean

Measured against claude 2.1.220: the stream protocol does **not** carry partial command output. A `task_started` frame fires when a command begins and a `task_notification` reports its status, but stdout arrives whole, in the tool result, when the command finishes. There is nothing incremental to stream.

So the honest version of the bar is: the command appears the instant it starts, marked as running, and its output fills in when it lands. A person watching a test suite sees what is being run immediately rather than an empty Conversation — which is the part that actually mattered. Real partial output would need a transport that offers it, and neither this Harness nor `codex exec` does.

**Blocked by:** 06

**Status:** done

- [x] A command the agent runs appears in the Conversation with what it printed, as it happens
- [x] Command output is redacted and bounded, and a huge output cannot displace the Conversation around it
- [x] Output renders as a compact terminal block, collapsible when long
- [x] The effective permission mode is read back from the init event, and a mismatch is surfaced rather than swallowed
- [x] Staged settings are validated before spawn; invalid settings fail loudly rather than being silently ignored
- [x] A Run records the permission mode it actually ran under
- [x] The contract test replays a stream recorded from the installed CLI
- [x] `pnpm verify` passes
