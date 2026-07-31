# Decide the Idea Library format

Type: grilling
Status: resolved
Blocked by: 01, 03

## Question

What user-visible directory and Markdown format should represent Ideas, Conversations, Runs, Draft Artifacts, accepted Artifacts, Proposals, status, and relationships while remaining portable, inspectable, recoverable, and safe for concurrent CLI access?

## Answer

Each Idea is a portable, human-readable set of Markdown files rooted in an explicit Working Directory. The app owns file identity, generated indexes, hidden recovery state, and phase transactions; users retain ordinary filesystem ownership and can use any editor. SQLite is only a disposable search/runtime projection.

### Canonical layout

```text
<working-directory>/
├── <idea-slug>.md
└── .scratch/
    ├── <idea-slug>/
    │   ├── planning-index.md
    │   ├── conversation.md
    │   ├── spec.md                         # created lazily
    │   ├── artifacts/                      # created lazily
    │   ├── assets/                         # durable generated/kept assets
    │   ├── issues/                         # created after ticket approval
    │   ├── proposals/<planning-cycle-id>/  # created after Ready refinement
    │   └── .state/
    └── <idea-slug>-wayfinding/
        ├── map.md
        └── issues/
```

Fix the primary planning-root name at creation and record it in the root file; changing the display title or root filename does not automatically rename the planning tree. Multiple Ideas may share a Working Directory. Titles may duplicate, but root and planning slugs must be unique; collisions receive a readable numeric suffix and never overwrite or merge.

Create files lazily. Capture creates the root, Planning Index, Conversation, and private state needed for recovery. Create the Wayfinder tree only when Wayfinder starts, `spec.md` only when Spec Review begins, ticket files only after `/to-tickets` approval, and `proposals/` only after explicitly reopening a Ready Idea. Generated links appear only after their targets exist.

### Root Idea and Planning Index

The root `<idea-slug>.md` contains durable product state in app-managed YAML frontmatter:

```yaml
---
idea_format: 1
idea_id: <uuid-v7>
kind: software
phase: developing
planning_root: .scratch/<idea-slug>
created_at: <rfc-3339>
updated_at: <rfc-3339>
pinned: true
archived_at: null
---
```

Its Markdown body has a human-owned title and Idea description, an app-managed relative-link block bounded by stable HTML comments, and optional human notes. The app updates only frontmatter and the bounded link block. At capture, copy the submitted Idea text into the root description and record it separately as the first immutable user message in the Conversation; later root edits do not rewrite history.

`.scratch/<idea-slug>/planning-index.md` is the human-and-agent guide. It contains minimal identity frontmatter, app-managed Idea/phase summary, a table of every managed file with stable ID, relative path, purpose, lifecycle state, and accepted baseline, a link to the separate Wayfinder map, and an app-managed **For agents** section describing authority and write boundaries. A human-owned notes section becomes editable at Ready. The root links the Planning Index, and every skill invocation receives both files explicitly.

Frontmatter fields reconcile by authority: `idea_id`, `idea_format`, and `created_at` are immutable; `planning_root` changes only through verified Locate; `phase` follows valid gates and cannot be manually jumped to Ready; `kind` is freely editable only while Captured; `pinned` and `archived_at` accept external edits; and the app maintains `updated_at`. Invalid external changes show disk versus expected values and a repair action rather than being silently overwritten.

### Managed Markdown and links

Every managed Markdown file uses minimal identity-only frontmatter before the skill-native body:

```yaml
---
idea_file_format: 1
idea_id: <uuid-v7>
file_id: <uuid-v7>
idea_role: implementation_ticket
---
```

Do not duplicate title, ticket status, blockers, phase, or other skill-owned semantics in frontmatter. Let the verified skill generate its native template, then have the app insert or preserve identity frontmatter during snapshot validation. The configured local tracker explicitly permits frontmatter before the first heading, and compatibility tests cover Grill Me, Wayfinder, `/to-spec`, and `/to-tickets` with these files.

Generate UTF-8, LF Markdown and portable CommonMark links using POSIX-style relative paths. Do not generate absolute paths, `file://` links, required wikilinks, or app-specific URIs. Root and Planning Index enumerate individual managed documents rather than relying on directory links. Validate exact casing and every managed link after rename and before phase acceptance. Optional wikilinks in human prose may render, but are not the generated contract.

Draft Artifact roles are open-ended; do not impose a fixed checklist. Provider-created Artifact names under `artifacts/` use safe lowercase kebab-case `.md` filenames. Reserve the canonical app/workflow names and reject traversal, hidden files, unsafe names, and case-only or reserved-name collisions. `/to-tickets` retains native numbered filenames under `issues/`. Human renames after Ready preserve `file_id` and atomically update managed links and the Planning Index.

### Conversation, Assets, and Proposals

`conversation.md` is one stable, portable, append-only transcript with identity/version frontmatter, message IDs, timestamps, phase/workflow/harness/model/effort boundaries, user and assistant messages, readable Suggested Response selections, relative Asset references, and explicit partial/stopped/recovered labels. Exclude raw events, tool logs, approval details, hidden reasoning, provider session IDs, absolute paths, and token deltas. It is app-owned during planning and editable at Ready; reopening planning treats an edited transcript as the new baseline. Exempt it from the provider-created 5 MB Markdown limit, stream its indexing, and never split it automatically.

User-selected images are **Reference Attachments** by default: store a private local reference, content hash, safe name, and message relationship in hidden state. For a Run, create a metadata-stripped validated temporary derivative and delete it afterward. If the original moves or changes, require **Locate image** or **Continue without it** before a later Run; never omit missing context silently. **Keep with Idea** promotes a reference into a durable **Idea Asset**.

Generated or explicitly kept non-Markdown content lives under `assets/`, is indexed in the Planning Index, participates in baselines, and belongs to the Planning Package. Never persist the original outside path or stripped EXIF/GPS metadata.

At initial Ready acceptance, do not move files. Freeze an accepted baseline and change lifecycle/editability state at the stable paths. When a Ready Idea explicitly reopens planning, AI candidates live under `proposals/<planning-cycle-id>/`; accepted files remain untouched until the user accepts a diff. Proposal acceptance promotes candidates atomically and freezes a new baseline. Reserve `proposals/<cycle>/prototype/` for possible future work, but keep Matt Pocock's `/prototype` and `/implement` out of the MVP because their Git/source behavior exceeds the sandbox.

### Hidden state, snapshots, and transactions

Use portable app-owned plain files:

```text
.state/
├── manifest.json
├── events/<run-id>.jsonl
├── snapshots/<file-id>/<sequence>-<hash>.md
├── logs/<run-id>/
└── references.json
```

`manifest.json` maps stable IDs, current relative paths, hashes, roles, phases, provenance, and baselines. Normalized Run events are append-only JSONL. Snapshots are plain content-addressed Markdown, not proprietary database blobs. Keep every phase baseline plus the latest 50 intermediate versions per file. The model cannot read or write `.state`; use restrictive filesystem permissions and rely on macOS account security/FileVault rather than app-specific encryption.

Serialize app writes per Idea with a recoverable Run lock. App-owned Markdown writes use sibling temporary files, flush/validation, and atomic rename. Provider output becomes a candidate only after close, a short stability window, full validation, size limits, correct identity, and path authorization. Multi-file publication stages the complete set, validates links and identities, writes a transaction journal, promotes files, and records a final manifest commit marker. Startup completes or rolls back an interrupted transaction; partial output never advances phase.

Snapshot restoration is non-destructive: **Restore this version** creates a new current snapshot and retains later history/events. It is unavailable during an active Run. Before Ready it changes the Draft only; after Ready it is a user edit and does not reopen planning automatically.

Version root, managed-file identity, Conversation, manifest, and event formats independently. Supported older versions migrate only after a complete snapshot; user-visible Markdown changes show a file list and diff. Unknown newer formats open read-only and request an app update. Migrations are journaled and restore prior files on failure; SQLite is rebuilt.

### External edits, recovery, search, and lifecycle

AI-created Drafts are read-only only in the app UI. An external edit while no Run is active becomes an **External edit** Draft snapshot and enters later context without advancing phase. An external edit during a Run pauses for three-way reconciliation among Run baseline, disk, and latest valid AI candidate; the user chooses the retained version and no automatic merge occurs.

Watch and search only registered Working Directories and their `.scratch` trees. Resolve internal renames by stable IDs. A missing root or planning tree becomes **Location missing** and offers an explicit native **Locate** action; never scan parent folders, home, other libraries, or the disk. A missing root may be recreated from valid Planning Index/manifest state. Missing/corrupt hidden state preserves portable content, quarantines recoverable diagnostics, rebuilds what is possible, and clearly marks lost sessions/diffs. Never overwrite unrelated content occupying an old path.

Index root, Planning Index, Conversation, Draft/accepted Artifacts, Spec, Wayfinder map/tickets, and final Implementation Tickets. Exclude state, events, snapshots, logs, diagnostics, temp files, external images, and binary Assets. No OCR or embeddings. SQLite snippets and filters for kind, phase, pin, archive, file role, and Working Directory remain fully rebuildable.

Best-effort support ordinary iCloud Drive, Dropbox, Syncthing, Git, and Obsidian folders without implementing sync. Treat offline placeholders as **Download required**, never deleted. Never auto-merge conflict copies. Duplicate `idea_id` values pause indexing and ask whether the entry moved or was copied; **Keep as duplicate** previews and rewrites only that copy's managed IDs, manifest, and internal links.

Archive changes `archived_at` without moving files. Permanent delete previews exact app-owned targets and moves only the root Idea file, primary planning tree, and Wayfinder tree to macOS Trash. It never deletes the Working Directory, source, project README, or external Reference Attachments. Warn about unsnapshotted external changes and report partial Trash failures precisely.

### Supported skill and setup contract

Only verified skills from `mattpocock/skills` may run in the MVP: `setup-matt-pocock-skills`, `grill-me`/`grilling`, `wayfinder`, `domain-modeling`, `research`, `to-spec`, and `to-tickets`. Load only the active workflow and required dependency closure. Each supported skill version has a reviewed write contract; it may create any files inside those declared locations, but a changed skill cannot expand access silently.

Ordinary planning skills write only their assigned `.scratch` trees. A separate, explicit **Configure project for planning** setup Run is the sole broader exception: it may propose changes only to `AGENTS.md`, `CLAUDE.md`, `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, and `docs/agents/triage-labels.md`. The UI shows one combined diff and requires acceptance before promotion, preserves content outside the managed `## Agent skills` sections, configures local Markdown without Git inspection, and restores the ordinary boundary afterward. No supported skill may modify source, package files, hooks, Git state, or `CONTEXT.md` through this exception.
