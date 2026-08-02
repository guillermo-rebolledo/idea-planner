# 05a — Sessions become app-owned

**What to build:** Sessions stop being folders of Markdown in a library the user chose, and become app-owned state ([ADR 0002](../../../docs/adr/0002-app-owned-session-state.md)). There is no library, no folder to pick before the app is usable, and no user-visible Markdown anywhere. A Session belongs to a Project, and onboarding asks for a first Project rather than a library.

This is the model. Ticket 05b is the surface: the composer, the `+` on a Project row, and the `workingDirectory` → `checkout` rename.

## Why this is split from 05b

The original ticket 05 asked for five unrelated changes at once: retiring the library, moving storage, changing the Session key from a path to an id, a new launch surface, new onboarding, Project binding, a field rename, and the atomicity fix. `core.ts` alone carries 53 references to the library, and `relativePath` is the Session key in roughly two hundred places across the contract, Core, Main, the run service and the Renderer.

Ticket 03 was allowed to be wide because it was one mechanical change applied everywhere. This is several different changes, so it is two tickets.

## Decisions

**Identity is an opaque Session id, not a path.** Sessions are app-owned now; a folder name as primary key is the thing being escaped.

**Layout** is `userData/sessions/<id>/` holding `session.json`, `conversation.jsonl`, and `runs/<runId>.json` — today's `.session/` directory, minus the Markdown, moved out of the user's folder and into the store ticket 04 created. There is one store, not two.

**Atomicity**: a Session exists if and only if its `session.json` parses, and that file is written staged-then-renamed. The Conversation journal stays append-only, and a torn trailing line is discarded when it is read. This closes the regression below without a transaction manager.

**The SQLite search index is deleted.** It existed to index canonical Markdown that no longer exists. Searching titles and recent messages in memory replaces it, and an index returns when there is a corpus worth indexing.

## The regression this ticket closes

Ticket 01 removed transactional staging, so multi-document writes became several sequential file writes with no atomicity, and it removed the safety net in the same change: a partially written Session no longer parsed, the summary reader returned nothing for it, and **the Session disappeared from the inbox without a word**.

That was accepted deliberately, because the file-per-Session model was about to stop existing and rebuilding transactional Markdown writes would have been work thrown away. This is where the durability hole closes.

**Blocked by:** 03, 04

**Status:** ready-for-agent

- [ ] A Session is identified by an opaque id; no Session is addressed by a path
- [ ] Sessions, Conversations, and Runs persist in the app-owned store and survive restart
- [ ] Every Session belongs to a Project, and a Session cannot exist without one
- [ ] A half-written Session is never silently dropped, and a torn journal line never loses the Conversation before it
- [ ] No library path is requested anywhere, and onboarding asks for a first Project
- [ ] No user-visible Markdown is written, and removing a Project never touches the directory on disk
- [ ] Losing the store loses history but never work, because work lives in the Project under git
- [ ] `pnpm verify` passes, and the packaged-shell acceptance suite covers restart
