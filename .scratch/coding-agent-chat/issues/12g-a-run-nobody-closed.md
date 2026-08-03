# 12g — A Run nobody closed

**What to build:** A Run that was in flight when the app quit or crashed is never finalized. Its Conversation keeps `activeRunId` set, so the Session reads as `running` — in the inbox, in its own surface, and in the collapsed rail — until the person develops it again. It says the agent is working when no agent is working, and the one signal the inbox is built to be trusted about is what is happening right now.

Nothing recovers it today. The broker knows a supervision failure needs recovering before another Run starts ([ticket 04](04-runs-and-supervision.md)), but nothing walks the Conversations at startup and closes what was left open.

The Run's own record is the evidence: it was accepted, it started, and no boundary ever ended it. Closing it means saying which of those it was — a Run the app abandoned is a failure of this app, not of the Harness, and the person's message should still be resendable.

[12e](12e-what-a-crash-loses.md) already walks abandoned Checkout snapshots at startup and knows the Session and Run each belongs to, so it is the obvious place to do this — but only for Runs that took a snapshot, and this is true of every Run.

**Blocked by:** 12e

**Status:** done

- [x] A Run left open by a quit or a crash is closed on the next start, saying so
- [x] The Session stops reading as `running` once it is closed
- [x] The message that started it is still resendable
- [x] A Run that is genuinely still going is never closed by this
- [x] `pnpm verify` passes

## Answer — asked of the Conversations, not of the snapshots

The startup pass reads which Runs their own Conversations still have open, rather than only those that happened to take a Checkout snapshot. Every Run has a Conversation; only some have a snapshot.

Each one is closed as `failed` with the summary `The app closed while this Run was working`. The category comes out as `process-crash` or `uncertain-submission` depending on whether the Harness ever said anything, and both of those are resendable — so the person's message is still theirs to send again, which is what an abandoned Run owes them.

## Answer — what counts as still going

A Run this process is running is skipped. The broker knows the ones with a process, and that is not all of them: a Run is durably open from the moment its boundary is written, and its process does not exist until several steps later. In that window the broker would say nothing is running and the pass would close a Run that is starting. So the service also keeps what it has accepted and not yet ended, and a test drives the pass from inside that window.

It matters because the pass is not only run at startup — `develop` awaits it too, so without this, starting one Session's Run could close another's.
