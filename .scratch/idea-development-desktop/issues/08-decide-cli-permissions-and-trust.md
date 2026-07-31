# Decide CLI permissions and trust boundaries

Type: grilling
Status: resolved
Blocked by: 03, 04

## Question

What may a Run read, write, execute, or request outside its Idea directory, how are CLI permission prompts surfaced, and what audit and approval experience keeps local harness use understandable and safe?

## Answer

Planning Runs execute inside a fail-closed, OS-enforced sandbox with a fixed product-owned permission matrix. Provider Auto or never-ask modes may reduce prompts only after the boundary is verified; they never expand it. Capture, browsing, and manual editing remain available when a harness, authentication, skill, or sandbox is unavailable.

### Filesystem boundary

- Separate private harness bootstrap access from model tool access. The CLI may privately read only its known executable, provider configuration/authentication, certificate, and verified skill locations. Those contents never become tool-readable, enter prompts, appear in logs, or reach the renderer.
- Model tools may read ordinary source, documentation, tests, manifests, and configuration inside the explicit Working Directory. Hard-deny secrets and credentials, `.git` internals, dependency/build/cache/generated-data trees by default, and every symlink or alias that resolves outside the directory. Safe templates such as `.env.example` remain readable.
- Ordinary planning tools may write only the current Idea's precomputed `.scratch/<effort-slug>/` Draft Artifact tree and a private per-Run temporary directory. The app owns `<idea-slug>.md`, `conversation.md`, hidden state, relationships, snapshots, and publication. The separately confirmed setup workflow has the fixed instruction-file exception defined below.
- Each workflow phase derives its exact writable tree from the verified native skill layout. New managed Draft files are allowed. Source edits, writes to another Idea, and writes outside managed paths are rejected before reaching disk.
- Create, modify, rename, and delete operations inside the Draft tree remain reversible. A delete creates a retained tombstone and diff; it never erases the baseline. Ready-state AI changes remain Proposals requiring user acceptance.
- The app marks expected provider file operations. An unexpected or ambiguous concurrent disk change pauses the Run and shows Run baseline, disk content, and latest valid AI snapshot. The user chooses **Keep disk version** or **Keep AI draft**; there is no automatic merge.
- Each Run receives a mode-`0700` temporary directory that no other Run may inspect. It is excluded from Artifacts, search, and handoffs, deleted after verified process shutdown, and cleaned after a crash on next launch.

### Sandbox, command, and process policy

- Require each provider's native macOS OS-level sandbox and configure exact read, write, and network policy. Layer tool permission denies, managed-file supervision, and snapshot validation on top. If containment cannot start or honor the policy, fail closed and do not start AI planning.
- Disable unsandboxed-command and **allow anyway** escape paths. User-facing permission modes are only **Ask** and **Auto inside planning sandbox**. Codex never-ask and Claude Auto remain subordinate to the same boundary and reset each Run. Never expose Claude bypass-permissions or an unsandboxed Codex equivalent.
- Automatically allow only verified read-only inspection operations and managed Draft operations. Arbitrary scripts, builds, tests, interpreters, package managers, Git, system configuration, app launching, process control, local services/sockets, and unknown executables are blocked. There is no approval path for general-purpose execution.
- Safe inspection commands have a 60-second wall limit, at most 16 descendant processes, and 10 MB combined output. Provider-created Markdown is capped at 5 MB per file and 50 MB of new or changed planning content per Run; the app-owned `conversation.md` transcript is exempt and streamed. Exceeding a limit stops that operation with a visible reason; it does not offer an unrestricted retry.
- Model thinking and waiting for the user have no automatic timeout. Active Runs may continue while the window is closed, hidden, or unfocused. Closing the window does not stop them; explicit Quit confirms stopping all active Runs, terminates their process trees, and verifies cleanup. Updates wait for idle Runs, and sleep/wake triggers a health check.
- Keep the existing default maximum of three concurrent cross-Idea Runs as a queue limit. Inactive Ideas have no provider process. Child processes use reduced priority, and indexing/rendering must exclude noisy generated trees and virtualize large logs.
- A first repeated blocked request is returned to the model as a denial so it can recover. Three attempts at the same non-overridable violation—or one high-risk attempt to access secrets, escape the Working Directory, or use local sockets—stops the Run as **Policy violation**.

### Git, skills, providers, and ambient access

- The `git` executable is completely unavailable inside planning Runs. Repository awareness uses safe filesystem metadata and app-owned snapshot diffs, not Git commands.
- The sole optional Git mutation is a separate app-owned, explicitly confirmed `git init` action against the resolved Working Directory while no Run is active. It uses a trusted executable and fixed argument vector and performs no staging, commits, branches, configuration, hooks, or follow-up Git operations.
- The app never installs packages or skills. If verified Matt Pocock skills are missing globally and project-locally, show what is missing, the copyable command `npx skills@latest add mattpocock/skills`, a link to [Matt Pocock's skills repository](https://github.com/mattpocock/skills), and **Check again**. Capture-only mode remains available.
- The app never installs, authenticates, or stores credentials for Codex or Claude. The harness picker keeps both options visible and disables any provider that is not installed, authenticated, compatible, sandbox-capable, or skill-ready, with exact copyable remediation and official guidance. If neither provider is ready, show readiness information without blocking capture.
- Launch Runs with a minimal allowlisted environment: locale, sanitized PATH, HOME for private provider configuration lookup, and the app-owned temporary directory. Strip API keys, cloud/CI credentials, shell functions, editor variables, and unknown environment entries. Environment-based authentication is not forwarded to model-accessible processes.
- Disable user MCP servers, arbitrary hooks, unrelated plugins, browser/computer use, remote control, and other ambient tools for MVP Runs. Permit only built-in inspection/managed-file tools, the app-owned Claude question/approval bridge, provider messaging/reasoning summaries, and the reviewed dependency closure of these verified `mattpocock/skills` entries: setup, Grill Me/Grilling, Wayfinder, Domain Modeling, Research, `/to-spec`, and `/to-tickets`. `/prototype`, `/implement`, and unrelated installed skills remain unavailable. Revisit this isolated-tool hypothesis after local beta feedback if it blocks valuable planning behavior.
- Do not request ambient clipboard, Screen Recording, Accessibility, camera, microphone, or other-app access. Explicit image paste, drag-and-drop, or file selection is allowed. User images remain Reference Attachments by default: make a validated metadata-stripped temporary derivative per Run and delete it afterward. Only **Keep with Idea** or generated content enters the durable `assets/` directory.
- `setup-matt-pocock-skills` runs only through a separately confirmed setup flow with a versioned write contract for `AGENTS.md`, `CLAUDE.md`, and `docs/agents/{issue-tracker,domain,triage-labels}.md`. Show one combined diff, preserve surrounding content, and restore the ordinary `.scratch`-only write boundary after acceptance. A skill may create arbitrary files only inside its verified declared locations; changed skill behavior cannot expand access dynamically.

### Network and approvals

- Provider authentication and inference traffic uses a private bootstrap channel and does not appear as model tool activity. Tool-originated network access is default-deny.
- The first request to an exact public hostname shows a card containing tool, purpose, hostname, outgoing data categories, and requested duration. Choices are **Allow once**, **Allow this hostname for this Run**, and **Deny**. Nothing is preselected, Enter never approves, and closing the card leaves the Run waiting.
- A Run-scoped hostname approval suppresses repeated prompts for that hostname only. Redirects to a different hostname require a new decision. IP literals, localhost, local-network ranges, Unix sockets, and wildcard domains are hard-blocked. Every network approval expires with the Run.
- The activity log records sanitized hostname, method, status, timing, byte counts, redirects, and approval source. Headers, cookies, authorization data, request/response bodies, and sensitive query values never persist or display.
- Security approvals remain outside portable Conversation Markdown and cross-harness handoffs. They expire on interruption or restart and are never replayed.

### Secrets, visibility, and diagnostics

- Every new-Idea composer visibly reminds users never to paste passwords, API keys, tokens, private keys, or credentials and explains that submitted content goes to the selected provider. The notice links to the privacy explanation without requiring a checkbox.
- Scan locally before persistence or submission. Mask and hard-block high-confidence credentials until removed. Lower-confidence matches show a masked warning that the user may explicitly confirm. A blocked draft remains only in volatile composer memory. Secret-path reads remain non-overridable denials.
- Every tool call creates an activity entry; none disappear silently. Show sanitized operation, Working-Directory-relative targets, time, duration, exit status, and result. Expanded sanitized stdout/stderr uses explicit `[REDACTED: category]` markers and counts. Unsafe-to-sanitize content is omitted with a visible reason, and there is no raw-secret reveal.
- Assistant deltas update within 50 ms of a provider chunk through a priority streaming path with a small sanitizer look-behind. Tool output tails update within 100 ms or 4 KB. Durable partial checkpoints remain coalesced around 250 ms, and noisy tools may not delay messages, Stop, choices, or approvals.
- Keep compact activity metadata for the Idea's lifetime. Retain expanded sanitized output for 30 days or the latest 20 Runs, whichever preserves more recent work. Expiration leaves a visible marker; users may clear verbose logs without deleting Conversation or recovery state.
- Use Working-Directory-relative paths in Conversation, activity, Artifacts, and diffs. Show absolute location only in explicit Idea location settings and native file pickers. Diagnostics replace it with `<WORKING_DIRECTORY>`.
- Offer a previewable, user-exported local diagnostic bundle containing app/OS and harness versions, capability results, normalized event metadata, safe errors, resource-limit events, and redaction markers. Exclude Idea/assistant text, paths, filenames, commands, tool arguments, raw output, and raw provider frames. Never upload it automatically.
- Raw provider frames are never persisted. The diagnostic projection is allowlisted; unknown fields are discarded.

### Snapshot diffs

The app's content-addressed before/after Markdown snapshots are authoritative. Render them with assistant-ui's standalone `DiffViewer` using `oldFile` and `newFile` content, unified view by default and split view on demand. File lists, rename/tombstone tracking, additions/deletions, validation, and snapshot selection remain app-owned; neither Git nor provider file events participate in correctness.
