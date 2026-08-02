# 03 — Rename Idea to Session and retire the planning vocabulary

**What to build:** The code and `CONTEXT.md` agree. Every name a reader meets — in the IPC contract, in Core, in the Renderer, in tests — is a term from the glossary, and no term from the retired planning model survives anywhere.

Renamed: Idea → **Session**, Harness Session → **Harness Thread**, Working Directory → **Checkout**, provider → **Harness**.

Deleted outright, with no replacement: `IdeaKind` and the Software/General split, `PlanningWorkflow`, Draft Artifact, Proposal, MVP Spec, Implementation Ticket, Planning Package, Planning Index, Idea Asset, and the Captured → Developing → Spec Review → Ticket Review → Ready lifecycles. Sessions do not complete; they are archived.

This is a wide refactor rather than a vertical slice: it is one mechanical change whose blast radius fans across the whole codebase. It is deliberately sequenced *after* tickets 01 and 02, which remove most of the call sites it would otherwise have to touch. It is scoped as a single ticket — not expand–contract — because the product has no users, no external consumers of the contract, and one repository. If the rename cannot be landed green in one pass, stop and re-plan it as expand–contract rather than merging it broken.

## Orphans left by ticket 02

Ticket 02 removed the `suggest_workflow_completion` tool and the callback that produced it, so nothing can now emit a `workflow-completion-suggested` event. The rest of that plumbing was deliberately left standing — the event, the `workflow-completion` conversation entry, the `workflowCompletionSuggested` snapshot flag, and the disabled "Create MVP Spec" button — because the entry kind is **persisted in conversation journals**, and changing an on-disk shape belongs with the contract bump this ticket owns.

Remove it here, as part of retiring the planning vocabulary, and let the migrate-or-discard decision below cover any journal that already contains one.

Every Run also freezes `permissionProfile: 'planning-v1'` into its durable configuration, naming a profile that no longer exists. Like the entry kind above, it is a persisted shape, so it belongs with the contract bump here rather than with the deletion that orphaned it.

**Blocked by:** 01, 02

**Status:** done

- [x] `CONTEXT.md` terms are the only domain vocabulary in the contract, Core, Renderer, and tests
- [x] No occurrence of Idea, workflow, Draft Artifact, Proposal, MVP Spec, Implementation Ticket, or Planning Package remains outside `.scratch/research/` and git history
- [x] The contract version is incremented, and a library holding the previous format is ignored rather than migrated, read, or altered
- [x] The unreachable `workflow-completion` plumbing and the frozen `planning-v1` permission profile are gone
- [x] `pnpm verify` passes and the packaged-shell acceptance suite passes

## Comments

**On-disk state is discarded, not migrated.** There are no users, and ticket 05 abolishes this storage format entirely, so a migration would be written only to be deleted two tickets later. A library holding the previous format is left untouched on disk and simply not read.

**The rename reaches the disk**: `idea.md`, `.idea/`, and the frontmatter keys change with the code. Those files die in ticket 05, so this is knowingly throwaway — but a half-renamed codebase is the confusion this ticket exists to end, and it is a handful of constants beside sixteen hundred identifiers.

**Session status is deliberately not introduced.** The original criterion asked for `running | blocked | idle | failed`. Nothing can produce those yet: `blocked` arrives with approvals in ticket 07, and the inbox groups in ticket 12. Shipping a four-value status with one reachable value would repeat ticket 01's `openState` mistake — a field admitting a single value, kept alive by a test that hand-injects the rest. The single-valued `status: 'saved'` is deleted here instead, and ticket 12 introduces Session status when there are states to hold.

**The container of Sessions is called the library** for now. It has no glossary entry because ticket 05 abolishes it, and inventing a term for something with a two-ticket lifespan is cost without payoff. `Project` is not that term — a Project is a git repository the user works in, which is a different thing.
