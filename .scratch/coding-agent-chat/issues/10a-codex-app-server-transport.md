# 10a — Codex on the app-server protocol

**What to build:** Codex stops speaking `codex exec --json` and starts speaking the app-server protocol, so a Session can run on it at all: chat, inline diffs, per-Run configuration, and continuity across a Harness switch. Approvals are 10b.

`exec` was not a preference this replaces but a dead end. Two findings, both reproduced against the installed binary and recorded in `docs/harness-permission-mapping.md`: it *auto-rejects* approvals without emitting an event, and its file-change items carry a path and a kind with no diff. Neither Ask mode nor an inline change is possible on it, which is why ticket 06 set Codex's conversation capability to none rather than leaving a Harness that starts and then does nothing.

## Why this splits from 10b

The split follows 07a/07b, for the same reason: the transport and the approval loop share no code, and this half is what makes that half debuggable. A Run has to reach the Harness and show what it did before an approval inside it means anything.

Full access needs no approvals — `approvalPolicy: never` raises none — so this half is shippable on its own, with Ask still refused on Codex exactly as 07a refused it on Claude.

**Blocked by:** 08

**Status:** done

- [x] The Codex adapter speaks the app-server protocol; the `exec --json` path is gone
- [x] Protocol types are generated from the CLI's schema rather than transcribed, and regenerating is a documented step
- [x] Full access maps to `never` with `danger-full-access`, per the mapping document
- [x] Inline diffs render from the protocol's per-file diffs
- [x] Per-Run configuration is injected without touching the user's own configuration
- [x] Switching Harness mid-Conversation starts a new Harness Thread without losing history
- [x] Codex is offered as a Harness that can run a Session again
- [x] Divergences from Claude behaviour are stated in the UI, not left to be discovered
- [x] `pnpm verify` passes

## What moving off `exec` changed, beyond the transport

`codex exec` was launched with `--disable shell_tool --disable unified_exec --disable apps --disable browser_use --disable computer_use --disable hooks --disable plugins`, and those are `exec` flags with no argv on `app-server`. A Full access Run therefore reaches more of Codex's own tool surface than it did — its browser and computer use, its hooks, its plugins. That is a real widening and it is recorded here rather than left to be discovered.

It is defensible for now: Full access is the mode whose whole meaning is that the Harness is trusted with its own tools, and `danger-full-access` already disables its sandbox. It is not defensible in Ask, where the point is that the person decides. Whether `thread/start.config` can express the same disabling is unverified — the schema is `additionalProperties: true` with no documented allowlist — so 10b should verify it against the installed binary before Ask ships, and say what it found.

## What a turn ending means here

`codex app-server` is a server: it answers a turn and waits for the next. Nothing ends the process, so the Run ends when its turn does — `turn/completed` concludes the Run and stops the process, rather than leaving one running for a turn nobody will ask for. `turn/interrupt` would be the graceful version of Stop, and belongs with 10b's approval work.
