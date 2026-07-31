# Decide the Idea Library format

Type: grilling
Status: open
Blocked by: 01, 03

## Question

What user-visible directory and Markdown format should represent Ideas, Conversations, Runs, Draft Artifacts, accepted Artifacts, Proposals, status, and relationships while remaining portable, inspectable, recoverable, and safe for concurrent CLI access?

## Comments

Agreed constraints:

- `<working-directory>/<idea-slug>.md` is the user-controlled root Idea index with minimal stable `idea_id` and format-version frontmatter.
- Native skill output remains under `.scratch/`. Use separate primary and `-wayfinding` effort directories so Wayfinder decision tickets cannot collide with final Implementation Tickets.
- Keep a portable sanitized `conversation.md`; hidden state contains sessions, normalized events, redacted raw logs, provenance, and snapshots.
- Runtime metadata and a rebuildable SQLite search index are not authoritative Idea content.
- Root files link every additional Markdown file and are passed explicitly to skills.
- Read-only before Ready is a UI rule, not an OS permission. External edits create snapshots; edits during a Run pause for reconciliation.
- Renames inside registered locations relink by `idea_id`. Never scan outside assigned directories; moved files use explicit Locate and deleted roots use explicit restore.
- Keep all phase baselines plus the latest 50 intermediate versions per file.
- Git is optional and untouched: no stage, commit, branch, merge, reset, clean, or push. Explicit user-confirmed `git init` is the sole mutation. Planning Runs are additionally blocked from source edits.
- Full-text search is local and deterministic across all Idea Markdown, with phase/status/archive filters.
