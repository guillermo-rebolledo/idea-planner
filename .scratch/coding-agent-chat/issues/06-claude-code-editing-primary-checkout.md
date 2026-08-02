# 06 — Claude Code editing the primary checkout

**What to build:** The first working version of the actual product. The user types a coding request in a Session, and Claude Code edits the files in that Project's primary checkout while they watch. Diffs render inline in the Conversation as the agent works. Everything survives a restart.

This ticket runs in **Full access** only (`--permission-mode bypassPermissions`). Ask mode is ticket 07. That ordering is deliberate: it proves the edit-and-stream loop before adding an approval round-trip on top of it.

Edits land in the user's own checkout, in place, alongside their open editor, per [ADR 0004](../../../docs/adr/0004-in-place-primary-checkout.md). Git is the only undo; the app offers none.

Inline diffs come from the `Edit` tool result's sibling payload, which carries old content, new content, and ready-made unified-diff hunks. This is undocumented, so pin a contract test to the installed version. See `docs/harness-permission-mapping.md`.

## Muzzles left by ticket 02

Ticket 02 removed the app's own containment but left the flags that restrict the Harness, because rewriting them is this ticket's job:

- Claude is launched with `--allowedTools mcp__planning__*`, so it currently has the app's single MCP tool and **no native tools at all**.
- Codex is launched with its shell and exec tools disabled and `--sandbox workspace-write`.
- The Claude prompt still instructs the model to "use only the app-owned planning tools" and names a managed planning location that no longer exists.

Between tickets 02 and 06 the app can therefore converse and nothing else. This ticket is where the Harness gets its native tools back, under the mapping in `docs/harness-permission-mapping.md`. The stale prompt text must go with them — a false instruction to the model is worse than a stale comment, because the model acts on it.

**Blocked by:** 05b

**Status:** done

- [x] A Run launches Claude Code against the Session's Project with the primary checkout as working directory
- [x] Per-Run configuration is injected via the staged settings mechanism, never by writing to the user's own configuration — note that `CLAUDE_CONFIG_DIR` does not work for this and the current code uses it
- [x] File edits appear as inline diffs in the Conversation as they happen
- [x] A contract test pins the edit-result payload shape to the installed CLI version and fails loudly when it changes
- [x] Command execution and its output stream into the Conversation
- [x] The user message is durable before the Harness is contacted
- [x] The Conversation, including diffs, survives restart
- [x] Stopping a Run terminates the process group and leaves the Session recoverable
- [x] `pnpm verify` passes
