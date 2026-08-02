# 06 — Claude Code editing the primary checkout

**What to build:** The first working version of the actual product. The user types a coding request in a Session, and Claude Code edits the files in that Repository's primary checkout while they watch. Diffs render inline in the Conversation as the agent works. Everything survives a restart.

This ticket runs in **Full access** only (`--permission-mode bypassPermissions`). Ask mode is ticket 07. That ordering is deliberate: it proves the edit-and-stream loop before adding an approval round-trip on top of it.

Edits land in the user's own checkout, in place, alongside their open editor, per [ADR 0004](../../../docs/adr/0004-in-place-primary-checkout.md). Git is the only undo; the app offers none.

Inline diffs come from the `Edit` tool result's sibling payload, which carries old content, new content, and ready-made unified-diff hunks. This is undocumented, so pin a contract test to the installed version. See `docs/harness-permission-mapping.md`.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] A Run launches Claude Code against the Session's Repository with the primary checkout as working directory
- [ ] Per-Run configuration is injected via the staged settings mechanism, never by writing to the user's own configuration — note that `CLAUDE_CONFIG_DIR` does not work for this and the current code uses it
- [ ] File edits appear as inline diffs in the Conversation as they happen
- [ ] A contract test pins the edit-result payload shape to the installed CLI version and fails loudly when it changes
- [ ] Command execution and its output stream into the Conversation
- [ ] The user message is durable before the Harness is contacted
- [ ] The Conversation, including diffs, survives restart
- [ ] Stopping a Run terminates the process group and leaves the Session recoverable
- [ ] `pnpm verify` passes
