# T3 Code executable discovery and launch

Research date: 2026-07-30  
Source snapshot: official [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) repository at commit [`e259dd23c7ef67a7f215389762a1ef5622c79088`](https://github.com/pingdotgg/t3code/tree/e259dd23c7ef67a7f215389762a1ef5622c79088)

## Executive summary

T3 Code does not search the macOS filesystem or probe a list of provider-specific installation directories. Its desktop app repairs the GUI process environment first, then relies on normal `PATH` lookup:

1. At desktop startup, before the local backend is started, it installs a shell-derived environment into `process.env`.
2. On macOS, it tries the inherited `SHELL` and then `/bin/zsh`, invoking the candidate as an interactive login shell with `-ilc`.
3. It captures a fixed allowlist of environment variables, led by `PATH`. If no shell returns a path, it falls back to `/bin/launchctl getenv PATH`.
4. It puts the shell or `launchctl` path entries before the Electron-inherited entries, removing duplicates.
5. Provider instances default to bare command names such as `codex` and `claude`. Users may replace those defaults with an explicit Binary path in Settings.
6. Provider health probes execute the selected command and establish that the expected protocol or CLI works. T3 Code reports missing, timed-out, unauthenticated, or incompatible providers rather than silently substituting another binary.

This is not a known-path scanner. On macOS, paths such as `/opt/homebrew/bin`, `~/.local/bin`, an `nvm` installation, or a user-defined bin directory are found only if the resolved shell/`launchctl`/inherited `PATH` contains them, or if the user enters an explicit Binary path.

## What the desktop app does on macOS

### 1. Hydrate the GUI process environment before backend startup

The desktop startup sequence calls `shellEnvironment.installIntoProcess` before it configures and starts the local server/backend. This makes the repaired environment available to the server process and therefore to provider discovery and launch. [Source: `DesktopApp.ts`, lines 218–233](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/desktop/src/app/DesktopApp.ts#L218-L233)

The environment service captures only these POSIX variables:

- `PATH`
- `SSH_AUTH_SOCK`
- `HOMEBREW_PREFIX`
- `HOMEBREW_CELLAR`
- `HOMEBREW_REPOSITORY`
- `XDG_CONFIG_HOME`
- `XDG_DATA_HOME`

It gives the login-shell probe five seconds and the `launchctl` fallback two seconds. [Source: `DesktopShellEnvironment.ts`, lines 69–82](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/desktop/src/shell/DesktopShellEnvironment.ts#L69-L82)

### 2. Resolve a login shell, not provider-specific locations

For POSIX systems, the desktop implementation tries:

1. `process.env.SHELL`, when present;
2. an optional supplied user shell, though the production desktop constructor currently supplies none;
3. `/bin/zsh` on macOS (`/bin/bash` on Linux).

Candidates are de-duplicated. [Source: shell candidate construction](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/desktop/src/shell/DesktopShellEnvironment.ts#L126-L143), [source: production service supplies `userShell: Option.none()`](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/desktop/src/shell/DesktopShellEnvironment.ts#L412-L425)

Each candidate is executed directly, without an outer shell, as:

```text
<shell> -ilc <fixed environment-capture command>
```

The capture command prints fixed markers around `printenv` output, which makes it resilient to unrelated shell startup output. [Source: capture command and login-shell invocation](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/desktop/src/shell/DesktopShellEnvironment.ts#L181-L190), [source: invocation](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/desktop/src/shell/DesktopShellEnvironment.ts#L277-L288)

### 3. Fall back to `launchctl`, then retain the inherited path

T3 Code stops trying shells after the first one that returns a `PATH`. On macOS, if none does, it executes `/bin/launchctl getenv PATH`. It then merges:

1. the login-shell `PATH`, or the `launchctl` result if the former is absent;
2. the existing Electron process `PATH`.

Entries are de-duplicated while preserving that preference order. The same process fills missing `SSH_AUTH_SOCK`, Homebrew, and XDG variables, but does not overwrite ones already inherited. [Source: POSIX installation and fallback](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/desktop/src/shell/DesktopShellEnvironment.ts#L356-L397), [source: path merge behavior](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/desktop/src/shell/DesktopShellEnvironment.ts#L90-L124)

Probe errors are logged and converted to empty output; a timeout also produces empty output after the process is terminated. Consequently, a bad shell candidate does not abort desktop startup. The next shell, `launchctl`, or the inherited environment can still supply the path. [Source: command error/timeout handling](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/desktop/src/shell/DesktopShellEnvironment.ts#L228-L275)

### 4. The server defensively repairs `PATH` too

The server has a second POSIX `PATH` hydration pass. Its shared candidate builder tries `SHELL`, the login shell reported by the OS user account, and then `/bin/zsh` on macOS. It uses the same login-shell capture, `launchctl` fallback, and preferred-before-inherited merge. Failures are warnings rather than fatal startup errors. [Source: server path repair](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/os-jank.ts#L20-L37), [source: shared candidate order](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/packages/shared/src/shell.ts#L152-L179), [source: non-fatal repair](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/os-jank.ts#L51-L92)

## Provider command selection and user override

T3 Code’s official install documentation states the contract plainly: provider CLIs must be on the server’s `PATH`, or the user must set an explicit path in **Settings → provider instance → Binary path**. It documents default commands of `codex`, `claude`, `cursor-agent`, `grok`, and `opencode`; the app does not ship these CLIs. [Source: official installation guide, lines 44–68](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/docs/user/install.md#L44-L68)

The settings schemas confirm those defaults and expose Binary path as a text setting:

- Codex defaults to `codex`.
- Claude defaults to `claude`.
- Cursor defaults to `cursor-agent`.
- Grok defaults to `grok`.
- OpenCode defaults to `opencode`.

An empty value decodes back to the provider’s default command name. [Source: binary-setting default transformation](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/packages/contracts/src/settings.ts#L144-L154), [source: Codex and Claude fields](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/packages/contracts/src/settings.ts#L197-L292), [source: Cursor, Grok, and OpenCode fields](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/packages/contracts/src/settings.ts#L295-L368)

The generic settings UI renders non-hidden provider fields from those schemas as ordinary text controls and trims values when committing them. There is no source-level evidence here of a provider-specific file chooser, whole-disk search, or automatic substitution. [Source: provider settings field derivation](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/web/src/components/settings/ProviderSettingsForm.tsx#L72-L111), [source: text input](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/web/src/components/settings/ProviderSettingsForm.tsx#L241-L256)

### Known-path behavior

There is no macOS provider-discovery list equivalent to “try `/opt/homebrew/bin/codex`, then `/usr/local/bin/codex`, then …”. The shared command resolver searches the configured `PATH`, checks that candidates are files and executable on POSIX, and returns not-found otherwise. [Source: command resolution](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/packages/shared/src/shell.ts#L494-L558)

T3 Code does recognize Homebrew, npm, pnpm, Bun, and other layouts *after* a command has been resolved, so it can choose an appropriate provider update command. For example, it classifies `/opt/homebrew/bin` and `/usr/local/bin` as Homebrew locations. This is maintenance classification, not discovery probing. [Source: install-layout classifiers](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/provider/providerMaintenance.ts#L224-L264), [source: resolve command first, then classify](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/provider/providerMaintenance.ts#L346-L375)

Windows is the exception: its desktop environment merge includes known npm, Node, Volta, pnpm, Bun, and Scoop directories, and its launcher resolves `PATHEXT` plus `.cmd`/`.bat` shims. [Source: known Windows CLI directories](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/desktop/src/shell/DesktopShellEnvironment.ts#L145-L164), [source: Windows environment merge](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/desktop/src/shell/DesktopShellEnvironment.ts#L329-L353), [source: Windows spawn resolution](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/packages/shared/src/shell.ts#L570-L599)

## How commands are verified and launched

### Codex

Codex is not verified with a standalone `codex --version`. T3 Code spawns the configured binary with `app-server`, using the selected working directory and environment. It performs the app-server initialization handshake, extracts the version from the returned user agent, reads account/auth state, then requests skills and models when authenticated. The status probe is bounded by the shared ten-second auth-probe timeout. [Source: app-server spawn and initialize](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/provider/Layers/CodexProvider.ts#L316-L380), [source: account, skills, and models](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/provider/Layers/CodexProvider.ts#L382-L410), [source: status timeout and errors](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/provider/Layers/CodexProvider.ts#L497-L605)

Real sessions use that same configured Binary path, append the app-server arguments, set the requested `cwd`, and bind the child process to a managed scope so it can be terminated with the session. [Source: Codex session launch](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L710-L761)

### Claude

Claude first runs the configured binary with `--version`, with a four-second default command timeout. A missing command, timeout, or non-zero exit becomes an explicit provider state. It then uses a lightweight Claude Agent SDK initialization to obtain account and slash-command metadata. The initialization probe deliberately supplies a never-yielding prompt, so no user message is written to the subprocess and no Anthropic API request is started; it aborts after receiving initialization data. [Source: version health check](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/provider/Layers/ClaudeProvider.ts#L765-L883), [source: local initialization probe](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/provider/Layers/ClaudeProvider.ts#L693-L762)

Real Claude sessions pass the configured/resolved executable to the Agent SDK as `pathToClaudeCodeExecutable`, along with the working directory, environment, model, effort, permissions, and resume/session identifiers. [Source: executable preparation](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/provider/Layers/ClaudeAdapter.ts#L1334-L1349), [source: Agent SDK query options](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3488-L3548)

On Windows only, T3 Code has extra Claude handling because the SDK cannot directly spawn npm `.cmd`, `.bat`, or `.ps1` launchers. It resolves the shim and looks beside it for the package’s native `claude.exe` or legacy `cli.js`. On macOS and Linux, it returns the configured value unchanged. [Source: Claude executable adapter](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/provider/Drivers/ClaudeExecutable.ts#L10-L89)

### Other current providers

The same command-selection model applies to the other first-party adapters:

- Cursor runs `agent about --format json`, falling back to plain `agent about` when the JSON option is unavailable; it uses this for version and authentication status. [Source](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/provider/Layers/CursorProvider.ts#L944-L1058)
- Grok runs the configured command with `--version`, then uses ACP for its session. [Source: version probe](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/provider/Layers/GrokProvider.ts#L143-L232), [source: ACP launch command](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/provider/acp/GrokAcpSupport.ts#L32-L45)
- OpenCode runs `--version`, parses it, and enforces a minimum version before loading provider/model inventory; an explicitly configured external OpenCode server bypasses the local CLI version probe. [Source](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/provider/Layers/OpenCodeProvider.ts#L330-L424)

## Fallback and failure behavior

- Failure to obtain a login-shell environment does not stop the app. T3 Code tries another candidate, then `launchctl` on macOS, then retains whatever inherited path remains.
- Failure to find or execute a provider does not trigger an installation, disk search, or alternate-provider substitution. The provider is shown as unavailable or errored with a useful message.
- The app can start without an authenticated provider. Authentication is required only when a user starts a session with that provider. [Source: official install guide](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/docs/user/install.md#L70-L75)
- The explicit Binary path is the documented escape hatch for version-manager or non-standard installations that are absent from the effective `PATH`. [Source](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/docs/user/install.md#L63-L68)
- Provider snapshots begin as pending, are health-checked asynchronously, refresh when settings change, and can refresh periodically when provider status is in demand. [Source: managed provider refresh lifecycle](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/provider/makeManagedServerProvider.ts#L113-L148), [source: startup and periodic refresh](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/apps/server/src/provider/makeManagedServerProvider.ts#L150-L219)

## Security boundaries and tradeoffs

### Positive boundaries

- There is no whole-disk executable search.
- The environment probe executes a specific shell path directly, not through another shell.
- Captured variable names are hardcoded; user content is not interpolated into the capture command.
- Probe output is delimited with fixed markers, reducing accidental parsing of startup banners.
- Shell and `launchctl` probes have short timeouts and supervised termination behavior.
- Normal POSIX command-path resolution checks that a candidate is an executable file; Windows resolution checks file type and `PATHEXT`. [Source](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/packages/shared/src/shell.ts#L494-L558)
- Provider health checks validate expected behavior rather than accepting filename presence as readiness.
- The renderer does not launch providers directly. T3 Code documents the server as the execution boundary for provider processes, filesystem operations, terminals, and Git. [Source: architecture overview](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/docs/internals/overview.md#L1-L28)

### Important tradeoffs

- `-ilc` is an interactive login-shell invocation. It can execute the user’s normal shell startup files and any commands those files contain. This is how T3 Code learns version-manager paths, but it is materially broader than reading a static list of known directories.
- An explicit Binary path is user-controlled configuration. The schema trims it and the health probe attempts to execute it, but the inspected path does not show code-signature verification, ownership checks, or an allowlist of executable locations. A malicious executable already earlier on `PATH`, or one explicitly selected by the user, would be launched.
- On POSIX, `resolveSpawnCommand` leaves the configured command unchanged and uses `shell: false`; the operating system performs normal `PATH` resolution when spawning it. Windows has additional explicit resolution because of launcher shims. [Source](https://github.com/pingdotgg/t3code/blob/e259dd23c7ef67a7f215389762a1ef5622c79088/packages/shared/src/shell.ts#L570-L599)
- Homebrew paths are recognized for update behavior only after resolution. They are not trusted roots and are not independently scanned.

## Implications for the Idea-development app

The closest T3-compatible macOS approach is:

1. Keep default provider commands (`codex`, `claude`) and an explicit per-provider executable override.
2. At startup or on a user-requested rescan, derive a candidate `PATH` from a bounded login-shell probe, with `launchctl` and the inherited path as fallbacks.
3. Resolve only the exact required command names against that path; do not enumerate directories or search the disk.
4. Show the resolved absolute path before enabling a provider.
5. Verify readiness using the provider’s native protocol or a harmless version/auth probe, with a timeout.
6. Never silently substitute a different provider or install anything.

For the stricter security posture already chosen for this product, one deliberate deviation from T3 Code is worth considering: make login-shell probing opt-in or visibly disclosed because `-ilc` executes profile code. A safer default can probe a short allowlist of standard executable directories plus inherited/`launchctl` `PATH`, then offer a user-selected executable when unresolved. That is less compatible with `nvm`, `fnm`, `mise`, and custom shell initialization than T3 Code, so the UI should explain the tradeoff rather than scan more broadly.
