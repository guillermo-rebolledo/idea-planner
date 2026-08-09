# T3 Code GitHub pull request integration

Research date: 2026-08-07  
Source snapshot: official [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) repository at commit [`ed886fe1814890da30ae73c77f9e894ddc9bd481`](https://github.com/pingdotgg/t3code/tree/ed886fe1814890da30ae73c77f9e894ddc9bd481)

Companion research: [T3 Code executable discovery and launch](t3-code-executable-discovery.md), which covers how the same product finds a CLI on `PATH`; [T3 Code provider update checks](t3-code-provider-update-checks.md), which covers its degrade-to-silence pattern; and [GitHub Pull Requests from a Session, and PR status in the mailbox](github-pr-integration-viability.md), the viability assessment this note was written to test against a real implementation.

Method note: the repository was cloned at the pinned SHA and read directly, so every claim below is grep-verified against working files rather than inferred from search snippets. The repo vendors two unrelated third-party checkouts under `.repos/`; nothing from those directories is cited.

## Executive summary

1. **Yes — T3 Code creates pull requests, and it is not a small feature.** There is a dedicated `apps/server/src/sourceControl/` package with four forge providers behind one interface (GitHub, GitLab, Bitbucket, Azure DevOps), roughly 4,000 lines excluding the git layer that drives it. This is the single largest divergence from the viability note's assumption that PR creation is a thin add-on.

2. **It uses the `gh` CLI, not an in-app API client.** No Octokit, no `api.github.com`, no REST client of any kind for GitHub. `GitHubCli` shells out to `gh pr create`, `gh pr list`, `gh pr view`, `gh pr checkout`, `gh repo view`, `gh repo create`, and `gh auth status --json hosts`. Bitbucket is the only provider with a real HTTP client, and that is because Bitbucket has no first-party CLI.

3. **It stores no GitHub credential.** There is no Electron `safeStorage` use for GitHub, no keychain read, no token in settings. Authentication is entirely delegated to `gh`, and the app's only interest in it is a read-only `gh auth status` probe that classifies the account as authenticated / unauthenticated / unknown.

4. **It commits and pushes, on purpose, as an explicit user action.** `GitStackedAction` is a five-valued literal — `commit`, `push`, `create_pr`, `commit_push`, `commit_push_pr` — with per-phase progress events. This is the opposite of our ADR 0006 stance, and it is the decision our Phase 0 has to make. T3 Code did not sneak up on it; it modelled the whole staircase as one contract.

5. **The model writes the commit message and the PR body; the app writes the plumbing.** A separate `apps/server/src/textGeneration/` package asks a configured provider (Codex, Claude, Cursor, Grok, OpenCode) to produce the commit subject, branch name, and PR title/body, under a configurable writing style. This is exactly the recommendation the viability note reached — the harness owns inference — arrived at independently.

6. **The generated body is handed to `gh` as `--body-file`, never as an argument.** `createPullRequest` takes a `bodyFile: string`, and every provider in the registry does the same. The viability note guessed at this; it is confirmed.

7. **`gh pr view --json` field names are now verified, closing an UNVERIFIED item in the viability note.** T3 Code requests `number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner`, and derives a three-state value from `state` plus `mergedAt` — the same merged-vs-closed nuance the viability note identified from the REST docs.

8. **PR state is a three-valued `open | closed | merged` model surfaced in a status bar, not a polled mailbox dot.** There is no ETag cache, no conditional request, no 60-second timer against GitHub. Refresh is event-driven and demand-driven through a VCS status broadcaster.

9. **Missing `gh` and unauthenticated `gh` are distinct, named errors with distinct remediation text** — `GitHubCliUnavailableError` and `GitHubCliAuthenticationError`, each carrying its own `detail` string. This is the same "do not collapse distinct causes" lesson the provider-update-checks note drew from their issue #3806, applied preemptively here.

10. **Sessions are not coupled to worktrees the way ours are.** Worktrees exist and PRs can be materialised into one, but the PR flow operates on a `cwd` and the repository's current branch — it does not require a worktree, and the smallest slice our viability note proposed ("worktree sessions only") has no counterpart in their design.

## 1. Does T3 Code create pull requests? Yes, through a four-forge abstraction

The answer is unambiguous. `apps/server/src/sourceControl/` contains a `SourceControlProvider` service with seven methods, of which `createChangeRequest` is the PR-creation seam. [Source: `SourceControlProvider.ts`, lines 82–130](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/SourceControlProvider.ts#L82-L130)

The service surface is worth reading in full, because it is the shape our own feature would need:

- `listChangeRequests({cwd, headSelector, state, limit})`
- `getChangeRequest({cwd, reference})`
- `createChangeRequest({cwd, baseRefName, headSelector, title, bodyFile})`
- `getRepositoryCloneUrls`, `createRepository`, `getDefaultBranch`, `checkoutChangeRequest`

Note the vocabulary: the domain type is **`ChangeRequest`**, not `PullRequest`, because GitLab calls it a merge request. The GitHub-specific word appears only inside the GitHub adapter. There is a terminology helper (`getChangeRequestTerminologyForKind`) used to build user-facing strings so the same code path can say "PR" or "MR" as appropriate. [Source: `GitManager.ts`, lines 2125–2130](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L2125-L2130)

Four providers are registered against that one interface. [Source: `SourceControlProviderRegistry.ts`, lines 287–312](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/SourceControlProviderRegistry.ts#L287-L312)

| Provider | Transport | Evidence |
|---|---|---|
| GitHub | `gh` CLI | [`GitHubCli.ts` L306–L453](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/GitHubCli.ts#L306-L453) |
| GitLab | `glab` CLI | `GitLabCli.ts` (636 lines) |
| Azure DevOps | `az` CLI + `azure-devops` extension | `AzureDevOpsCli.ts` (536 lines) |
| Bitbucket | HTTP API with a token | [`BitbucketApi.ts` L272 onward](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/BitbucketApi.ts#L272-L290) |

Bitbucket is the exception that proves the rule: it is the one forge without a first-party CLI, and it is the one place where T3 Code writes its own HTTP client and reads a token out of the environment. The product's own documentation states the split plainly — GitHub via `gh`, GitLab via `glab`, Azure via `az`, and *"Bitbucket uses tokens instead of a CLI tool"*. [Source: `docs/user/source-control.md`, lines 82–102](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/docs/user/source-control.md#L82-L102)

This is the load-bearing structural lesson, and it is the opposite of what our viability note assumed. We framed `gh` as a pragmatic first slice on the way to an in-app client. T3 Code treats the CLI as the *permanent* transport and reaches for HTTP only when no CLI exists.

## 2. Git write operations: commit, branch, and push are all first-class

Our app writes no commits and no refs (ADR 0006). T3 Code writes all three, and models the whole ladder as a single enumerated contract:

```ts
export const GitStackedAction = Schema.Literals([
  "commit",
  "push",
  "create_pr",
  "commit_push",
  "commit_push_pr",
]);
```

[Source: `packages/contracts/src/git.ts`, lines 11–18](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/packages/contracts/src/git.ts#L11-L18)

Two things about that literal are worth copying regardless of whether we ever commit anything.

**First, every rung is separately addressable.** A user can commit without pushing, push without a PR, or create a PR on an already-pushed branch. There is no single "ship it" button that hides the git operations.

**Second, each phase reports a named status rather than a boolean.** The result type carries four independent step results — `branch`, `commit`, `push`, `pr` — and each has its own status vocabulary, including the skip reasons:

- `GitCommitStepStatus`: `created | skipped_no_changes | skipped_not_requested`
- `GitPushStepStatus`: `pushed | skipped_not_requested | skipped_up_to_date`
- `GitBranchStepStatus`: `created | skipped_not_requested`
- `GitPrStepStatus`: `created | opened_existing | skipped_not_requested`

[Source: `git.ts`, lines 33–48](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/packages/contracts/src/git.ts#L33-L48), [source: result schema, lines 287–314](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/packages/contracts/src/git.ts#L287-L314)

`opened_existing` is the detail that betrays real production use: creating a PR for a branch that already has one is not an error, it is a distinct outcome that returns the existing PR's URL. Same for `skipped_no_changes` and `skipped_up_to_date`. This is the "name your failures rather than throwing" discipline our own `git.ts` already practises, applied to a write path.

The orchestration is a plain sequence with guards. `wantsPush` is inferred rather than only requested — `create_pr` will push by itself when the branch has no upstream or is ahead — and there are explicit refusals for detached HEAD and for a dirty tree:

- `"Commit local changes before creating a PR."`
- `"Cannot push from detached HEAD."`
- `"Cannot create a pull request from detached HEAD."`

[Source: `GitManager.ts`, lines 2018–2068](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L2018-L2068)

The phases then execute in order, each emitting a `phase_started` progress event before it runs, so the UI can show a live staircase. [Source: `GitManager.ts`, lines 2132–2176](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L2132-L2176)

There is also a `featureBranch` flag on the input which, when set, cuts a new branch before committing — and the branch *name* is model-generated (see section 7). Guarded: *"Feature-branch checkout is only supported for commit actions."* [Source: `GitManager.ts`, lines 2028–2034](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L2028-L2034)

**Where the boundary sits architecturally.** All of it is server-side. The renderer calls one RPC method, `gitRunStackedAction`, which is authorization-gated. [Source: `apps/server/src/ws.ts`, lines 1802–1808](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/ws.ts#L1802-L1808), [source: `RpcAuthorization.ts`, line 69](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/auth/RpcAuthorization.ts#L69) The layering is `GitWorkflowService` → `GitManager` → `SourceControlProvider` → `GitHubCli` → `VcsProcess` → `ProcessRunner`, with `VcsProcess` as the single child-process chokepoint for both `git` and every forge CLI. [Source: `VcsProcess.ts`, lines 42–47](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/vcs/VcsProcess.ts#L42-L47)

**Nothing here is automatic.** Every stacked action originates from a user interaction in the Git actions toolbar; the docs describe it as *"Push a branch and create a pull request from the Git actions controls in the toolbar"*. [Source: `docs/user/source-control.md`, lines 30–42](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/docs/user/source-control.md#L30-L42) I found no scheduled or agent-triggered invocation of `runStackedAction`.

## 3. Worktrees and session isolation: optional, not the unit of the feature

Their "Thread" is our "Session". Their glossary defines the relationship precisely:

> *"A Git worktree used as an isolated workspace for a thread. If a thread has a `worktreePath` in the contracts, it runs there instead of in the main working tree."*

[Source: `docs/internals/glossary.md`, lines 26–29](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/docs/internals/glossary.md#L26-L29)

The key word is *optional*. `worktreePath` is `NullOr` throughout the orchestration contracts, and a thread with a null `worktreePath` runs in the project's main working tree. [Source: `packages/contracts/src/orchestration.ts`, line 363](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/packages/contracts/src/orchestration.ts#L363)

**The PR flow does not care.** `runStackedAction` takes a `cwd` and nothing else identifying a thread. [Source: `git.ts`, lines 112–122](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/packages/contracts/src/git.ts#L112-L122) Whether that `cwd` is a worktree or the primary checkout is invisible to `runPrStep`, which reads the current branch from `git status` and proceeds. [Source: `GitManager.ts`, lines 1636–1651](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L1636-L1651)

So T3 Code does **not** validate our "worktree sessions only" slice, and it does not contradict it either — it simply never needed the distinction, because it was already willing to commit in the primary checkout. Their equivalent guard is a dirty-tree refusal (`"Commit local changes before creating a PR."`), not a checkout-kind refusal.

**The reverse direction does use worktrees, and is the more interesting design.** `preparePullRequestThread` takes a PR reference and a mode of `"local" | "worktree"`, and produces a thread pointed at that PR's head branch. In `worktree` mode it materialises the head branch into a dedicated worktree, configures upstream tracking, and runs the project's setup script in it — with the setup-script failure downgraded to a warning rather than aborting the flow. [Source: mode literal, `git.ts` line 48](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/packages/contracts/src/git.ts#L48), [source: `GitManager.ts`, lines 1801–1853](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L1801-L1853), [source: result shape, `git.ts` lines 275–280](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/packages/contracts/src/git.ts#L275-L280)

That is "review a teammate's PR in an isolated agent session" — a feature adjacent to ours, and one our worktree machinery could support today.

## 4. `gh` CLI, not an API client — and exactly which invocations

### The commands

Every GitHub operation is a `gh` subprocess. There is no HTTP anywhere in the GitHub path. [Source: `GitHubCli.ts`, lines 306–453](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/GitHubCli.ts#L306-L453)

| Operation | Invocation |
|---|---|
| Create a PR | `gh pr create --base <base> --head <headSelector> --title <title> --body-file <path>` |
| Find the branch's open PR | `gh pr list --head <sel> --state open --limit <n> --json …` |
| Read one PR | `gh pr view <ref> --json …` |
| Repo clone URLs | `gh repo view <repo> --json nameWithOwner,url,sshUrl` |
| Create a repo | `gh repo create <repo> --<visibility>` |
| Default branch | `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name` |
| Check out a PR | `gh pr checkout <ref> [--force]` |
| Version probe | `gh --version` |
| Auth probe | `gh auth status --json hosts` |

Create is [lines 422–437](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/GitHubCli.ts#L422-L437); list is [lines 322–336](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/GitHubCli.ts#L322-L336); view is [lines 361–370](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/GitHubCli.ts#L361-L370); repo/default-branch/checkout are [lines 393–452](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/GitHubCli.ts#L393-L452); the discovery spec carrying `--version` and `auth status --json hosts` is [`GitHubSourceControlProvider.ts` lines 85–95](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/GitHubSourceControlProvider.ts#L85-L95).

**`--body-file` is confirmed**, and it is a real temp file with a lifecycle: written under the OS temp dir as `t3code-pr-body-<pid>-<uuid>.md`, and deleted in an `Effect.ensuring` so it is removed on success, failure, and interruption alike. [Source: `GitManager.ts`, lines 1696–1724](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L1696-L1724)

**The interactive-prompt problem our note raised is solved by ordering, not by flags.** `gh pr create` prompts when the branch has no upstream. T3 Code never reaches that state: `runPrStep` hard-fails with `"Current branch has not been pushed. Push before creating a PR."` if `hasUpstream` is false, and `runStackedAction` arranges for the push phase to run first when needed. [Source: `GitManager.ts`, lines 1645–1651](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L1645-L1651), [source: `wantsPush` inference, lines 2020–2026](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L2020-L2026) This is simpler than the `--repo` + explicit `--head` route our note suggested, and it is the answer to that open question.

**`owner/repo` is never derived.** T3 Code lets `gh` resolve the repository from the remote in `cwd`, exactly as our note predicted. The only place a repository name is parsed is *out of a PR URL that `gh` already returned* (`parseRepositoryNameFromPullRequestUrl`), for fork/cross-repository handling. [Source: `GitManager.ts`, line 185](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L185) The fork case is handled by the `headSelector` carrying an `owner:branch` form, with a shared parser that splits on the first colon. [Source: `SourceControlProvider.ts`, lines 55–80](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/SourceControlProvider.ts#L55-L80) — the same `user:ref-name` format our note flagged as a REST trap.

### How `gh` is located

By `PATH`, with no special handling — the same mechanism the [executable-discovery note](t3-code-executable-discovery.md) documents for provider CLIs. `GitHubCli.execute` passes the bare string `"gh"` as the command; `VcsProcess` forwards it to the shared `ProcessRunner`, which spawns without a shell. [Source: `GitHubCli.ts`, lines 309–318](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/GitHubCli.ts#L309-L318)

The connection to that earlier note is direct and load-bearing: `gh` is found because the desktop app already hydrated `PATH` from a login shell before starting the server. There is **no per-provider "binary path" setting for `gh`** the way there is for `codex` or `claude` — a forge CLI outside the hydrated `PATH` has no escape hatch. That asymmetry looks like an oversight rather than a decision, and it is worth not copying.

Unlike the provider CLIs, there is no minimum-version floor for `gh`, and no update advisory. Version drift is instead absorbed at the *decode* layer — see section 6.

### Absent and unauthenticated are different errors

Four tagged errors, each with its own remediation `detail`:

- `GitHubCliUnavailableError` → *"GitHub CLI (`gh`) is required but not available on PATH."*
- `GitHubCliAuthenticationError` → *"GitHub CLI is not authenticated. Run `gh auth login` and retry."*
- `GitHubPullRequestNotFoundError` → *"Pull request not found. Check the PR number or URL and try again."*
- `GitHubCliCommandError` → *"GitHub CLI command failed."*

[Source: `GitHubCli.ts`, lines 28–78](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/GitHubCli.ts#L28-L78)

The classification is structural where it can be and textual where it must be. "Not installed" is detected from the platform error itself — a `NotFound` reason on a `ChildProcess.spawn` — not from stderr. [Source: `GitHubCli.ts`, lines 152–179](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/GitHubCli.ts#L152-L179)

"Unauthenticated" and "not found" are stderr substring matches, in a shared classifier that covers all four forges at once. It matches `"gh auth login"`, `"glab auth login"`, `"az devops login"`, `"not logged in"`, `"unauthorized"`, `"authentication failed"`, `"no oauth token"` for auth; and per-command phrases like `"could not resolve to a pullrequest"` for GitHub not-found. [Source: `VcsProcess.ts`, lines 53–87](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/vcs/VcsProcess.ts#L53-L87)

This is fragile by construction — it is English-language stderr parsing — but it is the direct application of the lesson the [provider-update-checks note](t3-code-provider-update-checks.md) drew from their issue #3806: *"the UI conflates 'your CLI is too old' with 'you're logged out,' which have opposite fixes."* Here, "not installed" and "not signed in" were kept apart from the start.

## 5. Credentials: none stored, for GitHub

Three negative findings, all grep-verified across `apps/` and `packages/` at the pinned SHA (the vendored `.repos/` checkouts excluded):

1. **No Octokit.** Searching for `octokit` and `@octokit` returns **zero** matches.
2. **No GitHub REST calls.** Searching for `api.github.com` returns exactly two matches, neither in the app: the marketing site fetching its own release notes, and a codegen script fetching the Codex protocol definitions from `openai/codex`.
3. **No GitHub token anywhere.** Searching for `GITHUB_TOKEN`, `GH_TOKEN`, and `gh auth token` returns **zero** matches.

What the app does instead is a **read-only auth probe**. `gh auth status --json hosts` is parsed into a typed shape of `{host, account, authenticated, active, error}` per account, and reduced to one of three states — `authenticated`, `unauthenticated`, `unknown` — each carrying a `detail` string and, when known, the host and account login. [Source: `gitHubAuthStatus.ts`, lines 38–72](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/gitHubAuthStatus.ts#L38-L72), [source: `GitHubSourceControlProvider.ts`, lines 45–83](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/GitHubSourceControlProvider.ts#L45-L83)

Note the ordering of that reduction: an *active and authenticated* account wins, then merely authenticated, then a parsed-but-failed account, then a non-zero exit, and only then `unknown`. Multi-account `gh` setups are handled explicitly. It reads the account **login for display only** — it never extracts a token.

The failure detail is sanitised before it crosses the transport: `firstSafeAuthLine`, and for identifiers a `transportSafeSourceControlErrorValue` that strips URL usernames, passwords, query strings, and fragments, then bounds the value at 256 characters. [Source: `SourceControlProvider.ts`, lines 25–53](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/SourceControlProvider.ts#L25-L53) That is a good pattern to steal wholesale: forge CLIs put credentials in remote URLs, and error strings are the classic leak path.

**`safeStorage` exists in the app but is not used for GitHub.** `ElectronSafeStorage` backs the desktop's saved-environment secrets and connection catalogue. [Source: `DesktopSavedEnvironments.ts`, lines 441–500](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/desktop/src/settings/DesktopSavedEnvironments.ts#L441-L500) So the capability was available and deliberately not applied to source control.

**The one forge where credentials are handled is Bitbucket, and the design there is instructive.** No storage either — the token comes from environment variables set by the user on the machine running the server: `T3CODE_BITBUCKET_ACCESS_TOKEN`, or `T3CODE_BITBUCKET_EMAIL` + `T3CODE_BITBUCKET_API_TOKEN`, with the access token winning if both are present. [Source: `docs/user/source-control.md`, lines 82–102](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/docs/user/source-control.md#L82-L102) Even when forced to hold a credential, T3 Code refused to own its lifecycle.

Their documented user contract is therefore identical in spirit to our `Readiness.tsx` promise — install the CLI yourself, sign in yourself, we will tell you whether it worked:

> *"Provider shows 'Not authenticated' – Run the login command for that provider (e.g., `gh auth login`) in a terminal on the server, then rescan in Settings"*

[Source: `docs/user/source-control.md`, lines 127–131](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/docs/user/source-control.md#L127-L131)

## 6. Status refresh and UI surfacing

This is the section with the most transferable detail, because they have clearly been burned here and fixed it in place.

### The state model is three-valued, derived from `state` + `mergedAt`

`ChangeRequestState` is `"open" | "closed" | "merged"` end to end — contract, server, and UI. [Source: `git.ts`, lines 45–47](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/packages/contracts/src/git.ts#L45-L47)

The derivation is exactly the nuance our viability note identified from the REST docs, implemented for `gh`'s JSON:

```ts
if ((typeof input.mergedAt === "string" && input.mergedAt.trim().length > 0) ||
    normalizedState === "MERGED") return "merged";
if (normalizedState === "CLOSED") return "closed";
return "open";
```

[Source: `gitHubPullRequests.ts`, lines 58–73](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/gitHubPullRequests.ts#L58-L73)

Note it belt-and-braces both signals: `gh pr view --json state` *does* report `MERGED` directly (unlike REST `state`, which is only `open`/`closed`), but `mergedAt` is checked first anyway. **This closes the `gh pr view --json` UNVERIFIED item in our viability note**: the fields requested are `number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner`, and `state` is upper-case.

### Decode is deliberately lenient about `gh` version drift

Two defensive choices worth copying verbatim:

1. Optional fields with an explanatory comment: *"gh < 2.47 exports headRepository as {id, name} only; nameWithOwner was added later. Both fields stay optional so a version-drifted gh CLI can never fail the decode and silently drop the PR from the list."* [Source: `gitHubPullRequests.ts`, lines 33–50](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/gitHubPullRequests.ts#L33-L50)

2. **List decoding is per-entry.** The outer array is decoded as `Array<Unknown>`, then each element is decoded individually and *skipped* on failure rather than failing the whole list. [Source: `gitHubPullRequests.ts`, lines 111–130](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/gitHubPullRequests.ts#L111-L130) Their own test names the intent: *"status ignores invalid gh pr list entries and keeps valid ones"*. [Source: `GitManager.test.ts`, line 761](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.test.ts#L761)

This is the answer to a version-drift problem the provider-update-checks note left open for *harness* protocols, applied to a CLI's JSON output: absorb drift at the schema boundary rather than gating on a version floor.

### Cadence: two clocks, not one

**Clock 1 — local/remote git status.** A per-`cwd` refresh loop with a default interval of 30 seconds (`DEFAULT_VCS_STATUS_REFRESH_INTERVAL`, and the user-facing `automaticGitFetchInterval` setting defaults to the same 30s). [Source: `VcsStatusBroadcaster.ts`, line 28](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/vcs/VcsStatusBroadcaster.ts#L28), [source: `settings.ts`, line 496](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/packages/contracts/src/settings.ts#L496)

**Clock 2 — the PR lookup, deliberately slower.** The comment states the design directly:

> *"PR lookups hit the hosting provider's API (gh/glab/...), so they refresh on their own, slower cadence: ahead/behind counts stay fresh on every status poll while the PR association is re-fetched at most once per PR_LOOKUP_CACHE_TTL per branch. Git actions and user-driven refreshes bump the epoch (invalidateStatus) to bypass the cache immediately."*

[Source: `GitManager.ts`, lines 891–908](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L891-L908)

`PR_LOOKUP_CACHE_TTL` is **2 minutes**, keyed on `[cwd, branch, upstreamRef, epoch]`. [Source: `GitManager.ts`, lines 110–115](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L110-L115), [source: cache construction, lines 926–954](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L926-L954)

The `epoch` segment is an elegant trick: an explicit user refresh or a completed git action bumps a counter, which changes every cache key for that `cwd`, invalidating without needing to enumerate branches. And `refreshStatus` calls the *full* `invalidateStatus` specifically so *"an explicit refresh also bypasses GitManager's slow PR-lookup cache"*. [Source: `VcsStatusBroadcaster.ts`, lines 368–380](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/vcs/VcsStatusBroadcaster.ts#L368-L380)

### Failure handling: exponential backoff, with a comment explaining why the naive version was worse

This is the single most valuable finding in the note, because it is a bug we would otherwise have shipped:

> *"A hosting provider rejects a throttled request immediately, so caching every failure for a flat 20s made a rate-limited poller re-ask **faster** than a healthy one does (which waits PR_LOOKUP_CACHE_TTL), turning a transient 429 into sustained pressure. Backing off per branch keeps the retry rate below the healthy rate once a branch has failed more than a couple of times."*

[Source: `GitManager.ts`, lines 117–131](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L117-L131)

`prLookupFailureTtl` is therefore `20s × 2^(failures−1)`, capped at 15 minutes, with the streak counter cleared on the first success and the map bounded at the cache capacity. [Source: `GitManager.ts`, lines 909–953](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L909-L953)

**And a failed lookup does not clear the badge:**

> *"A transient lookup failure (rate limit, network blip) must not clear an already-known PR badge, so the last successful answer per branch sticks around as the fallback. Keep the resolved head context with it so a branch retargeted to another remote/fork cannot inherit the old badge."*

[Source: `GitManager.ts`, lines 955–964](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L955-L964)

That second sentence is the correctness half of the trick, and it is easy to miss: caching last-known state per *branch* is wrong if the branch's remote changed.

The broadcaster's own loop adds a third layer — consecutive-failure counting with `remoteRefreshFailureDelay`, logging a warning with `cwdLength` rather than `cwd` (path privacy), and continuing rather than dying. [Source: `VcsStatusBroadcaster.ts`, lines 420–443](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/vcs/VcsStatusBroadcaster.ts#L420-L443)

**No ETags, no conditional requests.** Because it goes through `gh`, T3 Code gets none of the 304-exemption economics our viability note built its cadence argument on. It compensates with the 2-minute TTL and the backoff. This is a real, quantifiable cost of the CLI-only approach and the strongest argument in favour of an eventual in-app client — but they have evidently decided the tradeoff is worth it.

### Demand-gating and power-awareness

The poller only runs when someone is watching *and* the machine is willing. Each tick checks `backgroundPolicy.shouldRunScopeWork({type: "vcs-status", cwd})` across the set of `cwd`s with active demand, and skips the refresh entirely if none qualify. [Source: `VcsStatusBroadcaster.ts`, lines 401–415](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/vcs/VcsStatusBroadcaster.ts#L401-L415)

`shouldRunScopeWork` returns false when the host is constrained: suspended, locked (if `pauseWhenHostLocked`), under thermal pressure (`serious` or `critical`), in low-power mode, or on battery — each behind a setting. [Source: `BackgroundPolicy.ts`, lines 141–155](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/background/BackgroundPolicy.ts#L141-L155), [source: `shouldRunScopeWork`, lines 291–300](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/background/BackgroundPolicy.ts#L291-L300)

Pollers are also reference-counted per `cwd` and interrupted when the last subscriber goes away. [Source: `VcsStatusBroadcaster.ts`, lines 465–553](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/vcs/VcsStatusBroadcaster.ts#L465-L553)

This is substantially more careful than the "60s focused / 5min unfocused" heuristic our note proposed, and it generalises better: the question is not *is the window focused* but *is anyone leasing this scope, and can the machine afford it*.

### The UI indicator, and its colours

There is a per-thread PR indicator in the sidebar — the direct analogue of our mailbox row dot. `prStatusIndicator` maps state to a colour class, a label, and a tooltip:

| State | Colour | Label |
|---|---|---|
| `open` | `text-emerald-600` / dark `emerald-300/90` | "PR open" |
| `merged` | `text-violet-600` / dark `violet-300/90` | "PR merged" |
| `closed` | `text-red-600` / dark `red-300/90` | "PR closed" |

[Source: `ThreadStatusIndicators.tsx`, lines 49–97](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/web/src/components/ThreadStatusIndicators.tsx#L49-L97), [source: hover variants, lines 38–47](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/web/src/components/ThreadStatusIndicators.tsx#L38-L47)

Four design points, all of which our note either got right or should adopt:

- **Violet for merged**, matching GitHub's own convention. Do not use green for merged.
- **The function returns `null` when there is no PR** — the indicator is absent, not grey or "unknown". Same degrade-to-nothing pattern as the provider-update advisories.
- **It is a separate element with its own icon** (`GitPullRequestIcon`), not a recolouring of the thread's status pill. Our note reached the same conclusion for `SessionStatus`, independently.
- **The tooltip is structured**, not a string: `"PR #123 - Open"` as a lead, a divider, then the PR title, each independently truncated. [Source: `ThreadStatusIndicators.tsx`, lines 103–111](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/web/src/components/ThreadStatusIndicators.tsx#L103-L111)

The label is provider-aware via `resolveChangeRequestPresentation`, so a GitLab project's rows say "MR" rather than "PR".

There is no colour-coded **CI/checks** state anywhere. Grepping the whole repo for `statusCheckRollup`, `mergeable`, `checkSuite`, and `gh pr checks` returns **zero** matches. PR state only — the same scope boundary our note drew.

## 7. Description generation: the model writes it, the app orchestrates it

This is where T3 Code independently arrived at the recommendation our viability note made.

### A dedicated text-generation subsystem, separate from the chat session

`apps/server/src/textGeneration/` has one adapter per provider (Claude, Codex, Cursor, Grok, OpenCode) behind a `TextGeneration` service with three generation methods, of which `generatePrContent` is ours. [Source: `TextGeneration.ts`, lines 96–108](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/textGeneration/TextGeneration.ts#L96-L108)

The input and output types are small and structured:

```ts
export interface PrContentGenerationInput {
  cwd: string; baseBranch: string; headBranch: string;
  commitSummary: string; diffSummary: string; diffPatch: string;
  changeRequestTemplate?: string; policy?: TextGenerationPolicy;
  modelSelection: ModelSelection;
}
export interface PrContentGenerationResult { title: string; body: string; }
```

[Source: `TextGeneration.ts`, lines 32–49](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/textGeneration/TextGeneration.ts#L32-L49)

Crucially, this is **not** the thread's own session. It is a separate, short, structured-output call to a model the user picks — there is a dedicated `sourceControlWriterModelSelection` setting that falls back to a general `textGenerationModelSelection`. [Source: `GitManager.ts`, lines 2074–2090](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L2074-L2090)

That is a meaningfully different answer from our note's "ask the Harness during a Run". T3 Code separates *the agent doing the work* from *the model writing the prose*, so a cheap model can write commit messages while an expensive one codes. It still keeps the app itself free of inference.

### The prompt is fully visible in the source

`buildPrContentPrompt` composes: a role line, `"Return a JSON object with keys: title, body."`, body rules, optional policy instructions, the optional repository template, then base branch, head branch, commits, diff stat, and diff patch. Without a template the rules are explicit about structure:

> `"- body must be markdown and include headings '## Summary' and '## Testing'"`  
> `"- under Summary, provide short bullet points"`  
> `"- under Testing, include bullet points with concrete checks or 'Not run' where appropriate"`

[Source: `TextGenerationPrompts.ts`, lines 94–138](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/textGeneration/TextGenerationPrompts.ts#L94-L138)

Output is schema-constrained (`Schema.Struct({title, body})`), so a malformed response fails a decode rather than producing a garbage PR.

### Everything is bounded, twice

Our `boundedSessionDiff` has a direct counterpart, and it is applied at both layers:

| Section | Limit at call site (`runPrStep`) | Limit inside the prompt builder |
|---|---|---|
| Commit summary | 20,000 chars | 12,000 |
| Diff stat | 20,000 | 12,000 |
| Diff patch | 60,000 | 40,000 |
| Repo PR template | — | 8,000 |

[Source: `GitManager.ts`, lines 1684–1694](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L1684-L1694), [source: `TextGenerationPrompts.ts`, lines 116–129](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/textGeneration/TextGenerationPrompts.ts#L116-L129)

The material fed in is a *branch range* against the resolved base, computed by `readRangeContext(cwd, baseRangeRef)` — not a per-turn diff. Our snapshot store's `diffSnapshots(firstRun.before, lastRun.after)` is the equivalent, and it is bounded already.

### Repository PR templates are detected and honoured

When the writing style has `followChangeRequestTemplates` and the provider is GitHub, the app looks for a PR template in the repository *at the base ref* and injects it into the prompt, switching the body rules to "fill in the template sections". [Source: `GitManager.ts`, lines 1679–1682](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L1679-L1682)

It checks six file paths and three directories, and reads them out of the git tree rather than the working directory — validating blob mode and object id before reading, capping the template at 8,000 bytes and the tree listing at 100,000. [Source: `PrTemplateDetection.ts`, lines 7–58](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/PrTemplateDetection.ts#L7-L58)

Our note listed PR templates as explicitly out of scope. Given the template lives in the repo the app is already reading, this is cheaper than it sounds — and skipping it means generating bodies that violate a team's stated convention on the very first PR.

### Writing style is user-configurable, including "infer from this repo"

`TextGenerationPolicyKind` is `default | conventional_commits | repo_conventions | custom`, with separate instruction slots for commits, change requests, branches, and thread titles. [Source: `TextGenerationPolicy.ts`, lines 3–18](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/textGeneration/TextGenerationPolicy.ts#L3-L18)

The `repo_conventions` mode is nicely concrete: it reads recent commit subjects out of the repository and appends them to the instructions as few-shot examples — *"Recent commit subjects from this repository:"*. [Source: `GitManager.ts`, lines 625–645](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L625-L645)

### The generated PR is created without a review step

`runPrStep` writes the generated body straight to the temp file and calls `createChangeRequest`. There is no "show the body, let the user edit, then submit" gate in this path. [Source: `GitManager.ts`, lines 1696–1724](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L1696-L1724)

The commit path *does* let the user supply or edit a message (`commitMessage` is an optional input, capped at 10,000 characters). [Source: `git.ts`, lines 112–122](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/packages/contracts/src/git.ts#L112-L122) The PR body has no equivalent.

**This is the one place I would not follow them.** Our note's position — *"a generated description the person cannot correct is worse than none"* — still looks right, and T3 Code's own asymmetry (editable commit message, non-editable PR body) reads more like an omission than a decision. Marked as my judgement, not a finding.

## 8. What this means for our app

### Open questions from `github-pr-integration-viability.md` that this answers

**Answered — `gh pr view --json` field names.** Our note recorded this as UNVERIFIED. The working set is `number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner`, `state` is upper-case, and `MERGED` is a real value (unlike REST). [`GitHubCli.ts` L361–370](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/GitHubCli.ts#L361-L370) Belt-and-braces the derivation with `mergedAt` anyway, as they do.

**Answered — the `gh pr create` interactive-prompt problem.** Do not reach for `--repo` and an explicit `--head`. Push first and refuse the PR step when the branch has no upstream, with a message that says so. [`GitManager.ts` L1645–1651](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L1645-L1651)

**Answered — deriving `owner/repo`.** You do not have to. This is the single biggest cost item our note identified ("a new observation the app does not currently make, with real failure modes"), and choosing `gh` deletes it: `gh` resolves the repository from the `cwd`'s remote itself, and the only parsing T3 Code does is on URLs `gh` already returned. Our ADR 0005 identity-by-path stance is untouched.

**Answered — how to name the `head` for forks.** `owner:branch`, split on the first colon, shared across all four forges. [`SourceControlProvider.ts` L55–80](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/SourceControlProvider.ts#L55-L80)

**Answered — whether generated bodies should be passed as files.** Yes, `--body-file` with a temp file removed under `Effect.ensuring`. [`GitManager.ts` L1696–1724](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L1696-L1724)

**Answered — who writes the description.** The model, not the app. But refined: a *separate, user-chosen writer model* with a structured-output schema, not the Session's own agent mid-Run. That fits our no-inference rule as cleanly as the MEM-94 route and avoids perturbing the Run.

**Answered, and corrects our recommendation — polling cadence.** Our note proposed 60s focused / 5min unfocused with conditional GETs. T3 Code's evidence says: (a) via `gh` you get no ETags at all, so the 304 economics vanish; (b) a *flat* failure TTL is actively harmful, because a throttled request fails instantly and therefore retries faster than the healthy path; (c) the right gate is demand-and-power leases, not window focus. Their numbers: 2-minute success TTL, 20s→15min exponential failure backoff, last-known-good retained across failures with the head context stored alongside it so a retargeted branch cannot inherit a stale badge. [`GitManager.ts` L110–131](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L110-L131), [L891–964](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L891-L964)

**Answered — the colour model.** Emerald open, violet merged, red closed; a separate icon element, not a recoloured status dot; `null` when there is no PR. [`ThreadStatusIndicators.tsx` L38–97](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/web/src/components/ThreadStatusIndicators.tsx#L38-L97)

**Confirmed — no stored credential is a viable end state, not just a first slice.** T3 Code ships four forges, a paid product, and zero GitHub token storage, with `safeStorage` available and used elsewhere in the same app. Our `Readiness.tsx` promise does not have to be softened for this feature.

### Open questions this does *not* answer

- **Whether to commit at all.** T3 Code committing is not evidence for us; it never adopted ADR 0006's "the app writes no commits, no refs" position in the first place — it writes `refs/t3/checkpoints` into the user's repository as a matter of course. Our Phase 0 decision stands entirely on its own. What T3 Code *does* show is that if you do commit, the honest shape is a fully enumerated, user-initiated ladder with named skip reasons — not a hidden step inside "create PR".
- **Whether "worktree Checkouts only" is the right slice.** They have no counterpart, because they were already willing to operate on the primary checkout. No evidence either way.
- **Whether a mailbox row can be joined back to a Run** (our note's other UNVERIFIED item). Nothing here bears on it.
- **Whether `gh` should be a Readiness-tracked executable.** T3 Code discovers `gh` through a *source-control* discovery surface, separate from provider readiness, with its own settings page and rescan. [`SourceControlDiscovery.ts` L131–139](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/SourceControlDiscovery.ts#L131-L139) That is a plausible model for us but is a product decision, not a technical finding.

### Things worth stealing outright

1. **`transportSafeSourceControlErrorValue`** — strip URL credentials and query strings, bound at 256 chars, before any forge identifier or error string crosses a transport boundary. Forge CLIs put tokens in remote URLs. [`SourceControlProvider.ts` L25–53](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/SourceControlProvider.ts#L25-L53)
2. **Per-entry lenient list decoding.** Decode the array as `Unknown[]`, decode each element separately, skip failures. One malformed PR must not blank the whole list. [`gitHubPullRequests.ts` L111–130](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/gitHubPullRequests.ts#L111-L130)
3. **Named errors with remediation text per cause** — absent vs unauthenticated vs not-found vs generic, with "not installed" detected structurally from the spawn error rather than from stderr. [`GitHubCli.ts` L28–78](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/GitHubCli.ts#L28-L78), [L152–179](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/GitHubCli.ts#L152-L179)
4. **The epoch-suffixed cache key.** Bump a per-`cwd` counter to invalidate every branch's cached PR lookup at once without enumerating them. [`GitManager.ts` L896–908](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/git/GitManager.ts#L896-L908)
5. **Exponential failure TTL, and last-known-good retention keyed with its head context.** Both are non-obvious and both were clearly learned the hard way.
6. **Two-layer context bounding** on anything sent to a model, with the outer bound at the call site and the inner bound in the prompt builder.
7. **PR template detection read from the git tree**, not the working directory, with mode and object-id validation. [`PrTemplateDetection.ts` L7–58](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/sourceControl/PrTemplateDetection.ts#L7-L58)
8. **`ChangeRequest` as the domain word**, with a per-provider terminology resolver for display. Cheap now, and it is what makes GitLab support a data change rather than a rewrite.

### Things to deliberately not copy

- **No editable PR body before submission.** Keep our note's position.
- **No binary-path override for `gh`.** They have one for every provider CLI and none for the forge CLIs; a user whose `gh` sits outside the hydrated `PATH` has no recourse.
- **English stderr substring matching for auth failures.** [`VcsProcess.ts` L53–87](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/vcs/VcsProcess.ts#L53-L87) It is the only available signal today, but it should be treated as a known-fragile seam with a fallback, not as a classification you trust.
- **The full four-forge abstraction on day one.** The interface shape is worth borrowing; the three non-GitHub implementations are not.

### Suggested amendment to our phased path

Phases 1–3 of the viability note survive intact, with three edits:

- **Phase 1 can be dropped almost entirely.** Remote observation and `owner/repo` derivation were its whole content, and `gh` makes them unnecessary. Replace it with a `gh` discovery probe: `gh --version` and `gh auth status --json hosts`, reduced to authenticated / unauthenticated / unknown / not-installed with distinct remediation strings.
- **Phase 2 gains a push step and loses the `--fill` question.** Order is: commit → push (set upstream) → `gh pr create --base --head --title --body-file`. Refuse rather than prompt when the branch has no upstream.
- **Phase 4 is re-specified.** Not "conditional GET with ETags every 60s", but: a 2-minute success TTL per `(checkout, branch, upstream)`, exponential failure backoff from 20s to 15 minutes, last-known-good retained across failures alongside the head context, invalidated eagerly after any app-initiated git action, and gated on someone actually looking at the row.

### Unverified in this note

- I did not read the GitLab, Bitbucket, or Azure DevOps adapters beyond confirming their transport and their `createPullRequest` entry points. Claims about them are limited to that.
- I did not trace the full renderer wiring from `VcsStatusResult.pr` to the sidebar row render — I verified the indicator function and its call site imports, not the complete render path.
- I did not check the repository's issue or PR history for the rationale behind these designs (the code comments were unusually explicit, so it was not needed for the polling findings, but the *motivation* for shipping four forges is unestablished).
- `resolveChangeRequestPresentation` is cited by name from its import and call site; I did not read its implementation, so the exact GitLab label string is unconfirmed.

**Worth noting for ADR 0006's sake:** T3 Code *does* write refs into the user's repository, under a namespaced prefix, for its own checkpointing — `refs/t3/checkpoints`. [Source: `apps/server/src/checkpointing/Utils.ts`, line 4](https://github.com/pingdotgg/t3code/blob/ed886fe1814890da30ae73c77f9e894ddc9bd481/apps/server/src/checkpointing/Utils.ts#L4) Our ADR 0006 deliberately chose an app-owned object store instead. This is a genuine fork in the road that two products took differently; neither is obviously wrong, but it means T3 Code's willingness to commit is not an isolated decision — it is consistent with a broader stance that the app may write into the repository under its own namespace.
