# 07 — Ask mode

**What to build:** The user chooses **Ask** and the agent stops to ask before doing things. An approval request appears in the Conversation, the Session moves to `blocked` and surfaces in the inbox's needs-attention group, and approving or denying resumes the Run.

Ask is implemented natively per `docs/harness-permission-mapping.md`: `--permission-mode default` plus a permission prompt tool served by the app's MCP host. The request carries the tool name, its input, and a tool-use id; the response is an allow with the (possibly unchanged) input, or a deny with a message shown to the agent.

Two verified hazards to design around. Managed enterprise settings outrank CLI arguments, so the effective mode must be asserted from the init event after spawn rather than assumed. Invalid staged settings are silently ignored, so the generated settings must be validated in-process before spawning.

`blocked` means the agent is mid-Run and cannot proceed — an approval request or a structured question. A Run that simply finished its turn is `idle`, never `blocked`.

**Blocked by:** 06

**Status:** ready-for-agent

- [ ] The user selects Ask or Full access per Run, with the choice visible in the composer
- [ ] In Ask mode, edits and commands produce an approval request in the Conversation
- [ ] Approving resumes the Run; denying returns the message to the agent and the Run continues
- [ ] The Session shows `blocked` while an approval is outstanding, and leaves it on resolution
- [ ] The effective permission mode is read back from the init event and a mismatch is surfaced rather than swallowed
- [ ] Staged settings are validated before spawn; invalid settings fail loudly
- [ ] Closing the app with an approval outstanding leaves the Session recoverable
- [ ] `pnpm verify` passes
