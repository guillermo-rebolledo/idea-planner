# Decide the Electron and macOS architecture

Type: grilling
Status: resolved
Blocked by: 04, 06, 08

## Question

What Electron main/renderer/IPC boundaries, Run supervision model, file-watching and snapshot design, rebuildable SQLite index, macOS signing/notarization, and GitHub Releases update architecture implement the product decisions without weakening the local-first security model?

## Answer

Use a thin privileged Electron Main process, a sandboxed single-window React Renderer, a minimal context-isolated Preload interface, and one long-lived Core utility process. Main owns native authority and provider process trees; Core owns all product behavior and durable local state behind a small typed interface. One provider CLI process tree per active Run is enough isolation for the MVP—do not add a utility process per Run. If Core fails, Main immediately stops and verifies every provider tree, while canonical events and filesystem snapshots recover the interrupted work.

### Process topology and module seams

**Renderer** contains the Focus Mailbox UI, local interaction state, virtualized views, and optimistic pending indicators. It has no Node.js, Electron, filesystem, SQLite, process, environment, or arbitrary network access. Load only packaged application code through an app-owned custom protocol; use a strict Content Security Policy, deny navigation/window creation, omit `webview`, and validate every IPC sender.

**Preload** exposes one versioned product interface through `contextBridge`. It translates named functions into fixed IPC messages and strips Electron event objects before callbacks. It never exposes `ipcRenderer`, generic channel names, raw subscription primitives, paths, or arbitrary read/write/execute operations.

**Main** is a privileged kernel rather than the application backend. It owns single-instance/window lifecycle, macOS menus/dialogs/notifications, `nativeTheme`, power events, updater coordination, IPC sender validation, the Core utility-process handle, and a deep `RunProcessBroker` module. The broker resolves only previously verified executables, spawns fixed argument vectors with `shell: false`, applies the frozen environment/sandbox profile, retains process-group handles, and implements idempotent stop-and-verify. Main does not parse provider protocols, decide workflow state, index content, or write planning files.

**Core** is one long-lived `utilityProcess` with Node enabled and unsigned-library loading disabled. Its small external interface is command/query/event based; its implementation owns the Idea Library, normalized events, workflow state machines, Codex/Claude adapters, managed-file supervision, snapshots/diffs, transaction journals, search projection, reconciliation, validation, and recovery. Provider child processes remain separately sandboxed OS processes launched by Main on Core's typed request. A maximum of three concurrent Runs keeps this single Core practical; provider processes already supply per-Run crash and memory isolation.

Core may contain internal seams for the two real harness Adapters, filesystem adapter, clock, and SQLite adapter. Do not mirror every Core subsystem into Preload or Renderer interfaces. The interface is the production and test surface: a fake Core adapter can drive Renderer tests, while adapter conformance fixtures drive Core tests.

### IPC and command acceptance

Renderer-to-Main exposes narrow namespaced functions such as `ideas.list`, `ideas.open`, `responses.submit`, `runs.stop`, `artifacts.readSnapshotPage`, `changes.readFileDiff`, and `settings.update`. Queries return bounded immutable views. Commands carry stable command/submission IDs and return `accepted`, a safe typed rejection, or an uncertain-recovery reference.

Main-to-Core uses a private `MessagePort` handshake containing protocol version, app/Core build identity, capabilities, and maximum frame size. Envelopes have correlation ID, monotonic sequence, cancellation ID, schema version, and discriminated payload. Apply runtime validation on both sides. Unknown critical messages fail closed; safe unknown events are ignored with a diagnostic marker. Reconnect creates a new epoch so stale responses cannot satisfy current requests.

Core-to-Renderer uses one ordered projection-event subscription plus explicit paged/streamed reads for large snapshots, diffs, logs, and search results. Maintain separate priorities: assistant text and control events bypass coalesced filesystem/index traffic. Bound every queue; pause or replace superseded low-priority projection updates rather than accumulating unbounded memory. Renderer resubscription supplies its last applied projection sequence and receives a delta or compact full projection.

A Suggested Response click and custom composer Send both invoke `responses.submit`. Core first runs local secret checks, appends the user message and submission event durably, and returns acceptance. Only then does Renderer show **Sent** and Core request provider launch. This may take one local round trip but must not wait for provider startup. Duplicate submission IDs are idempotent. Acceptance/phase commands use the same visible path and can never be generated by unattended provider execution.

### Canonical files, snapshots, and SQLite

Markdown plus plain JSON/JSONL state, events, manifests, snapshots, and journals remain canonical. Put one rebuildable SQLite projection at `Application Support/<app-id>/index.sqlite`; never place it in an Idea or repository. It may contain Idea locations/identity, file inventory and hashes, phase/status/pin/archive metadata, Run and token summaries, search text/snippets, watcher checkpoints, and UI projection metadata. It must not become the only copy of Conversation, Artifact, Spec, ticket, approval, or transaction truth.

Use WAL mode, a bounded busy timeout, prepared statements, and short batched transactions in Core. Prefer the SQLite implementation bundled with the selected supported Electron/Node runtime when its required FTS and backup behavior pass a packaging spike; otherwise isolate one pinned native SQLite adapter and rebuild/sign it through Forge. In either case callers see the same deep index interface. Corruption, schema mismatch, or deletion renames the database for local diagnosis and rebuilds from registered Ideas without blocking capture; search may show **Indexing** until complete.

Every canonical content version is a complete byte snapshot addressed by SHA-256 over normalized metadata plus bytes. Use UTF-8/LF validation, size limits, staged sibling files, file and directory synchronization, and atomic rename where available. Multi-file changes use a write-ahead publication journal, staged complete set, validation, promotion manifest, commit marker, and idempotent startup completion/rollback. Diffs consume explicit old/new snapshot bytes directly, matching assistant-ui's standalone Diff Viewer contract; Git and provider file events are irrelevant.

### File watching and external changes

Core watches only registered Working Directories and exact managed paths. It never watches a parent library recursively merely for convenience, follows a symlink outside the resolved directory, searches for missing Ideas, or observes unrelated user folders. Start watchers lazily for open/recent Ideas and active Runs; retain inexpensive root identity watches for the remainder, bounded by an explicit watcher budget.

Treat watcher notifications as invalidation hints. Coalesce an exact path briefly, reopen without following aliases, verify containment/identity/type/size, wait for a stable stat when another program is writing, then hash complete bytes. App-owned writes carry operation IDs so expected notifications advance the snapshot without false conflicts. Unexpected changes compare disk, last accepted baseline, and active AI draft; pause only the affected Run and use the resolved explicit reconciliation choice.

Stable `idea_id` and `file_id` recover renames inside the assigned Working Directory. A move outside it becomes **Idea location missing** and requires the user to locate/attach it again with a native picker. Never search beyond the prior approved directory. Sleep/wake, volume remount, watcher overflow, and missed-sequence detection trigger a bounded rescan of registered managed paths, not the filesystem.

### Run supervision, crash recovery, and app lifecycle

`RunProcessBroker` creates a private mode-`0700` Run directory, a frozen launch manifest, and a new POSIX process group for each provider. Spawn with exact executable/arguments, `shell: false`, minimal environment, fixed Working Directory, closed inherited file descriptors, piped protocol streams, reduced priority, and the verified native provider sandbox. Main retains the process and group identity even though Core consumes/produces protocol bytes through bounded channels.

Every terminal path—complete, waiting, failed, Stop, policy violation, Core crash, explicit Quit, and update install—calls idempotent termination: close input, request graceful provider cancellation when safe, send `SIGTERM` to the process group, wait a short bounded grace period, send `SIGKILL` if needed, reap, verify the group is gone, then remove the Run directory. A failure to prove termination is a visible fatal supervision error and blocks new Runs until resolved. Core crash or protocol loss makes Main stop all groups before restarting Core; no adapter can outlive its authority channel.

Window close on macOS destroys/hides Renderer state but leaves Main, Core, and active Runs alive. Reopening rehydrates from Core's projection. Explicit Quit with active Runs shows one confirmation, then stops and verifies all Runs before exit. A shutdown journal distinguishes clean exit from crash. Startup repairs interrupted file transactions first, removes only verified orphaned app-owned temp directories, marks unfinished Runs interrupted, reconciles managed files, then rebuilds/updates SQLite. It never blindly resends an uncertain provider submission.

Use `powerMonitor` to record suspend and run a wake health check. Do not time out model thinking or user waiting. Indexing, hashing, diffing, and log processing yield or batch so control events and streaming stay responsive. Active providers remain capped at three; inactive Ideas have no provider process.

### Renderer responsiveness and resource budgets

Stream provider chunks Core → Main → Renderer on the high-priority port path with a small sanitizer look-behind. Target delivery within 50 ms of receipt. Coalesce durable partial-message checkpoints and ordinary projection updates around 250 ms; finalize immediately at message/Run boundaries. Tool-log tails update at most every 100 ms or 4 KB and are virtualized, collapsed by default, and retained under the existing limits.

Keep the Renderer projection small: mailbox rows, selected Conversation window, artifact metadata, current viewport pages, and Run summaries. Use cursor pagination and list virtualization for Conversations/activity/tickets. Cancel stale searches/diffs, hash incrementally, batch SQLite FTS updates, and deprioritize background indexing. Memory pressure evicts decoded snapshots and inactive Idea projections—not canonical bytes or active Run state—and invokes Chromium cache cleanup only through a measured policy.

The resolved System/Light/Dark preference is stored as one setting in Core. Main applies it through `nativeTheme.themeSource` before window creation; Renderer consumes the resolved preference and `prefers-color-scheme`. Native windows, menus, notifications, title-bar treatment, and web surfaces switch together. System changes propagate as an ordinary setting/projection event.

### Electron hardening and build toolchain

Use a currently supported Electron release and upgrade within Electron's latest-three-supported-major window. Scaffold production with TypeScript, React 19, Tailwind CSS v4, source-owned shadcn/ui, and Electron Forge. Prefer Forge's stable TypeScript/Webpack path for the MVP over its currently experimental Vite plugin; runtime architecture remains bundler-independent. Add Forge's Fuses and Electronegativity checks, package application code in ASAR, and unpack only audited native modules if the selected SQLite adapter requires it.

Enable the global renderer sandbox before app readiness, `contextIsolation`, `nodeIntegration: false`, web security, restrictive CSP, custom local protocol, navigation/window-open denial, and sender validation. Flip Electron fuses to disable Run-as-Node, Node CLI inspect/options paths, and loading from outside ASAR; enable ASAR integrity validation where supported. Do not enable unsigned-library loading, remote module, remote debugging in production, experimental Blink features, or broad macOS entitlements.

### macOS distribution, signing, and updates

Ship separate arm64 and x64 builds to avoid a Universal binary's duplicate size. Produce a signed/notarized DMG for installation and a signed ZIP for Squirrel.Mac updates through Electron Forge. Sign the app and every helper/native binary with **Developer ID Application**, Hardened Runtime, timestamping, and the smallest entitlements required by Electron and verified provider launching. Do not request camera, microphone, Accessibility, Screen Recording, Apple Events, or disable-library-validation entitlements. Notarize with `notarytool`, staple the ticket to distributables, then verify `codesign`, Gatekeeper assessment, notarization, architecture, and clean-machine launch in release CI. Signing/notarization credentials exist only in protected CI/keychain context, never in the app or repository.

Publish stable releases and checksums through GitHub Releases using Forge's GitHub publisher. The MVP update repository/feed must be publicly readable; never embed a GitHub token for a private repository. Use Electron's built-in `autoUpdater`/Squirrel.Mac with the Electron-hosted GitHub update service or an equivalent unauthenticated HTTPS feed, but own the update UI and lifecycle rather than accepting an updater helper's default restart prompt.

Check only in packaged builds: once after a randomized startup delay, on explicit **Check for updates**, and at a conservative interval while the app remains open. Download in the background and expose checking/available/downloading/downloaded/error states without Idea content. Never install while a Run, approval, reconciliation, or publication transaction is active. When idle, offer **Restart and update** and **Later**; never preselect or auto-trigger restart. A downloaded update may apply on the next ordinary launch. `before-quit-for-update` routes through the same shutdown coordinator and re-verifies zero process groups before `quitAndInstall`.

Stable channel only for the MVP. Reject downgrades, prereleases, malformed feeds, architecture mismatches, and unsigned/untrusted artifacts. Keep the current installation runnable if download or installation fails, surface a safe retry/manual-download link, and record only sanitized updater metadata. Automatic updates never modify Idea files or run migrations until the new signed app starts and journals a pre-migration snapshot.

### Verification gates

Architecture acceptance requires automated checks at the deep module interfaces:

- IPC schema compatibility, sender rejection, payload/queue limits, reconnect epochs, cancellation, and duplicate command idempotency
- Renderer compromise tests proving no Node, raw IPC, filesystem, shell, navigation, or unapproved network capability
- Core crash with three active fake providers proving Main terminates and verifies all process groups
- Stop/Quit/update/sleep/wake races and no-orphan checks
- Journal fault injection at every file-publication boundary and deterministic startup recovery
- Watch overflow, rapid external writes, rename, symlink escape, missing volume, and conflict reconciliation
- SQLite deletion/corruption/schema change rebuilding without loss of canonical content
- Streaming latency and bounded-memory tests under large logs, files, and three concurrent Runs
- Signed arm64/x64 DMG and ZIP verification, notarization/stapling, clean-machine install, update deferral while busy, and successful idle restart

Primary implementation references: [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [utility process](https://www.electronjs.org/docs/latest/api/utility-process), [security checklist](https://www.electronjs.org/docs/latest/tutorial/security), [process sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox), [automatic updates](https://www.electronjs.org/docs/latest/api/auto-updater/), [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing), and [Forge macOS signing/notarization](https://www.electronforge.io/guides/code-signing/code-signing-macos).

## Comments

- The validated shell resolves appearance at the application root: System is the default and reacts to macOS changes, with explicit Light/Dark overrides. Electron architecture must expose this as one renderer-wide state and theme native windows, overlays, menus, and title-bar treatment consistently rather than mixing dark chrome with light content.
- Suggested Responses now submit directly through the same normalized user-message command as a custom composer Send. The renderer may optimistically append the visible user turn only after durable local acceptance of that command; provider execution remains a subsequent Run concern.

Standing choices: TypeScript end-to-end, sandboxed React renderer with no direct Node/filesystem/shell access, macOS-first MVP, later Linux/Windows expansion, single app instance/window, notarized direct distribution, stable-channel automatic updates from GitHub Releases, and explicit restart only when Runs are idle.

The resolved adapter contract adds these architecture constraints:

- Provider adapters, executable resolution, child processes, raw protocol parsing, hooks, and diagnostics stay outside the renderer behind runtime-validated typed IPC.
- One supervised provider process tree exists per active Run and must be verified terminated at every terminal lifecycle boundary.
- The normalized, versioned Run event stream and complete filesystem snapshots are authoritative; SQLite and renderer state remain rebuildable projections.
- Managed-file supervision, path-policy enforcement, atomic snapshots, and diff generation live outside provider adapters.
- Require the provider-native macOS sandbox to fail closed, use one private temporary directory per Run, and verify descendant-process termination. Active Runs may continue after the window closes but explicit Quit must stop them.
- Keep low-latency assistant streaming independent from coalesced persistence and virtualized tool-log rendering. Snapshot contents feed assistant-ui's standalone Diff Viewer directly; Git is not part of the diff pipeline.
- Use the resolved portable file contract: stable root/Planning Index/Conversation Markdown, identity-only frontmatter, separate primary and Wayfinder trees, plain JSON/JSONL state, content-addressed Markdown snapshots, journaled multi-file transactions, external-edit reconciliation, and a rebuildable SQLite projection.
- Treat Spec synthesis as a journaled transaction from a content-addressed input manifest through testing approval, staged template validation, stable `spec.md` promotion, iterative snapshot diffs, accepted-baseline freeze, and downstream ticket invalidation on Spec changes.
- Treat ticket drafting as a content-addressed approved-set workflow: stable Draft Ticket IDs during the conversational quiz, deterministic DAG validation/numbering, staged one-file-per-ticket generation, idempotent retry, journaled full-package publication, and Ready only after one atomic authoritative manifest transition.
