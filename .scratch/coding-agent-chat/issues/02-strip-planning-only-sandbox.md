# 02 — Strip the planning-only sandbox

**What to build:** Runs still launch, stream, and persist, but the app no longer enforces a planning-only policy on the Harness. The fixed sandbox that blocked source edits, command execution, and Git mutation is removed, per [ADR 0003](../../../docs/adr/0003-harness-native-permissions.md).

This is a prefactor alongside ticket 01. It deliberately leaves the app *less* capable in the interim: with the planning write path gone and native permissions not yet wired, a Run can converse but not usefully change anything. That gap closes in ticket 06.

The Main-owned MCP host is reduced, not deleted. It keeps `offer_response_options`, which has no native equivalent on either Harness and backs Suggested Responses. Everything else it advertised — planning file reads, writes, renames, deletes, search — goes.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] The planning policy module and its approval matrix are gone
- [ ] The MCP tool host advertises only `offer_response_options`
- [ ] The per-Run capability socket and sandboxed stdio proxy still work for that one tool
- [ ] Native process-group launch, terminate, reap, and verify are untouched
- [ ] A Run still streams normalized events and persists them durably
- [ ] The follow-up section of [ADR 0001](../../../docs/adr/0001-adopt-effect-in-core.md) is accurate about what remains
- [ ] `pnpm verify` passes; tests asserting planning containment are removed rather than skipped
