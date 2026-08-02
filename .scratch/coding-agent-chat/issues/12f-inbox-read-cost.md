# 12f — What the inbox costs to keep true

**Not scheduled. Recorded so the shape is known before it hurts.**

Session status is derived from the Conversation when the inbox is read ([ticket 12](12-the-inbox.md)), and the inbox refreshes on every Conversation event with a 150ms debounce. So one Run streaming continuously means the app re-reads *every* Session's Conversation journal several times a second, eight at a time.

At ten Sessions this is invisible. At two hundred, with one Run talking, it is a continuous fan-out of journal reads for a list whose visible rows almost never change. The cost scales with how much work the person has done in this app, which is the wrong thing for it to scale with.

The fix is not a cache over the current read — a status that can disagree with the Conversation is exactly what ticket 12 refused. It is a projection: enough per Session to answer "what is this doing" (its pending approval, its active Run, whether its last message asked something) maintained as events are applied rather than recomputed by reading everything back.

Doing it now would be building for a load nobody has. Doing it after somebody notices means doing it in a hurry.

**Blocked by:** 12

**Status:** icebox

- [ ] The inbox answers what each Session is doing without reading every Conversation
- [ ] Status still comes from the Conversation, never from a copy that can disagree with it
