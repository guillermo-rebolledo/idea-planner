# 12f — What the inbox costs to keep true

**Iceboxed, then asked for. Built before anybody felt it, on request.**

Session status is derived from the Conversation when the inbox is read ([ticket 12](12-the-inbox.md)), and the inbox refreshes on every Conversation event with a 150ms debounce. So one Run streaming continuously means the app re-reads *every* Session's Conversation journal several times a second, eight at a time.

At ten Sessions this is invisible. At two hundred, with one Run talking, it is a continuous fan-out of journal reads for a list whose visible rows almost never change. The cost scales with how much work the person has done in this app, which is the wrong thing for it to scale with.

The fix is not a cache over the current read — a status that can disagree with the Conversation is exactly what ticket 12 refused. It is a projection: enough per Session to answer "what is this doing" (its pending approval, its active Run, whether its last message asked something) maintained as events are applied rather than recomputed by reading everything back.

Doing it now would be building for a load nobody has. Doing it after somebody notices means doing it in a hurry.

**Blocked by:** 12

**Status:** done

- [x] The inbox answers what each Session is doing without reading every Conversation
- [x] Status still comes from the Conversation, never from a copy that can disagree with it

## Answer — a projection that cannot lie for long

Each Session keeps a `state.json` beside its Conversation: the active Run, the Approval Requests nobody has answered, the last thing anybody said and whether it offered choices, and how the last Run ended. That is everything the inbox's rule needs, and it is a few hundred bytes rather than a journal.

It is written at the one place every Conversation entry goes through, folding the new entry into what was already known — never by reading the journal back. The journal is written first and the projection after it, so a crash between them leaves a projection that is *behind*, never one that is ahead of what the Conversation says.

## Answer — how it stays honest

The projection records how many bytes of journal it was derived from, and every read compares that with the journal as it is now. Any divergence — a write that never landed, a crash between the two, a file edited by hand — is seen, and the projection is rebuilt from the journal and rewritten. A missing projection rebuilds the same way, which is also how every Session that existed before this ticket gets one.

So the Conversation stays the truth and this only says so faster, which is the condition ticket 12 set. A test proves the inbox reads the projection (by tampering with one whose byte count still matches), and two more prove a stale one and a missing one both give the Conversation's answer.

The rule itself moved with the data: `describeState` lives beside the projection rather than in Core's mailbox query, so what the inbox means by blocked, running, failed and idle is stated once.

## Answer — what else got cheaper

Closing Runs nobody closed ([12g](12g-a-run-nobody-closed.md)) asks the same projection which Runs are still open, so the startup pass no longer reads every Conversation either.
