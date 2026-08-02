# 03 — Rename Idea to Session and retire the planning vocabulary

**What to build:** The code and `CONTEXT.md` agree. Every name a reader meets — in the IPC contract, in Core, in the Renderer, in tests — is a term from the glossary, and no term from the retired planning model survives anywhere.

Renamed: Idea → **Session**, Harness Session → **Harness Thread**, Working Directory → **Checkout**, provider → **Harness**.

Deleted outright, with no replacement: `IdeaKind` and the Software/General split, `PlanningWorkflow`, Draft Artifact, Proposal, MVP Spec, Implementation Ticket, Planning Package, Planning Index, Idea Asset, and the Captured → Developing → Spec Review → Ticket Review → Ready lifecycles. Sessions do not complete; they are archived.

This is a wide refactor rather than a vertical slice: it is one mechanical change whose blast radius fans across the whole codebase. It is deliberately sequenced *after* tickets 01 and 02, which remove most of the call sites it would otherwise have to touch. It is scoped as a single ticket — not expand–contract — because the product has no users, no external consumers of the contract, and one repository. If the rename cannot be landed green in one pass, stop and re-plan it as expand–contract rather than merging it broken.

**Blocked by:** 01, 02

**Status:** ready-for-agent

- [ ] `CONTEXT.md` terms are the only domain vocabulary in the contract, Core, Renderer, and tests
- [ ] No occurrence of Idea, workflow, Draft Artifact, Proposal, MVP Spec, Implementation Ticket, or Planning Package remains outside `.scratch/research/` and git history
- [ ] The contract version is incremented and existing on-disk state is either migrated or explicitly discarded on launch — decide which and say so in the ticket comments
- [ ] Session status is `running | blocked | idle | failed`, with pinned and archived as separate user flags
- [ ] `pnpm verify` passes and the packaged-shell acceptance suite passes
