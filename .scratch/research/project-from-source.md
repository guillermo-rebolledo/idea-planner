# Starting a Project from a remote source

Research date: 2026-08-09

## Recommendation

Add one reusable **Add Project** flow, reached from onboarding and the app menu, with exactly three
sources:

1. **Local folder** — the existing native folder picker.
2. **Git URL** — clone a user-supplied HTTPS or SSH Git URL with the machine's existing Git
   credentials.
3. **GitHub repository** — clone an `owner/repo` through the already-required, already-authenticated
   GitHub CLI.

The remote flows should ask for the source first and then show a review step with an editable
**Clone into** destination and a **Clone** button. Clone directly into that reviewed destination,
re-run Git's root probe after success, and only then ask Core to add the Project. This preserves the
existing ownership rule: Main owns native Git work; Core owns Project identity and persistence.

This is a small extension of the current design rather than a new Project model. The app already
defines a Project as a local Git repository, shells out to Git to resolve its root, and treats that
resolved absolute path as identity ([ADR 0005](../../docs/adr/0005-git-decides-project-identity.md),
[current Main flow](../../app/src/main/index.ts#L284-L318)). A clone simply creates the local
repository before feeding it through the same `resolveProjectRoot` -> `project/add` path.

## What T3 Code does today

The upstream source was read at commit
[`ba9c9ae`](https://github.com/pingdotgg/t3code/tree/ba9c9ae81dce4e554b4dd52abfd28d0c01b5c651).
Its behavior is useful precedent, but the recommendation below deliberately differs on destination
ownership and GitHub authentication.

- Its source picker starts with **Local folder**, then **Git URL**, then configured forge providers.
  Git URL is always available; a provider row becomes disabled with **Setup Required** when its CLI
  or authentication is unavailable
  ([CommandPalette.tsx L1135-L1218](https://github.com/pingdotgg/t3code/blob/ba9c9ae81dce4e554b4dd52abfd28d0c01b5c651/apps/web/src/components/CommandPalette.tsx#L1135-L1218)).
- Remote creation is a two-step flow. Git URL accepts the input directly. A provider entry first
  looks up repository metadata; GitHub then selects the returned SSH URL. Both proceed to an editable
  destination path, defaulted from the environment's add-project base directory or `~/`
  ([CommandPalette.tsx L1709-L1781](https://github.com/pingdotgg/t3code/blob/ba9c9ae81dce4e554b4dd52abfd28d0c01b5c651/apps/web/src/components/CommandPalette.tsx#L1709-L1781)).
- It permits a nonexistent destination or an existing empty directory, rejects a non-directory or a
  non-empty directory, then runs `git clone <remote> <directory>` with a 120-second timeout and a
  256 KiB output cap
  ([SourceControlRepositoryService.ts L129-L218](https://github.com/pingdotgg/t3code/blob/ba9c9ae81dce4e554b4dd52abfd28d0c01b5c651/apps/server/src/sourceControl/SourceControlRepositoryService.ts#L129-L218)).
- The UI disables duplicate submission and changes its action copy to **Working** / **Cloning**. A
  failure becomes a toast; an interrupted command is intentionally silent; only a successful clone's
  returned directory is added as a project
  ([CommandPalette.tsx L1819-L1840](https://github.com/pingdotgg/t3code/blob/ba9c9ae81dce4e554b4dd52abfd28d0c01b5c651/apps/web/src/components/CommandPalette.tsx#L1819-L1840),
  [L1938-L1958](https://github.com/pingdotgg/t3code/blob/ba9c9ae81dce4e554b4dd52abfd28d0c01b5c651/apps/web/src/components/CommandPalette.tsx#L1938-L1958),
  [L2180-L2247](https://github.com/pingdotgg/t3code/blob/ba9c9ae81dce4e554b4dd52abfd28d0c01b5c651/apps/web/src/components/CommandPalette.tsx#L2180-L2247)).
- It does not pass `--progress` and exposes no clone-specific Cancel control in this surface. Thus the
  visible progress is phase-level copy, not streamed transfer progress. The implementation can
  recognize an interruption supplied by its command/RPC runtime, but the palette itself does not
  present a way to request one.

### Destination behavior compared

| Source | T3 Code | Recommended here |
| --- | --- | --- |
| Local folder | Browse an existing directory and add it | Keep the current native folder picker and Git-root confirmation |
| Git URL / GitHub | User edits a full destination path; destination may be absent or already empty | User chooses/edits the final path; final path must not exist; clone directly into it |
| Clone failure/cancel | The partial destination may remain | Stop the child process, retain the partial destination, and report its exact path; never delete it automatically |

Git itself allows an existing destination only when it is empty
([`git clone` documentation, directory argument](https://git-scm.com/docs/git-clone#Documentation/git-clone.txt-ltdirectorygt)).
T3 mirrors that rule. The stricter final-path-must-not-exist rule is preferable here because it makes
the creation boundary clear and prevents Git from filling an existing directory. A failed or
cancelled clone can still leave a partial directory. Keep it in place and name it in the error rather
than guessing that it is safe to delete; the person may have opened or changed it while cloning.

## Proposed UX

### Source step

Replace the onboarding's single **Choose a folder…** action and the app menu's immediate picker with
the same modal/palette:

- **Local folder** — “Browse a folder on disk”
- **Git URL** — “Clone from an HTTPS or SSH URL”
- **GitHub repository** — “Clone GitHub owner/repo”

The current onboarding already centralizes adoption of `ChooseProjectResult`, refusal, and root
confirmation ([Onboarding.tsx L30-L65](../../app/src/renderer/src/components/Onboarding.tsx#L30-L65));
the source flow should eventually return the same `added` result rather than create a parallel
post-clone onboarding path.

Git URL stays enabled whenever Git is available. GitHub repository should use the existing GitHub
readiness distinction from publishing: `gh` missing and `gh` unauthenticated are different repairable
states. Show **Setup Required** on that row, but do not disable Git URL merely because GitHub setup is
missing.

### Source and destination review

- Git URL: one input with examples such as `https://github.com/owner/repo.git` and
  `git@github.com:owner/repo.git`.
- GitHub: an `owner/repo` input. Keep this first slice to github.com; enterprise-host selection can be
  added later without changing the clone operation.
- Review: source summary, editable final path, **Choose parent…**, then **Clone**. Derive a suggested
  leaf from `repo.git` -> `repo`, but never silently overwrite an existing path.
- Running: keep the modal open, disable source/destination edits, show **Cloning…** plus the latest
  sanitized Git progress phase, and expose **Cancel**.
- Success: close the flow and select/show the newly added Project. Failure stays in the review step so
  the user can fix the URL, authentication, or destination and retry.

Electron's native open dialog supports `openDirectory`, `defaultPath`, cancellation, and parent-window
modality ([Electron `dialog.showOpenDialog`](https://www.electronjs.org/docs/latest/api/dialog#dialogshowopendialogwindow-options)).
It is suitable for **Choose parent…**; the final leaf should remain an editable app field because an
open-directory dialog selects an existing directory, while this operation intentionally creates a new
one.

## Clone commands and authentication

### Git URL

Run Git directly, with an argument array and no shell:

```text
git -c core.hooksPath=<app-empty-hooks-dir> clone --progress -- <url> <final-directory>
```

Git documents HTTPS, HTTP, SSH, scp-like SSH, and unauthenticated `git://` transports; it explicitly
warns that `git://` has no authentication
([Git URL documentation](https://git-scm.com/docs/git-clone#_git_urls)). For this product, accept only
`https://`, `ssh://`, and scp-like SSH (`user@host:path`) in the first slice. Reject HTTP, `git://`,
FTP, `file://`, local paths, remote helpers, and `ext::`. Local repositories already have the Local
folder path, and a narrow allowlist avoids turning a Renderer-provided string into an arbitrary Git
transport. Git's own defaults call HTTP/HTTPS/Git/SSH “known-safe,” deny `ext`, and treat `file` as
user-only, but an explicit product allowlist is easier to explain and test
([`protocol.allow`](https://git-scm.com/docs/git-config#Documentation/git-config.txt-protocolallow)).

`--` ends option parsing. Spawn with discrete arguments, reject NUL/LF/control characters and
overlong inputs, and never concatenate a shell command. Reject HTTPS URLs containing a password/token;
credentials embedded in a clone URL are persisted as `remote.origin.url` by Git, and GitHub likewise
warns that URL tokens remain visible in Git configuration
([Git clone configuration behavior](https://git-scm.com/docs/git-clone#_description),
[GitHub authentication warning](https://docs.github.com/en/codespaces/troubleshooting/troubleshooting-authentication-to-a-repository)).

Use the person's existing SSH agent and Git credential helpers. Git's official credential flow tries
`GIT_ASKPASS`, configured askpass programs, then the terminal; helpers commonly integrate with the OS
keychain ([Git credentials](https://git-scm.com/docs/gitcredentials#_requesting_credentials),
[credential helpers](https://git-scm.com/docs/gitcredentials#_avoiding_repetition)). Because an
Electron child has no useful interactive terminal, set `GIT_TERMINAL_PROMPT=0` so missing credentials
fail promptly rather than hang; Git documents that this disables terminal prompting
([Git environment variables](https://git-scm.com/docs/git#Documentation/git.txt-codeGITTERMINALPROMPTcode)).
Do not store credentials in Argos.

### GitHub repository

Run:

```text
gh repo clone <validated-owner/repo> <final-directory> --no-upstream -- --progress
```

`gh repo clone` officially accepts `OWNER/REPO`, chooses the configured Git protocol when no scheme is
given, accepts a custom destination, and forwards flags after `--` to `git clone`
([GitHub CLI manual](https://cli.github.com/manual/gh_repo_clone)). `--no-upstream` avoids the CLI's
otherwise surprising behavior of adding a fork's parent as another remote. This path lets GitHub CLI
own private-repository authentication, consistent with ADR 0007's decision that Argos stores no
GitHub token. `gh auth setup-git` can also configure GitHub CLI as Git's credential helper, but doing
that mutates the person's global Git configuration, so the app should link/instruct rather than run it
automatically ([GitHub CLI manual](https://cli.github.com/manual/gh_auth_setup-git)).

This intentionally improves on current T3 Code for private repositories: T3 looks up a GitHub repo and
then sends its SSH URL to plain Git. That requires working SSH credentials even if `gh` itself is
authenticated. Calling `gh repo clone` keeps the GitHub-specific entry aligned with the authentication
surface it advertised. The generic Git URL entry remains available for users who prefer their own SSH
or HTTPS setup.

## Validation and security boundaries

1. **Validate at the shared contract.** Use a discriminated source (`git-url` or `github`) plus
   bounded strings and an absolute final destination. Revalidate in Main; the current app already
   validates trusted sender and zod payloads before invoking handlers.
2. **Final destination must not exist.** Resolve its parent, require the parent to be a directory,
   and pass the reviewed final path directly to the clone command. If another process creates the
   target first, fail without trying to merge into or empty it.
3. **Never delete a failed clone automatically.** On error, timeout, cancel, or window shutdown,
   terminate the process and report the exact partial destination. It may now contain useful fetched
   objects or files the person added while the clone was running. A later explicit cleanup action may
   move it to Trash after confirmation, but it is not part of clone cancellation.
4. **Keep the user's Git configuration for credentials, but suppress checkout hooks.** Git's
   `post-checkout` hook is run after clone
   ([Git hooks](https://git-scm.com/docs/githooks#_post_checkout)), and `git clone -c` applies config
   before checkout ([Git clone `--config`](https://git-scm.com/docs/git-clone#Documentation/git-clone.txt--cltkeygtltvaluegt)).
   Point `core.hooksPath` at an app-owned empty directory for this operation. Do not disable all global
   Git config, because that would also discard credential helpers, SSH URL rewrites, certificates, and
   other expected machine setup.
5. **Do not recurse submodules.** Plain clone does not initialize them; `--recurse-submodules` is the
   explicit opt-in ([Git clone submodule option](https://git-scm.com/docs/git-clone#Documentation/git-clone.txt---recurse-submodulesltpathspecgt)).
6. **Treat checkout as code-adjacent, not inert.** A checked-in `.gitattributes` can select a locally
   configured smudge/process filter during checkout
   ([Git attributes filter behavior](https://git-scm.com/docs/gitattributes#_filter)). The app cannot
   promise that cloning an untrusted repository executes nothing while also honoring the person's Git
   configuration. It should avoid adding new execution vectors, retain the existing Project Skill
   trust gate, and never automatically run package installation or repository scripts after clone.
7. **Redact transport output.** Never echo a raw credential-bearing URL. Strip URL userinfo, query,
   and fragment; bound stderr/progress; map common failures to `git unavailable`, `gh unavailable`,
   `GitHub not authenticated`, `authentication failed`, `repository not found or inaccessible`,
   `destination exists`, `network/host-key failure`, `timed out`, and `cancelled`.

## Progress, cancellation, and failure semantics

Git normally emits progress to stderr only when attached to a terminal; `--progress` forces it for a
piped Electron child ([Git clone `--progress`](https://git-scm.com/docs/git-clone#Documentation/git-clone.txt---progress)).
Treat its human text as presentation, not a stable protocol: expose a bounded sanitized latest line
and coarse phase (`starting`, `receiving`, `resolving`, `checking-out`, `verifying`, `adding`). A spinner
plus phase is truthful even when a server does not provide percentages.

Use an operation id because a single `ipcRenderer.invoke` promise does not provide an independent
cancel handle. A minimal Preload surface is:

```ts
startProjectClone(input): Promise<{ operationId: string }>
cancelProjectClone(operationId): Promise<void>
onProjectCloneEvent(listener): () => void
```

Main owns a map of operation id -> scoped Effect fiber/native process. Interruption terminates the
process, waits for exit, retains and reports any partial destination, and emits one terminal event.
Electron documents `ipcMain.handle` as the request/reply boundary and recommends Main-to-Renderer
messages for asynchronous updates
([Electron `ipcMain`](https://www.electronjs.org/docs/latest/api/ipc-main#ipcmainhandlechannel-listener)).
Keep those fixed capabilities behind `contextBridge`; Electron explicitly positions it as the safe
isolated-context bridge and no longer permits exposing `ipcRenderer` itself
([Electron `contextBridge`](https://www.electronjs.org/docs/latest/api/context-bridge)).

Do not use T3 Code's fixed two-minute timeout as the only policy. Large repositories and slow networks
legitimately take longer. Prefer a generous inactivity timeout (for example, ten minutes without
stdout/stderr/progress) plus explicit Cancel, and cap captured output. If a simpler first pass needs a
wall-clock timeout, make it several minutes and name `timed out` distinctly from authentication or
repository errors.

After the child reports success:

1. Run the existing root probe at the final destination.
2. Require the resolved root to equal that destination.
3. Call the existing `acceptProject(finalRoot)` / Core `project/add` path.
4. If Core persistence fails, leave the completed clone on disk and report: “Cloned to
   …, but it could not be added.” Never delete a successful repository merely because app-state
   persistence failed.

## Architecture seams in this repository

The change fits the accepted boundaries:

- **Renderer:** a reusable Add Project source/review/progress state machine used by both onboarding
  and `AppMenu`; React state only.
- **Shared contract:** zod inputs, clone event/result/error unions, and fixed channels. Effect values
  do not cross IPC.
- **Preload:** narrow Promise/event adapters, matching today's `ShellApi`
  ([contract](../../app/src/shared/contract.ts#L437-L485)).
- **Main:** a `ProjectCloneService` containing Git/GitHub process spawning, validation, progress,
  interruption, partial-destination reporting, final verification, and the handoff to
  `acceptProject`. This is Effect-native native behavior with an injected process/filesystem service
  and scoped finalizers, exactly the Main pattern established by ADR 0001
  ([ADR 0001](../../docs/adr/0001-adopt-effect-in-core.md#L27-L65)).
- **Core:** unchanged. It receives only the verified final absolute root and continues to decide
  idempotent identity and persistence. Two clones of one remote remain two Projects because identity
  is path, as ADR 0005 requires.

The existing `chooseProject`, `offerProject`, `initializeProject`, root-confirmation behavior, and
`ChooseProjectResult` should remain intact. The only conceptual documentation change needed when this
ships is to replace copy claiming that adding a Project never writes to disk or that `git init` is the
only setup mutation: remote creation is an explicit person-triggered `git clone`, not passive “adding.”

## Suggested delivery slices

1. Shared clone contract/error model plus Main `ProjectCloneService` tests: URL allowlist, destination
   races, retained partial destinations, cancellation, timeout, redaction, Git unavailable, and
   successful handoff.
2. Git URL flow and reusable three-source UI, including native parent picker and phase progress.
3. GitHub readiness + `gh repo clone`, with missing/unauthenticated/private repository tests.
4. Packaged-shell acceptance coverage: success, cancel, failed clone reports its partial destination,
   and Core persistence failure leaves the completed clone recoverable.

Do not add shallow clone, branches/tags, submodules, templates, provider abstraction, stored tokens,
or the other T3 providers in this feature. They complicate the contract without helping the requested
three-source flow.
