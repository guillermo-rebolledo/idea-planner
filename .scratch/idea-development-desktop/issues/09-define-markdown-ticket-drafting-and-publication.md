# Define Markdown ticket drafting and publication

Type: grilling
Status: resolved
Blocked by: 07

## Question

How should `/to-tickets` present its dependency-aware vertical-slice breakdown for discussion, capture approval of granularity and blocking edges, and publish one local Markdown document per approved Implementation Ticket without an external issue tracker?

## Answer

Ticket drafting is an explicit conversational quiz based on one immutable accepted MVP Spec. No ticket files exist until the user approves the complete breakdown. That existing `/to-tickets` approval becomes the single final Planning Package acceptance: the app then publishes one validated local Markdown file per ticket transactionally and enters Ready only when the entire package is authoritative.

### Eligibility and frozen input

Enable **Draft implementation tickets** only in Ticket Review when the accepted Spec snapshot and its synthesis provenance still validate; no Run, approval, file conflict, or reconciliation is active; and every required input is available. Spec acceptance never auto-starts `/to-tickets`.

Freeze a content-addressed ticket input manifest containing:

- Accepted `spec.md` snapshot and approved testing seam
- Complete portable Conversation through Spec acceptance
- Root Idea and `planning-index.md`
- Current domain glossary, ADRs, local tracker rules, and relevant read-only project context
- Workflow/skill, harness/version/model/effort, and Spec synthesis provenance

The accepted Spec is normative. Conversation context may clarify it but cannot silently override it. A material conflict must appear in the Conversation and return the user to Spec Review or receive an explicit clarification before breakdown continues. Any later Spec change invalidates the ticket manifest, stops active ticket work, retains history, and requires **Return to Spec Review**; tickets are never silently rebased.

### Native conversational quiz

Continue the same permanent Conversation behind a visible Ticket Review divider and invoke the verified `/to-tickets` skill. Before writing files, present its proposed breakdown as a numbered list. Each ticket shows:

- Unique short title in canonical domain language
- Blocking tickets, or **None — can start immediately**
- Narrow end-to-end behavior it delivers
- Draft externally visible acceptance criteria

Render blocking relationships as readable ticket chips and a frontier summary; a complex graph is unnecessary in the MVP. Preserve the complete assistant Markdown when typed parsing is unavailable.

Provide editable Suggested Responses for **Approve and create ticket files**, **Too coarse**, **Too fine**, **Merge tickets**, **Split a ticket**, and **Fix dependencies**, plus the custom composer. Selecting a suggestion fills the composer and becomes a normal readable user message when submitted. Auto mode cannot approve the breakdown.

Feedback continues the same `/to-tickets` exchange. Re-number dependency order after every material revision while retaining stable internal Draft Ticket IDs across title/number changes, adapter restart, and process recovery. Persist proposed lists through the Conversation/event stream, not as premature ticket files.

### Breakdown requirements

The approved set follows the native skill rules:

- Each Implementation Ticket is a narrow but complete tracer-bullet slice across every required layer, independently demoable/verifiable and sized for one fresh agent context
- Prefer no blocker unless another ticket genuinely gates the behavior
- Blocking edges reference stable Draft Ticket IDs, form an acyclic graph, and produce at least one frontier ticket
- Final numbering is deterministic dependency order; a ticket never depends on a later number
- Use an explicit expand–migrate–contract sequence only for a wide mechanical refactor that cannot land green as ordinary vertical slices
- Do not create horizontal database/API/UI/testing tickets merely to mirror architecture layers
- Avoid fragile implementation paths and code snippets, except a trimmed decision-rich prototype excerpt where the upstream skill permits it
- Acceptance criteria test user-visible outcomes, recovery/failure, relevant accessibility/security/privacy behavior, and the accepted Spec rather than implementation details

Semantic quality remains part of the human quiz; deterministic validators enforce document structure and dependency integrity rather than pretending to prove that a slice is well designed.

### Single final acceptance and publication

**Approve and create ticket files** is the one final Planning Package acceptance. Record the approval message and exact proposed-set hash. The skill then writes the complete approved set into staging using its native local template. The app adds identity-only frontmatter without duplicating skill-owned title, Status, acceptance criteria, or Blocked-by fields.

Validate the complete staged set before promotion:

- One file per approved Draft Ticket ID with no additions, omissions, or duplicates
- Safe deterministic filename and number matching dependency order
- Required title, **What to build**, **Blocked by**, `ready-for-agent` Status, and acceptance checklist
- Unique title/file identity and valid `idea_id`/`file_id`
- Every blocker resolves to an approved ticket; graph is acyclic and frontier is nonempty
- Content matches the approved-set hash and accepted Spec baseline
- Valid relative links, UTF-8/LF Markdown, size limits, and no conflicts, secrets, absolute paths, raw logs, hidden reasoning, or unsupported writes

Promote all files transactionally to `.scratch/<idea-slug>/issues/<NN>-<slug>.md`, mark the accepted Spec `ready-for-agent`, update root and Planning Index managed regions, freeze Conversation/Spec/Artifact/Asset/ticket baselines, record publication provenance, and append the user's final acceptance to the Conversation. Only after the transaction commit marker exists does phase become Ready and the Planning Package become editable.

Reference Attachments remain external and outside the package unless explicitly promoted to Idea Assets. Wayfinder planning files remain linked supporting context, not final Implementation Tickets.

### Failure, retry, and invalidation

A generation, validation, or publication failure remains in Ticket Review and never makes a partial package authoritative. Preserve recoverable staged candidates and report every missing, duplicate, invalid, or blocked file/edge. Startup uses the publication journal to complete or roll back an interrupted transaction.

Retry uses stable Draft Ticket IDs and the same user approval only when the approved-set hash and generated content contract are unchanged. If regeneration materially changes title, scope, acceptance criteria, or dependencies, return to the quiz and require approval again. Never create duplicate files on retry.

Before final publication, the user may stop or discard ticket drafting and explicitly return to Spec Review. After Ready, all AI refinement uses the Proposal workflow; it never overwrites accepted files.

### Ready handoff

Ready shows the accepted Spec and ticket paths, each ticket's dependencies, and the current frontier whose blockers are satisfied. It also shows the informational **Implement elsewhere** guide with an explanation of using the generated Spec/tickets through `/implement` in an external Codex/Claude TUI or GUI and a clear warning that the current upstream `/implement` workflow may commit to the current branch.

The MVP never publishes to GitHub, Linear, or another external tracker; runs `/implement`; changes source; or performs any Git mutation, staging, commit, branch, or push.
