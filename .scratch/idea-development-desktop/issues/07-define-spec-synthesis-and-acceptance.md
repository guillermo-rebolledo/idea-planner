# Define MVP Spec synthesis and acceptance

Type: grilling
Status: resolved
Blocked by: 01, 05

## Question

Which accepted Artifacts and Conversation context may `/to-spec` synthesize, how is its testing-seam checkpoint represented, how do the user and AI discuss and revise the MVP Spec, and what explicit acceptance state permits ticket drafting to begin?

## Answer

Spec synthesis is an explicit, reversible transition from Developing into Spec Review. It uses a deterministic frozen input manifest, preserves `/to-spec`'s human testing-seam checkpoint, writes one reviewable Draft MVP Spec at the stable path, and advances to Ticket Review only after explicit user acceptance of a validated Spec snapshot.

### Eligibility and transition

Enable **Create MVP Spec** only for a Software Idea when no Run, approval, missing Reference Attachment, file conflict, or reconciliation is active; root, Planning Index, and Conversation validate; at least one Grill Me or Wayfinder exchange completed; and the current Draft baseline is complete. The AI may promote the action through an explicit completion suggestion, but prose never starts synthesis or advances phase. The user may invoke it earlier from phase actions.

Clicking freezes synthesis inputs and starts `/to-spec`; the Idea remains Developing while the testing-seam exchange is pending. Enter Spec Review only after the user approves the testing approach and a complete valid `spec.md` publishes. Stop, failure, or invalid output leaves the Idea in Developing, preserves the frozen input manifest for an idempotent retry, and never creates a partial phase transition.

General Ideas do not expose Spec Review or `/to-spec`.

### Deterministic synthesis inputs

Create and persist an input manifest containing stable IDs and hashes for:

- Current root Idea description and `planning-index.md`
- Complete portable Conversation through the frozen boundary
- Latest complete snapshot of every active, non-discarded Draft Artifact
- Every available Reference Attachment used by included messages, passed only as a temporary sanitized derivative
- Current domain glossary, ADRs, local tracker rules, and read-only project context the skill normally explores
- For Wayfinder, its map and resolved/open decision tickets, with unresolved decisions explicitly distinguished

Grill Me may synthesize from Conversation plus any active Draft Artifacts it created; it does not require a Wayfinder map. Exclude discarded content, abandoned or incomplete writes, another planning cycle's Proposals, raw events/logs, retries, approvals, diagnostics, hidden reasoning, and provider session state.

The default is deterministic inclusion rather than a per-run checkbox list. Users remove unwanted context by discarding it during Developing. Show a compact input summary and interrupt only for missing references, invalid files, unresolved reconciliation, or an unavailable required input. **Continue without it** creates a new explicit frozen manifest; nothing disappears silently.

### Testing-seam checkpoint

Preserve `/to-spec`'s testing-seam confirmation as a conversational review before any Spec file is written. The assistant proposes the highest practical test seam, user-visible behaviors covered there, why lower seams are unnecessary, any unavoidable secondary seam, and behavior intentionally outside that seam.

Render **Approve testing approach** and **Request changes** beneath the ordinary assistant message, with the custom composer always available. A selection becomes a readable user message, not a security approval. The Run remains Waiting for user until explicit approval. Auto mode cannot approve. Feedback continues the same `/to-spec` exchange until the user approves a revised testing approach.

Record the approved testing proposal and its Conversation message ID in synthesis provenance.

### Draft publication and validation

After testing approval, let the verified `/to-spec` skill synthesize its native template into staging. Insert identity-only frontmatter without duplicating lifecycle state. Validate before promotion:

- Required sections: Problem Statement, Solution, extensive numbered User Stories, Implementation Decisions, Testing Decisions, Out of Scope, and Further Notes
- Problem and Solution remain user-centered and use canonical domain vocabulary
- User Stories are numbered, actor/feature/benefit shaped, and cover happy paths, failure/recovery, accessibility, privacy/security, offline/local behavior, and lifecycle boundaries
- Implementation Decisions capture settled behavior and contracts without fragile file paths or code, except a trimmed decision-rich prototype snippet when the upstream skill permits it
- Testing Decisions match the approved seam and test externally visible behavior
- Out of Scope preserves the Wayfinder boundary
- No secrets, absolute paths, raw logs, hidden reasoning, unsupported claims, missing identities, invalid links, unresolved conflict markers, or size-limit violations

Promote valid output transactionally to `.scratch/<idea-slug>/spec.md`, update root and Planning Index managed links, freeze the initial Spec snapshot and synthesis provenance, append a visible Spec Review divider to the permanent Conversation, and set phase to Spec Review. The app integration defers the skill's `ready-for-agent` tracker status until the user accepts the Spec; a review Draft must not claim implementation readiness.

If provider output fails validation, retain it only as a recoverable candidate for inspection, show every failed rule, and keep the prior phase/file authoritative. Retry from the same frozen manifest and stable Spec identity to avoid duplicates.

### Conversational review and revision

Spec Review continues in the same permanent Conversation and may use the selected harness/model/effort per Run. The Draft Spec remains read-only in the app, while the user discusses changes normally. Each successful revision writes a complete candidate, validates it, updates the stable `spec.md`, and shows an assistant-ui before/after snapshot diff; partial output never replaces the last valid Draft.

Suggested Responses may offer approval or common feedback, but only fill the composer and remain editable. Harness/model/session changes create the established visible boundaries and deterministic handoff. External edits while idle become Draft snapshots; edits during a Run pause for reconciliation.

The user may restore any prior Spec snapshot non-destructively. Revision and restoration do not leave Spec Review or imply acceptance.

### Explicit acceptance and invalidation

Enable **Accept MVP Spec** only when no Run/conflict is active, the testing seam was approved, `spec.md` and all managed links validate, its snapshot matches the visible Draft, and no required synthesis input is missing. Acceptance presents the full current Spec, changes from its initial Draft, the approved testing seam, and any explicitly retained unresolved notes.

Acceptance appends a visible user message, freezes the accepted Spec snapshot and exact input/provenance manifest, marks the Spec ready for ticket drafting, updates root/Planning Index transactionally, and changes phase to Ticket Review. It does not yet promote the Planning Package or make files editable; final promotion remains `/to-tickets`' approved publication event. Ticket Review exposes an explicit **Draft implementation tickets** action rather than starting `/to-tickets` automatically.

Before ticket drafting begins, the user may explicitly **Return to Spec Review**. Once ticket drafting has begun, changing or externally editing the accepted Spec invalidates the ticket baseline, stops any active ticket Run, retains its Conversation history, and requires **Return to Spec Review** before further ticket work. The app never silently rebases tickets onto a changed Spec.

Every accepted Spec remains reproducible from Idea/file IDs, frozen input hashes, Conversation boundary, testing-approval message, workflow/skill provenance, harness/version/model/effort, and final Spec snapshot. Raw provider state is not part of acceptance.
