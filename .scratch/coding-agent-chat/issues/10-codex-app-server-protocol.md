# 10 — Codex on the app-server protocol

**What to build:** Codex reaches parity with Claude Code as a Harness: the user picks it, chats, watches inline diffs, answers approvals in Ask mode, and grants Standing Approvals that persist for the Project.

This requires abandoning `codex exec`, which the current adapter parses. Two independent findings make it unusable, both reproduced against the installed binary and recorded in `docs/harness-permission-mapping.md`: `exec` has no approval flag and *auto-rejects* approvals without emitting an event, and its file-change items carry only a path and a kind with no diff. Ask mode and inline diffs are both impossible on it. The app-server protocol provides per-file diffs, a full turn diff, and a complete approval round-trip.

Standing Approvals map onto Codex's own execpolicy rules, which split compound shell commands so that allowing one command cannot smuggle another. The approval request itself proposes the rule, so the app should use what Codex computes rather than synthesising prefixes as it must for Claude. Do not build app-side interception.

Generate protocol bindings from the CLI's own schema command; the published documentation disagrees with the shipped binary on enum spellings.

Codex is currently reported as unable to run a Session at all. Ticket 06 set its conversation capability to none rather than leaving a Harness that starts and then does nothing: its Adapter parses `codex exec --json`, which carries no diff and has no approval flag, so it can support neither of the two things tickets 06 and 07 added. Restoring the capability is part of this rewrite.

**Blocked by:** 08

**Status:** ready-for-agent

- [ ] The Codex adapter speaks the app-server protocol; the `exec --json` path is gone
- [ ] Protocol types are generated from the CLI's schema rather than transcribed, and regenerating is a documented step
- [ ] Ask maps to untrusted approval with workspace-write, Full access to never with full access, per the mapping document
- [ ] Approval requests surface in the Conversation and resolve identically to Claude from the user's point of view
- [ ] Standing Approvals use the rule proposed in the approval request
- [ ] Inline diffs render from the protocol's per-file diffs
- [ ] Per-Run configuration is injected without touching the user's own configuration
- [ ] Switching Harness mid-Conversation starts a new Harness Thread without losing history
- [ ] Divergences from Claude behaviour are stated in the UI, not left to be discovered
- [ ] `pnpm verify` passes
