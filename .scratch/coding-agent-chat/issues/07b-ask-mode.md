# 07b — Ask mode

**What to build:** The person chooses **Ask** and the agent stops to ask before editing or running anything. The request appears in the Conversation, the Run is blocked while it stands, and approving or denying resumes it.

Ask is implemented natively per `docs/harness-permission-mapping.md`: `--permission-mode default` plus a permission prompt tool served by the app's MCP host. The request carries the tool name, its input, and a tool-use id; the response is an allow with the (possibly unchanged) input, or a deny with a message shown to the agent.

## Blocked belongs to the Run, not yet to the Session

Ticket 07 originally said the Session shows `blocked`. Ticket 03 deliberately declined to introduce Session status while only one value was reachable, and ticket 12 owns it. So the blocked signal lives on the **Run** here — an approval is outstanding — and ticket 12 maps it into the inbox's needs-attention group. Half-introducing a status that 12 then rewrites is the churn both tickets exist to avoid.

## What 07a left standing

Ask is **refused** today. Ticket 07a mapped it onto the Harness mode that asks, then found that starting such a Run without a prompt tool produces one that stalls on its first tool call while looking like it is working. The Run service throws, the composer offers Full access and shows Ask as unavailable. Serving the prompt is what makes Ask selectable again, and removing that refusal is part of this ticket.

The mode a Run really ran under is already read back from the init event and recorded in the Conversation when it differs from what was asked for. Approvals depend on that being true: a rule that never took effect must not look like one that did.

**Blocked by:** 07a

**Status:** ready-for-agent

- [ ] The person selects Ask or Full access per Run, with the choice visible in the composer
- [ ] In Ask mode, edits and commands produce an approval request in the Conversation
- [ ] Approving resumes the Run; denying returns the message to the agent and the Run continues
- [ ] A Run is blocked while an approval is outstanding, and leaves that state on resolution
- [ ] Closing the app with an approval outstanding leaves the Session recoverable
- [ ] `pnpm verify` passes
