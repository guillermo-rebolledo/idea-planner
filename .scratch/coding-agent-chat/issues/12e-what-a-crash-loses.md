# 12e — What a crash loses

**What to build:** A Run that never concludes records no Checkout comparison at all. Quitting the app or crashing mid-Run leaves the work the agent did up to that moment invisible in the changed-files panel — which is the worst case to lose it in, because it is exactly when the person cannot ask the agent what it was doing.

Two things cause it, and [12c](12c-complete-changed-files.md) is responsible for both. The baseline tree lives only in memory, so a restart has nothing to compare against. And the startup sweep that stops abandoned snapshots accumulating deletes the objects a recovery would need — a fix for the leak that made the loss permanent.

Both come apart the same way: write the baseline beside its own snapshot, and make the sweep read what it is about to delete. A directory whose Run already concluded is rubbish and goes. A directory whose Run did not is the record of a Run nobody closed, and its comparison is made then, at startup, before it is cleaned up.

One honesty cost, and it must be stated rather than hidden: a comparison made at startup measures the Checkout as it is *then*, so anything the person changed between the crash and reopening the app lands in that Run. A Run that ended normally is unaffected — its comparison still happens the moment it ends.

**Blocked by:** 12c

**Status:** done

- [x] A Run whose app quit or crashed still reports what it changed, on the next start
- [x] Snapshots from Runs that did conclude are still cleaned up
- [x] A comparison recovered at startup is recorded against the Run it belongs to
- [x] `pnpm verify` passes

## Answer — the baseline says what it is

A snapshot directory now holds a `baseline.json` beside its objects: the Session, the Run, the Checkout, and the tree that was taken. That is the whole of what a restart needs — the objects were already there, and only the app's memory of what they were for was missing.

The startup sweep reads it rather than deleting blindly. A directory it can read is compared and recorded against the Run it belongs to, and only then removed; a directory it cannot read is rubbish and goes, because a snapshot nobody can interpret is one that would sit there forever. The sweep is idempotent and runs once per launch.

## Answer — a Run cannot be swept out from under itself

`develop` waits for the sweep before taking its own snapshot. A Run resent under the same submission has the same key, and therefore the same directory: without the wait, a Run could take its baseline and have the sweep delete it a moment later.

## Answer — what a recovered comparison is worth

It measures the Checkout as it is when the app reopens, so anything the person changed between the crash and reopening lands in that Run. That is the cost of answering at all, and it is only paid by Runs that never concluded — a Run that ended normally is still compared the moment it ends.

The entries land after that Run's ending boundary in the Conversation, which is exactly what happened: the app learned this after the Run was over.
