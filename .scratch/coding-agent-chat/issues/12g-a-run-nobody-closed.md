# 12g — A Run nobody closed

**What to build:** A Run that was in flight when the app quit or crashed is never finalized. Its Conversation keeps `activeRunId` set, so the Session reads as `running` — in the inbox, in its own surface, and in the collapsed rail — until the person develops it again. It says the agent is working when no agent is working, and the one signal the inbox is built to be trusted about is what is happening right now.

Nothing recovers it today. The broker knows a supervision failure needs recovering before another Run starts ([ticket 04](04-runs-and-supervision.md)), but nothing walks the Conversations at startup and closes what was left open.

The Run's own record is the evidence: it was accepted, it started, and no boundary ever ended it. Closing it means saying which of those it was — a Run the app abandoned is a failure of this app, not of the Harness, and the person's message should still be resendable.

[12e](12e-what-a-crash-loses.md) already walks abandoned Checkout snapshots at startup and knows the Session and Run each belongs to, so it is the obvious place to do this — but only for Runs that took a snapshot, and this is true of every Run.

**Blocked by:** 12e

**Status:** ready-for-agent

- [ ] A Run left open by a quit or a crash is closed on the next start, saying so
- [ ] The Session stops reading as `running` once it is closed
- [ ] The message that started it is still resendable
- [ ] A Run that is genuinely still going is never closed by this
- [ ] `pnpm verify` passes
