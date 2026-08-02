# 12e — What a crash loses

**What to build:** A Run that never concludes records no Checkout comparison at all. Quitting the app or crashing mid-Run leaves the work the agent did up to that moment invisible in the changed-files panel — which is the worst case to lose it in, because it is exactly when the person cannot ask the agent what it was doing.

Two things cause it, and [12c](12c-complete-changed-files.md) is responsible for both. The baseline tree lives only in memory, so a restart has nothing to compare against. And the startup sweep that stops abandoned snapshots accumulating deletes the objects a recovery would need — a fix for the leak that made the loss permanent.

Both come apart the same way: write the baseline beside its own snapshot, and make the sweep read what it is about to delete. A directory whose Run already concluded is rubbish and goes. A directory whose Run did not is the record of a Run nobody closed, and its comparison is made then, at startup, before it is cleaned up.

One honesty cost, and it must be stated rather than hidden: a comparison made at startup measures the Checkout as it is *then*, so anything the person changed between the crash and reopening the app lands in that Run. A Run that ended normally is unaffected — its comparison still happens the moment it ends.

**Blocked by:** 12c

**Status:** ready-for-agent

- [ ] A Run whose app quit or crashed still reports what it changed, on the next start
- [ ] Snapshots from Runs that did conclude are still cleaned up
- [ ] A comparison recovered at startup is recorded against the Run it belongs to
- [ ] `pnpm verify` passes
