# Define onboarding, privacy, and operational settings

Type: grilling
Status: resolved
Blocked by: 04, 06, 08, 11

## Question

What onboarding, readiness repair, capture-only fallback, notification consent, content-free analytics consent, update behavior, concurrent-Run controls, and diagnostics settings make the macOS MVP understandable and privacy-preserving?

## Answer

Use progressive, capture-first onboarding. The only prerequisite for preserving an Idea is an explicit writable Idea Library; provider, authentication, skill, notification, analytics, and update readiness remain independently understandable and repairable. There is no account, cloud workspace, mandatory telemetry, automatic installation, or hidden permission escalation.

### First launch and capture

First launch uses three short steps with a persistent progress summary rather than a blocking setup maze:

1. **Choose where Ideas live** — explain that ordinary Markdown is canonical and user-owned, suggest a new folder under Documents, and show its exact location before creating/selecting it with a native picker. The app writes only after explicit confirmation. Additional existing project directories are attached later and never searched for automatically.
2. **Check AI readiness** — show Codex and Claude independently with installed, authenticated, compatible, sandbox-capable, and Matt Pocock skill-ready checks. This step is optional and has **Continue with capture only**.
3. **Privacy choices** — analytics and desktop notifications are separate toggles, both off by default, with their exact data/behavior summarized inline. Continue does not imply consent.

Then open the empty Focus Mailbox with **New Idea** primary. The New Idea screen defaults to Software Idea, offers General Idea as an explicit alternative, and keeps the type editable while Captured. Generate a local title/slug deterministically from the first meaningful line, show it immediately, allow editing, and resolve filename collisions without AI.

The opening composer always shows a concise reminder not to paste passwords, API keys, tokens, private keys, credentials, or unreleased sensitive data, and states that submitted content goes to the selected provider. Run the local secret scanner before persistence/provider contact. Capture first creates the root, Planning Index, Conversation, and recovery state; **Save for later** never starts AI, while **Start developing** requires a ready workflow/harness/model/effort and creates the first Run.

Never request blanket Files and Folders, Full Disk Access, clipboard monitoring, Accessibility, Screen Recording, camera, or microphone access. Explicit paste, drag-and-drop, and native file/image selection are user gestures. Explain Reference Attachment versus **Keep with Idea** at first attachment, then keep the explanation discoverable rather than repeating a modal.

### Provider and skill readiness

Readiness is a reusable product module shown in onboarding, Settings, and immediately before a Run. Each provider row has five independent results:

- Executable found and resolved to a visible absolute path in provider settings
- Native handshake/version compatible
- Provider reports authenticated
- Required native macOS planning sandbox verified
- Selected Matt Pocock workflow plus reviewed dependency closure found and compatible

Probe inherited/`launchctl` PATH and exact configured commands without scanning. If unresolved, offer **Choose executable**. Offer login-shell environment discovery only through one-time informed consent explaining that shell startup files will execute; the bounded probe may be revoked/reset. An explicitly selected executable is identity/path checked and still must pass the native readiness probe. Never silently switch binaries or providers.

Unavailable providers remain visible but disabled. Each failed check has a safe explanation, official provider guidance, copyable remediation, and **Check again**. The app never installs, upgrades, authenticates, or stores credentials for Codex or Claude. If skills are missing, show only the copyable `npx skills@latest add mattpocock/skills` command, a link to Matt Pocock's repository, required npm/npx prerequisite information, and Check again; never execute the command.

Show visible methodology credit in workflow selection and Conversation boundaries: **Based on Matt Pocock's Grill Me/Wayfinder skill**, with links to Matt's website and GitHub plus license/attribution in About. State that the product is not endorsed by Matt Pocock.

Capture-only mode is a normal state, not an error banner. Users can create, search, pin, archive, edit eligible Ready content, inspect Markdown, attach/locate context, and configure directories without a provider. Attempting an AI action opens the focused readiness repair for that chosen provider/workflow while preserving the unsent composer text in volatile memory.

### Notifications

Desktop notifications are opt-in and requested from macOS only when the user enables them. The toggle explains the four eligible events: waiting for response, waiting for an allowable approval, Run completed, and Run failed. Notifications contain no Idea title, content, prompt, filename, path, provider output, or error details; use generic text such as **An Idea needs your response** or **A planning Run failed**.

Clicking a notification activates the app and routes through an in-memory/local opaque notification mapping to the relevant Idea. Do not place Idea identifiers or content in the macOS notification payload. If the mapping expired, open the inbox filtered to Needs attention. Respect Focus modes and macOS denial without repeated prompting. Turning notifications off withdraws future scheduling and clears pending app notifications.

Do not notify while the relevant Idea is focused and the app is active. Coalesce repeated waiting/failure changes per Idea, never notify for ordinary token/tool activity, and never use badges as a substitute for the inbox's explicit icon/label/color states.

### Opt-in analytics

Analytics exists only to measure anonymous flow completion/drop-off and is off by default. The consent screen lists the complete fixed event vocabulary:

- `idea_created`
- `planning_interview_finished`
- `mvp_spec_created`
- `implementation_tickets_created`
- `ready_reached`

Send no historical events when a user opts in. Each event contains only event name, coarse client timestamp, random resettable installation analytics ID, random per-Idea funnel ID kept only in app-private settings, and app version. Do not include Idea/conversation/artifact text; user/provider/model/skill selections; paths or filenames; titles/slugs; diffs; errors; token usage; durations; tool/Run/raw event data; device name; IP-derived location; repository data; or persistent hardware/account identifiers. The collection service must discard transport IP/user-agent data from analytics storage and apply a short documented retention period.

Implement a tiny allowlisted HTTPS event client rather than a third-party autocapture SDK. No session replay, DOM capture, crash reporting, advertising identifier, cross-app tracking, cookies, or background profiling. Queue only consented fixed-schema events, cap/retry with jitter, and drop safely when offline. Opt-out immediately deletes the local queue and analytics IDs; opting in again creates new IDs. Provide **Reset analytics identity**, a human-readable event preview, privacy policy link, and exact last-send status. Operational update/provider traffic never counts as analytics consent.

### Runs, background work, and resource controls

Allow one active Run per Idea and one to three concurrent cross-Idea provider Runs, defaulting to three as previously resolved. Settings may lower the limit; reducing it never kills active work and applies when slots naturally free. Additional submissions enter a visible FIFO queue with Idea, provider, workflow, queued time, and **Cancel queued Run**. A direct user submission outranks automatic maintenance/indexing, but pinning or focusing an Idea does not silently reorder the queue.

Closing the window or hiding the app leaves Main, Core, and active Runs alive. The inbox and optional content-free notifications expose Waiting, Running, Failed, Ready, and Saved states. The background-Run surface shows active/queued counts, Stop per Run, and Stop all; it does not expose raw prompts or secrets. Stop retains history and complete snapshots. Explicit Quit with active/queued Runs shows the count and consequences, requires **Stop Runs and Quit**, cancels queued work, and verifies provider termination before exit.

Use the existing maximum and resource budgets. Lower provider priority, lazy-watch inactive Ideas, virtualize logs/Conversation, batch indexing, and surface memory-pressure recovery only when it affects work. Never market background execution as an autonomous agent: every Run originates from a visible user submission/action and ends at waiting/completion/failure/Stop.

### Updates and version compatibility

Automatic stable-channel update checking/downloading is enabled for packaged signed builds because security updates matter; it is independent from analytics and contains no Idea data. Settings provide current version, last check/result, **Check for updates**, automatic-download toggle, and manual GitHub Releases link. There is no prerelease channel in the MVP.

Downloaded updates never interrupt a Run, approval, conflict, or publication transaction. Show **Update ready—waiting for planning to finish** while busy. When fully idle, offer **Restart and update** and **Later** without a default destructive choice. Explicit restart routes through the same no-orphan shutdown verification. Failure leaves the current app usable with safe retry/manual download. Unknown-newer Idea formats open read-only and recommend updating; migrations begin only after the new signed app journals complete pre-migration snapshots.

### Settings information architecture

Use these sections, searchable from one Settings window/sheet:

- **General** — whole-app System/Light/Dark, default Idea kind, Idea Library, attached Working Directories, archive, inactivity thresholds
- **AI Providers** — Codex/Claude five-part readiness, resolved executable, explicit selection, optional login-shell consent/reset, Check again
- **Planning** — default workflow, model/effort per provider, Ask versus Auto inside verified sandbox, concurrent Run limit, setup-skill entry point
- **Privacy** — analytics consent/event preview/reset, notification consent/status, no-secrets explanation, attachment behavior
- **Storage & Recovery** — registered locations, missing/offline state, rebuild search index, snapshot/log retention, clear verbose logs, open app data folder
- **Updates** — version, automatic download, status, check/manual download
- **About** — methodology attribution, Matt Pocock website/GitHub, licenses, privacy/security docs, diagnostic export

Dangerous or destructive actions remain contextual and separately confirmed. Permanent delete previews only the exact app-owned Idea targets and moves them to macOS Trash. **Reset app data** previews that it removes settings/index/cache/logs but never Idea files. **Rebuild index** is safe and does not touch canonical files. Do not provide a general reset that ambiguously combines these operations.

### Diagnostics, retention, and support

Keep compact sanitized activity metadata for the Idea's lifetime. Keep expanded sanitized output for 30 days or the latest 20 Runs, whichever preserves more recent work, then leave a visible expiration marker. **Clear verbose logs** previews affected Runs and preserves Conversation, canonical files, snapshots needed for current baselines/recovery, and compact activity.

Diagnostic export is local, explicit, and previewable before writing. It includes app/macOS architecture/version, Electron and harness versions, five-part capability results, normalized event types/IDs/timing/status, safe error/resource codes, updater state, recovery markers, redaction counts, and structural index/watcher health. It excludes all Idea/assistant text, prompts, titles, paths, filenames, commands, tool arguments, environment, raw output/frames, diffs, attachments/assets, provider/session credentials, and analytics identifiers. Replace the Working Directory with a constant placeholder and use random bundle-local references.

Never upload diagnostics automatically. Export through a native save dialog, show file size and exact categories, and provide **Reveal in Finder**. Support instructions may ask the user to attach it manually, but the app has no background support channel. Crash recovery uses local journals/events; do not add third-party crash reporting in the MVP.

### Missing content and setup workflow

Before every Run, validate required root/Planning Index/Conversation/phase inputs and referenced images. A missing Reference Attachment offers **Locate image** or **Continue without it**; the latter becomes a visible user decision. Missing/offline managed files block only affected actions and show Locate/Download required. Native Locate starts at the last known approved directory but never searches outside it.

**Configure project for planning** is a separate, explicitly confirmed setup flow available only when a provider, sandbox, and verified setup skill are ready and no Run is active in that Working Directory. Preview the complete bounded write contract first, run inside its exceptional policy, stage changes, then show one combined diff for `AGENTS.md`, `CLAUDE.md`, and the three `docs/agents` files. **Apply configuration** is a second explicit acceptance; Cancel discards staged candidates. Partial failure restores the prior snapshot and ordinary `.scratch`-only permissions. No other root file may appear in the diff or be written.

### Ready handoff

Ready shows the accepted Spec/ticket paths, current blocker-free frontier, changed-baseline indicator, and a collapsed **Implement elsewhere** guide. Explain how to open the Working Directory and use the accepted Spec/frontier ticket with `/implement` in the user's chosen Codex or Claude TUI/GUI. Warn that the upstream workflow may commit to the current branch. The app does not invoke it, open a terminal automatically, copy hidden prompts, stage, commit, switch branches, or inspect Git.

Success means a person can understand, before any external effect, where their content lives; which provider capability is missing; what will be sent to a provider, notification center, updater, or analytics endpoint; which Runs remain active; and how to recover/export/delete app-owned state without risking their project.

## Comments

- Architecture baseline: System/Light/Dark is application-wide; Main applies `nativeTheme` before window creation and Core persists the preference. Updates are stable-channel, publicly readable GitHub Releases, downloaded in the background, but restart is offered only after every Run and transaction is idle.
- Operational recovery must distinguish clean exit, window close, Core crash, provider interruption, update exit, and filesystem transaction recovery. A closed window leaves active Runs alive; explicit Quit always confirms, stops, and verifies them.
- Distribution onboarding may assume signed/notarized arm64 and x64 DMGs, but must explain provider/skill readiness separately. The app never installs providers, skills, credentials, or package prerequisites.

Standing choices: no app account; capture-only always works; default Idea Library plus explicitly attached directories; Software Idea default with General Idea option; local deterministic title generation; up to three concurrent cross-Idea Runs with an adjustable limit; opt-in content-free funnel checkpoints and desktop notifications; no Conversation, Idea, path, filename, diff, or raw-event analytics; no token budget or quota estimate; show only per-Run/per-Idea tokens and native context-window usage.

Readiness and privacy constraints inherited from the trust boundary:

- Show installed, authenticated, compatible, sandbox-capable, and skill-ready states independently for Codex and Claude. Keep unavailable harnesses visible but disabled with copyable terminal remediation and **Check again**; the app performs no provider or skill installation and handles no credentials.
- Every new-Idea composer includes a no-secrets reminder and local secret scanning. Explicit normalized image attachments are allowed without ambient Screen Recording or clipboard access.
- Active Runs continue when the window closes or the app is hidden. Explicit Quit confirms stopping them; notifications for waiting, approval, completion, or failure remain opt-in and content-free.
- Offer previewable local sanitized diagnostic export. Retain compact activity for the Idea lifetime and expanded sanitized logs for 30 days or the latest 20 Runs, with manual clearing available.
- Explain Reference Attachment versus **Keep with Idea**, show missing external context before submission, and support explicit Locate without scanning outside registered Working Directories.
- Offer a separately confirmed **Configure project for planning** flow for the verified setup skill, previewing the bounded instruction-file diff before promotion. No other planning skill may modify project-root content.
- Ready onboarding/handoff explains the ticket frontier and shows external `/implement` guidance without invoking it, including the upstream current-branch commit warning.
