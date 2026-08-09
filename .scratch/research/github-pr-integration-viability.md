# GitHub Pull Requests from a Session, and PR status in the mailbox

Research date: 2026-08-07

Scope: viability only. No app source was modified and no code was written.

Two claims in this document are marked **UNVERIFIED** where a background search
did not return before writing; they are the mailbox-to-Run linkage and the
existence of any periodic-refresh loop in Main. Everything else was read
directly out of the working tree at the cited line, or fetched from the cited
docs URL.

## Question

For a macOS Electron app that drives locally-installed coding agents against a
local git repository: can it open a GitHub Pull Request from what a Session
changed, with an auto-generated description; and can the inbox show, per
Session, whether that PR is open, merged, or closed unmerged — as a coloured
indicator that keeps itself current?

## Executive conclusion

1. **Viable, and smaller than it looks — but not for the reason you would
   expect.** The GitHub half is nearly free: three REST endpoints, an
   authenticated rate limit of 5,000 requests/hour, and conditional requests
   that cost nothing when nothing changed. The expensive half is entirely
   local, and it is **git, not GitHub**: this app has *no* concept of a remote.
   `app/src/main/git.ts` observes, snapshots, diffs, and creates worktrees, and
   it never says `remote`, `push`, or `origin` — verified by grep across the
   whole file. There is no commit path either. Snapshots are deliberately
   *trees*, written into an app-owned object store, never into the person's
   repository (ADR 0006, `docs/adr/0006-app-owned-git-snapshots-and-guarded-undo.md:29-42`).
   **A PR needs commits on a branch on a remote. The app currently produces
   none of those three things.**

2. **The smallest credible slice is: isolated (Worktree) Checkouts only, `gh`
   CLI only, no stored token, no polling.** A Worktree Session already owns a
   real branch cut from a chosen base
   (`app/src/main/git.ts:225-250`, `WorktreeCreation` carries `branch`). Commit
   the Session's changes on that branch, then shell out to `gh pr create
   --title … --body-file …`, which pushes an upstream-less branch for you and
   prints the PR URL ([gh pr create](https://cli.github.com/manual/gh_pr_create)).
   That slice needs **zero** credential storage, zero HTTP client, zero new
   dependency, and it fits the app's existing posture verbatim: *"This app
   never installs, updates, signs in, or stores credentials"*
   (`app/src/renderer/src/components/Readiness.tsx:129-130`).

3. **The mailbox indicator is a one-field change.** The row dot is already a
   status-keyed colour lookup —
   `app/src/renderer/src/components/Mailbox.tsx:995-1000` maps `SessionStatus`
   to a Tailwind class and a screen-reader string. But **do not extend
   `SessionStatus`**. That enum is documented as *derived from the Conversation
   rather than stored*, because "a status written beside it is one that can
   disagree with it" (`app/src/shared/contract.ts:119-129`). PR state is the
   opposite kind of fact: it is remote, stored, and stale by construction. It
   belongs in a **separate optional field on `mailboxSessionSchema`**
   (`app/src/shared/contract.ts:132-137`, which already carries exactly this
   shape of nullable adornment in `waitingFor`), rendered as a **second,
   distinct indicator** — not by recolouring the dot that means "the agent is
   waiting on you".

4. **Auth recommendation: `gh` CLI first; OAuth Device Flow only if you later
   need in-app status.** Device Flow is well-specified and needs no client
   secret ([authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)),
   and Electron `safeStorage` gives you Keychain-backed persistence on macOS
   ([safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)).
   But shipping either means the app now stores a credential, which reverses a
   stated product promise. The precedent already in the tree is instructive:
   the Claude adapter **reads** an OAuth token out of the login keychain at
   launch and never persists one
   (`app/src/main/harness-adapter.ts:275-284`, `:422-427`). `gh auth token`
   is the same move for GitHub.

5. **Webhooks are not available to this app, so polling is forced — and that is
   fine.** GitHub delivers by HTTP POST "to the URL that you specified"
   ([about webhooks](https://docs.github.com/en/webhooks/about-webhooks)); a
   desktop app on a laptop has no such URL. Polling is explicitly the
   documented fallback, and a conditional `GET` that returns `304` **does not
   count against the primary rate limit**
   ([best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2022-11-28)).
   At 5,000 requests/hour, polling every open PR every 60 seconds is
   affordable by roughly two orders of magnitude.

6. **Nothing in the architecture blocks this**, and the layering is
   unambiguous. A GitHub client is external I/O with credentials and native
   processes — that is Main, not Core. ADR 0001 is explicit: *"Main Harness
   Adapters own credentials, staged homes, launch arguments and environment"*
   (`docs/adr/0001-adopt-effect-in-core.md:96-98`), and Main product behaviour
   is Effect-native under one Electron-lifetime runtime (`:36-40`). The push
   path to the Renderer already exists and is proven.

---

## What already exists in this codebase

### The git plumbing (MEM-98, commits `52ef88b` and `5208d27`)

Verified by reading `app/src/main/git.ts` and `app/src/main/snapshot-store.ts`.

**What it gives you, for free:**

- **A per-Run before/after tree of the Checkout.** `snapshotCheckout()`
  (`app/src/main/git.ts:333`) stages the working directory with `git add -A`
  into a *fresh temporary index* and `git write-tree`s it
  (`:367-373`). Critically it does this without touching the user's repo:
  "git is pointed at an app-owned index and an app-owned object directory, with
  the repository added only as a read-only alternate" (`:328-331`). The
  person's `.gitignore` still applies (`:331`), so build output is already
  excluded — which is exactly what you want in a PR.
- **Durable retention of those trees for the life of the Session.**
  `SessionSnapshotStore` (`app/src/main/snapshot-store.ts:46`) keeps
  `{sessionId, runId, checkout, before, after, capturedAt}`
  (`:25-43`) in a content-addressed store under application support
  (`:59-61`), retained through Archive and removed only on Delete (`:14-18`,
  `:101-103`).
- **A file-level changed-set with unified diffs.** `diffSnapshots()`
  (`app/src/main/git.ts:613`) runs `git diff-tree -r --name-status -z` between
  two trees and returns `SnapshotChange[]` — `{path, changeKind, diff}`
  (`:302-309`) — capped at `MAX_CHANGED_FILES = 500` (`:752`) and
  `MAX_DIFF_BYTES = 8 MiB` (`:745`), with `unlisted` reporting the overflow
  honestly rather than silently truncating (`:311-319`).

**This is the material an auto-generated PR description wants**, and it is
already bounded, already deduplicated, and already ignores what git ignores.
Composing a Run-spanning changed-set is `diffSnapshots(firstRun.before,
lastRun.after)` — the store keys by `runId` (`:128-130`) so both trees are
reachable.

**What it does not give you — and this is the whole cost of the feature:**

| Needed for a PR | Present? | Evidence |
|---|---|---|
| A branch | Worktree Sessions only | `createWorktree()` returns `branch` (`app/src/main/git.ts:225-250`); `currentBranch()` (`:177`); `listBranches()` (`:199`) |
| A commit | **No** | No `git commit` anywhere in `git.ts`; ADR 0006 explicitly: "The app writes no commits, no refs, and no new mechanism" (`docs/adr/0006-…:35-36`) |
| A remote / push | **No** | grep for `remote`/`push`/`origin` across `app/src/main/git.ts` returns only an unrelated `changes.push(` at `:667` |
| Knowledge of `owner/repo` | **No** | Projects are identified by "the resolved path of its root" (`CONTEXT.md:10`, ADR 0005) |

That last row is a real design point, not a detail: **the app deliberately
identifies a Project by filesystem path, not by remote** (ADR 0005,
`docs/adr/0005-git-decides-project-identity.md`). Deriving `owner/repo` means
reading `git remote get-url origin` and parsing it — a new observation the app
does not currently make, with real failure modes (no remote, SSH vs HTTPS,
multiple remotes, forks, `insteadOf` rewrites).

Also note ADR 0006's rejected option, verbatim: **"Commit before every Run.
Rejected: it rewrites the person's history for the app's convenience"**
(`docs/adr/0006-…:72-73`). That rejection was about *automatic* commits on the
primary checkout. A PR flow is user-initiated and, in the recommended slice,
worktree-only — so it does not reopen the decision. But it must be argued
explicitly, not assumed.

### MEM-94: bounded recorded session diff (commit `5f39c2c`)

Verified. This landed in the **tool host**, not the IPC surface — it exposes
the recorded Session diff *to the Harness as a callable tool*, so an agent can
read what its own Session changed. `app/src/main/tool-host.ts:95` defines a
discriminated `sessionDiffArgumentsSchema` over `mode: 'summary' | 'file'`;
`:445` dispatches `SESSION_DIFF_TOOL_NAME`; `:469` is `readSessionDiff`; `:538`
is `boundedSessionDiff(mode, entries, path?)`, which is the bounding function.
`:489` blocks "a path outside the recorded Session diff".

**Why this matters more than it first appears.** The single hardest part of
"a meaningful auto-generated description" is generating prose, and this app
does not do inference — *"The app never provides inference itself"*
(`CONTEXT.md:68`). MEM-94 is the way out: the agent that did the work can
already read the recorded Session diff through a bounded tool, so a PR
description can be produced **by the Harness during a Run**, not by the app.
That keeps the no-inference rule intact. The fallback if you do not want a
Harness round-trip is a mechanical description assembled from
`SnapshotComparison` — file list, change kinds, `unlisted` count — plus the
Session title and the user's own messages. Mechanical is honest; it is also
duller.

### The mailbox

Verified in `app/src/shared/contract.ts` and
`app/src/renderer/src/components/Mailbox.tsx`.

- Domain: a Session *"appears as a single item in the inbox"* (`CONTEXT.md:14`).
  The contract spells the surface `mailbox`; prose says inbox.
- Query: `mailboxQuerySchema = {search, view}` where
  `mailboxViewSchema = 'active' | 'archived'`
  (`app/src/shared/contract.ts:103-111`); Main widens it to
  `mailboxCoreQuerySchema` by adding `dormantAfterDays`
  (`:113-117`) from settings.
- Item: `mailboxSessionSchema = sessionSummarySchema.extend({dormant, status,
  waitingFor})` (`app/src/shared/contract.ts:132-137`). `waitingFor` is
  `z.enum(['approval','question']).nullable().default(null)` — **the exact
  precedent for a nullable per-item adornment**, including the `.default(null)`
  that keeps old rows valid.
- Status: `sessionStatusSchema = z.enum(['running','blocked','idle','failed'])`
  (`:129`), with the doc comment insisting it is derived, never stored
  (`:119-128`).
- The indicator already exists: `DOT_OF_STATUS` at
  `app/src/renderer/src/components/Mailbox.tsx:995-1000` is a
  `Partial<Record<SessionStatus, {colorClass, said}>>` mapping `blocked` →
  `bg-status-blocked`, `running` → `bg-status-running`, `failed` →
  `bg-status-failed`, each with an accessible string ("Waiting on you",
  "Running", "The last Run failed"). `SessionRow` follows at `:1002`.

So the *rendering* work is: one more optional field on the schema, one more
lookup table beside `DOT_OF_STATUS`, one more element in `SessionRow`. That is
genuinely small.

**Inference, not verified:** whether a mailbox row can be joined back to the
Run/Session that would own a PR record. `mailboxSessionSchema` extends
`sessionSummarySchema`, which by name must carry the session id, so the join
key is almost certainly there — but I did not read `sessionSummarySchema`
itself. Confirm before planning.

### IPC and the push path to the Renderer

Verified end to end.

- Channels are a dependency-free constant map,
  `app/src/shared/channels.ts:5-62`, deliberately importable by the sandboxed
  Preload (`:1-4`). `queryMailbox: 'mailbox:query'` is `:22`.
- Request/response is the norm, but **a push path already exists and is
  proven**: `mainWindow?.webContents.send(IPC_CHANNELS.conversationEvent,
  event)` at `app/src/main/index.ts:999`, subscribed in Preload with
  `ipcRenderer.on(...)` returning an unsubscribe closure
  (`app/src/preload/index.ts:77-78`). Four other one-way sends follow the same
  shape (`app/src/main/index.ts:871, 940, 952, 1037, 1084`).
- MEM-98's own IPC is the template for a new pair of request channels:
  `prepareRunUndo: 'run:undo-prepare'` and `applyRunUndo: 'run:undo-apply'`
  (`app/src/shared/channels.ts:58-59`).

A PR status update is a push, not a poll-from-the-Renderer. Reuse the
`conversationEvent` pattern with a new channel; do not make the Renderer
re-query the mailbox on a timer.

### Where credentials live today

Verified, and the answer is deliberate and load-bearing.

- **Nothing is stored.** The Claude adapter shells out to the macOS keychain at
  launch time — `/usr/bin/security find-generic-password -s
  'Claude Code-credentials' -w` — parses the JSON, and takes
  `claudeAiOauth.accessToken` (`app/src/main/harness-adapter.ts:275-284`). It
  is injected as `CLAUDE_CODE_OAUTH_TOKEN` into the child's environment at
  launch and nowhere else (`:422-427`, inside `launchEnvironment`).
- ADR 0001 assigns this ownership: *"Main Harness Adapters own credentials,
  staged homes, launch arguments and environment"*
  (`docs/adr/0001-adopt-effect-in-core.md:96-98`).
- **`safeStorage` / keytar are not in use.** `app/package.json` dependencies
  are `@base-ui/react`, `@shadcn/react`, `class-variance-authority`, `clsx`,
  `cmdk`, `effect`, `jpeg-js`, `lucide-react`, `react`, `react-dom`,
  `react-markdown`, `remark-gfm`, `tailwind-merge`, `thinking-orbs`, `zod` —
  no HTTP client, no GitHub client, no credential library. Verified by reading
  the manifest.
- Settings are a plain JSON file, not a secret store:
  `SettingsStore` writes `join(userDataDir, 'settings.json')` via
  staged-write-then-rename (`app/src/main/settings.ts:38-58`), over a zod
  schema of theme, quit warning, `dormantAfterDays`, `harnessExecutables`,
  `loginShellDiscovery`, `lastEditor` (`:11-23`). **A token must not go
  here** — it is unencrypted, and `loginShellDiscovery` shows the file's actual
  register: consent records, not secrets.
- The product promise is on screen: *"This app never installs, updates, signs
  in, or stores credentials for a Harness — repairs happen in your own
  terminal"* (`app/src/renderer/src/components/Readiness.tsx:129-130`). Note it
  says *for a Harness*. GitHub is not a Harness, so this is not literally
  violated by storing a GitHub token — but the spirit is unmistakable, and
  going against it is a decision to make out loud.

### Background/periodic work

**UNVERIFIED.** A background search for existing `setInterval` / Effect
`Schedule` / `repeat` loops in Main did not return before this was written. What
*is* verified is that a suitable substrate exists: Main runs one
Electron-lifetime Effect runtime with per-Run child Scopes
(`docs/adr/0001-adopt-effect-in-core.md:36-40`), and `effect@^3.22.1` is a
production dependency — so `Effect.repeat` with a `Schedule`, forked into a
scoped fiber, is available today with no new dependency and with guaranteed
interruption on quit. There is also a readiness-refresh channel
(`refreshReadiness: 'readiness:refresh'`,
`app/src/shared/channels.ts:36`), which is at minimum a user-triggered refresh
precedent. Confirm whether it is also periodic before claiming reuse.

---

## What GitHub gives us

All fetched from `docs.github.com` / `cli.github.com` / the octokit repo on
2026-08-07.

### Creating the PR

`POST /repos/{owner}/{repo}/pulls`. Required: `head` ("The name of the branch
where your changes are implemented"), `base` ("The name of the branch you want
the changes pulled into"), and `title` (required unless `issue` is given).
Optional: `body` ("The contents of the pull request"), `draft`,
`maintainer_can_modify`. Returns `201 Created`.
[[Pulls REST reference](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28)]

Fine-grained PAT permission: **"Pull requests" — write**.
[[Permissions for fine-grained PATs](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens?apiVersion=2022-11-28)]

`body` has no documented server-side length cap in the reference, which is why
the bounding in `boundedSessionDiff` matters on our side rather than theirs.

### Reading PR state — and the merged nuance

`GET /repos/{owner}/{repo}/pulls/{pull_number}` returns `state` (`open` or
`closed`), `merged` (boolean), `merged_at` (string or null), `draft`,
`mergeable` (boolean or null), `mergeable_state`, `html_url`, `number`.
[[Pulls REST reference](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28)]

**The nuance that will bite anyone who skips it: `state` alone cannot
distinguish merged from closed-unmerged.** `state` is only ever `open` or
`closed`, and a merged PR is `closed`. The three-way classification the mailbox
needs is therefore:

- `state === 'open'` → **open** (and `draft === true` → *draft*, worth its own
  colour)
- `state === 'closed' && merged_at !== null` → **merged**
- `state === 'closed' && merged_at === null` → **closed, unmerged**

Prefer `merged_at` over `merged`: `merged_at` is documented on the response and
is also the field carried by the *simple* PR object the list endpoint returns.
(My fetch of the list-response schema reported `merged` as present on list
items too; I am not confident in that answer and did not confirm it against the
schema itself. Treat `merged_at` as the safe field and verify `merged` before
depending on it.)

A second, cheaper option exists for the merged question alone:
`GET /repos/{owner}/{repo}/pulls/{pull_number}/merge`, which returns **204**
("Response if pull request has been merged") or **404** ("Not Found if pull
request has not been merged") with no body.
[[Pulls REST reference](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28)]
It answers *only* merged-or-not, so it cannot separate open from
closed-unmerged. Not worth a second request; use the full `GET`.

Separately, do **not** read `mergeable` on the first fetch: *"If the value is
null, then GitHub has started a background job to compute the mergeability.
After giving the job time to complete, resubmit the request."* [ibid.] This is
about *conflict* state, not merged state — it is not needed for this feature at
all, and reading it invites a retry loop for no benefit.

### Finding a PR from a branch (recovery path)

`GET /repos/{owner}/{repo}/pulls` accepts `head`, documented as: *"Filter pulls
by head user or head organization and branch name in the format of
`user:ref-name` or `organization:ref-name`. For example:
`github:new-script-format` or `octocat:test-branch`."* Also `state` (`open` /
`closed` / `all`, default `open`) and `base`. [ibid.]

Two traps, both from the quoted wording: the `user:` prefix is **mandatory**
(a bare branch name silently matches nothing), and `state` defaults to `open`
(so a merged PR is invisible unless you pass `state=all`). This endpoint is how
you re-attach a PR to a Session after the app forgets — or how you detect that
the person opened the PR themselves in the browser.

### Rate limits and conditional requests

- Unauthenticated: *"The primary rate limit for unauthenticated requests is 60
  requests per hour."*
- User-authenticated (PAT / OAuth token): *"your personal rate limit of 5,000
  requests per hour"*; Enterprise Cloud 15,000.
- GitHub App installation tokens: minimum 5,000/hour, scaling to 12,500.
- Headers: `x-ratelimit-limit`, `-remaining`, `-used`, `-reset`, `-resource`.
- Secondary limits: *"No more than 100 concurrent requests are allowed"*, *"No
  more than 900 points per minute"* for REST.
[[Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28)]

The decisive sentence for polling cadence: *"Making a conditional request does
not count against your primary rate limit if a `304` response is returned and
the request was made while correctly authorized with an `Authorization`
header."* Also: *"You should subscribe to webhook events instead of polling the
API for data"*; *"If you are making a large number of `POST`, `PATCH`, `PUT`,
or `DELETE` requests, wait at least one second between each request"*; *"To
avoid exceeding secondary rate limits, you should make requests serially
instead of concurrently"*; and on 429/403: *"If the `retry-after` response
header is present, you should not retry your request until after that many
seconds has elapsed"*, else wait for `x-ratelimit-reset`, else *"wait for at
least one minute before retrying"*. Finally: *"Continuing to make requests
while you are rate limited may result in the banning of your integration."*
[[Best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2022-11-28)]

**Why webhooks are out.** *"When an event that your webhook is subscribed to
occurs, GitHub will send an HTTP request with data about the event to the URL
that you specified"*, and *"If your server is set up to listen for webhook
deliveries at that URL, it can take action when it receives one."*
[[About webhooks](https://docs.github.com/en/webhooks/about-webhooks)] A local
Electron app has no stable public URL; providing one means running a relay
service, which is a backend this product does not have and a privacy surface it
has been careful to avoid. Polling it is — and the 304 exemption makes it
close to free.

### Auth options

**OAuth Device Flow.** Three steps: `POST https://github.com/login/device/code`
with `client_id` (required) and `scope` (optional); the user visits
`https://github.com/login/device` and types the code; the app polls
`POST https://github.com/login/oauth/access_token` with `client_id`,
`device_code`, and `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
Step-1 response: `device_code` (40 chars), `user_code` (8 chars with a hyphen),
`verification_uri`, `expires_in` (default 900 / 15 minutes), and `interval` —
*"The minimum number of seconds that must pass before you can make a new access
token request."* Errors: `authorization_pending` (keep polling), `slow_down`
(*"5 extra seconds are added to the minimum `interval`"*), `expired_token`,
`access_denied`, `incorrect_device_code`, `unsupported_grant_type`,
`incorrect_client_credentials`, `device_flow_disabled`. Device flow *"must
first be enabled in your app's settings"*.
[[Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)]

The strong point for a desktop app: **no client secret is transmitted** — the
`incorrect_client_credentials` error is documented as covering an invalid
client ID with "no client_secret needed". That matters, because an Electron
bundle cannot keep a secret.

**GitHub App vs OAuth App.** *"Installation access tokens expire after a
predefined amount of time (currently 1 hour)"* whereas *"OAuth tokens remain
active until they're revoked by the customer."* A GitHub App must be installed
first: *"You must be an organization owner or have admin permissions in a
repository to install a GitHub App on an organization."* GitHub Apps get
fine-grained permissions and scaling rate limits; OAuth apps get broad scopes
and *"the user's rate limit of 5,000 requests per hour."*
[[Differences](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)]

For this product the installation requirement is close to disqualifying: the
app is pointed at *whatever local repository the person already has*. Requiring
an org admin to install something before you can open a PR from your own laptop
is friction the app has consistently refused elsewhere.

**Fine-grained PAT.** "Pull requests: write" covers create; "Pull requests:
read" covers get and list; "Metadata: read" covers `GET /repos/{o}/{r}`;
"Contents: write" is the git-write permission.
[[Permissions for fine-grained PATs](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens?apiVersion=2022-11-28)]
Pasting a PAT is the lowest-effort path and the worst one to *ask* a user for:
it is a long-lived secret typed into a text box.

### `gh` CLI

`gh pr create` flags: `--title`, `--body`, `--body-file`, `--base`, `--head`,
`--draft`, `--fill` (*"Use commit info for title and body"*), `--fill-verbose`,
`--fill-first`, `--web`, `--repo`, `--no-maintainer-edit`, `--dry-run`, plus
`--assignee`, `--label`, `--milestone`, `--project`, `--reviewer`,
`--template`, `--editor`, `--recover`. When the current branch has no upstream
remote it **prompts for where to push** and offers to fork. On success it
**prints the PR URL**.
[[gh pr create](https://cli.github.com/manual/gh_pr_create)]

Two things make this a strong fit rather than a hack. First, `--body-file` is
exactly right for a generated description — no shell-quoting a multi-KB body.
Second, `gh` resolves `owner/repo` from the remote itself, which dissolves the
"the app has no notion of a remote" problem entirely rather than requiring the
app to solve it. The cost is the interactive prompt on an upstream-less branch:
driving `gh` non-interactively means pushing the branch yourself first
(`git push -u`), or accepting `--repo` plus an explicit `--head`.

`gh pr view --json` is the read side. **UNVERIFIED:** I did not fetch the
`gh pr view` manual page, so I cannot cite the exact JSON field names it
exposes for state/merged. Confirm before designing around it.

### Octokit

*"Octokit requires Node 18 or higher, which includes a native fetch API."*
Ships **ESM-only with conditional exports**: *"As we use conditional exports,
you will need to adapt your `tsconfig.json` by setting `"moduleResolution":
"node16", "module": "node16"`."* Auth is
`new Octokit({ auth: 'personal-access-token123' })`. It is decomposable —
`@octokit/core` is *"standalone minimal Octokit"*, `@octokit/request` does
direct REST calls — and the README says to *"make your own tradeoff between
functionality and bundle size."*
[[octokit.js](https://github.com/octokit/octokit.js)]

For Electron Main this is workable — electron-vite bundles Main and Electron 38
is on a modern Node — but the honest assessment is that **Octokit is not worth
its weight here**. This feature needs three endpoints. Node 18+ has global
`fetch`. Adding an ESM-only dependency with a `tsconfig` requirement, into a
repo whose ESLint config is strict about which tsconfig every file belongs to
(`docs/agents/code-style.md:48-51`), buys pagination and throttling plugins
this feature does not use. If an in-app client is ever built, use `fetch` and a
zod response schema — which matches the existing house style, since every
transport seam in this app is already zod (`docs/adr/0001-…:44-46`).

### Electron `safeStorage`

`isEncryptionAvailable()`, `encryptString(plainText) → Buffer`,
`decryptString(encrypted) → string`, plus Linux-only
`setUsePlainTextEncryption()` and `getSelectedStorageBackend()`. macOS uses
Keychain Access: *"Encryption keys are stored for your app in Keychain Access
in a way that prevents other applications from loading them without user
override."* Windows uses DPAPI: *"Content is protected from other users on the
same machine, but not from other apps running in the same userspace."* Linux is
the weak case: *"If no secret store is available, items stored in using the
`safeStorage` API will be unprotected as they are encrypted via hardcoded
plaintext password."* On Linux `isEncryptionAvailable()` requires the `ready`
event to have fired.
[[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)]

macOS-only shipping makes this clean. It is the correct primitive *if* a token
is ever stored — never `settings.json`.

---

## Design decisions, with a recommendation for each

### 1. How does a Session's work become commits on a pushable branch?

This is the real decision and it should be made first, because everything else
is downstream of it.

- **Worktree Sessions only, commit on the Session's own branch.**
  ✅ **Recommended for the first slice.** The branch already exists and was cut
  from a base the person chose (`app/src/main/git.ts:225-250`). Committing onto
  it touches only the app's own worktree, so ADR 0006's "never write into the
  person's repository" holds in spirit — the branch is the app's.
- **Local (primary) Checkout Sessions.** ❌ Defer. Committing here commits the
  person's uncommitted work alongside the agent's, which is precisely the
  problem ADR 0006 was written to solve (`docs/adr/0006-…:15-19`) and the
  reason it rejected pre-Run commits (`:72-73`). Offering "create PR" on a
  Local Session should say why it is unavailable, in the same register as
  "undo unavailable" for pre-snapshot Runs (`:82-84`).
- **Reconstruct a commit from the snapshot trees without touching the
  worktree.** The store holds real tree objects, so `git commit-tree` against
  the Session's `after` tree is mechanically possible. ❌ Reject for now:
  producing a commit whose tree the person cannot see in their worktree is a
  new and surprising object, and pushing it needs the objects transferred out
  of the app-owned alternate into the real repo. Elegant, and too clever for a
  first slice.

### 2. Where does the PR get created — `gh` or an in-app API client?

✅ **`gh` CLI for the first slice.** It reuses the person's existing GitHub
auth, resolves `owner/repo` from the remote, takes `--body-file`, pushes the
branch, and prints the URL
([gh pr create](https://cli.github.com/manual/gh_pr_create)). It means **zero
stored credentials**, which keeps the promise at
`app/src/renderer/src/components/Readiness.tsx:129-130` intact. The app already
drives CLIs as child processes — that is the entire Harness model
(`CONTEXT.md:68`) — and already has Readiness machinery for reporting a missing
executable (`app/src/shared/channels.ts:35-38`). `gh` becomes one more
optional, user-installed tool, repaired in the user's own terminal.

❌ **Octokit.** Rejected on weight; see above.

⚠️ **In-app `fetch` + zod.** The right answer *eventually*, if PR status becomes
a first-class thing rather than a convenience. Not first.

### 3. Auth

✅ **First slice: no auth of our own.** `gh` holds it. If a token is needed for
reads, `gh auth token` is the direct analogue of the existing
`security find-generic-password` move (`app/src/main/harness-adapter.ts:275-284`)
— read at point of use, never persisted.

✅ **If in-app auth is ever needed: OAuth Device Flow.** No client secret in the
bundle, well-specified polling with `interval` and `slow_down`
([authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)),
and the user-facing step is a browser page and an 8-character code — which the
app can already open, via `openExternalLink: 'shell:open-external-link'`
(`app/src/shared/channels.ts:40`).

❌ **GitHub App.** The installation requirement
([differences](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps))
is wrong for a tool pointed at arbitrary local repos.

❌ **Ask the user to paste a PAT.** Lowest effort, worst posture. Keep it only
as an escape hatch for GitHub Enterprise Server, if that ever matters.

**Storage, if it comes to that:** `safeStorage.encryptString` into an app-owned
file, never `settings.json`
([safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage);
`app/src/main/settings.ts:38-58`).

### 4. Polling cadence

✅ **Recommendation: conditional `GET` per tracked PR, 60s while the app is
focused, 5 minutes when unfocused, stop entirely once terminal.**

Justification, all from the docs: 5,000 requests/hour authenticated, so even
20 tracked PRs at 60s is 1,200 requests/hour before conditional requests, and
near zero after — *"a conditional request does not count against your primary
rate limit if a 304 response is returned"*
([best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2022-11-28)).
Poll **serially**, per the same page. Stop on terminal states — merged and
closed-unmerged are final, so a PR should be polled exactly until it reaches
one and then never again. Honour `retry-after` / `x-ratelimit-reset`. On any
failure, **show nothing rather than an error**: this is advisory adornment on
an inbox row, and the same reasoning applies as in
`.scratch/research/t3-code-provider-update-checks.md` — silence on failure
beats a scary unresolved warning.

⚠️ **Note the tension with the existing privacy posture.** A background poll to
`api.github.com` is a network call this app does not currently make, on a
schedule the user did not ask for. The provider-update-checks research reached
the same fork and recommended opt-in or explicit disclosure. Apply that here:
polling should begin only for Sessions where the person actually created a PR
through the app — never speculatively, and never repo-wide.

### 5. Where does PR state live?

✅ **Main owns it; a new app-owned store beside the snapshot store; the mailbox
item carries a derived summary.**

- **Not Core.** ADR 0001 gives Main credentials, external processes, and
  Checkout observation (`docs/adr/0001-…:96-98`, `:11-13`); a GitHub client is
  all three in character. Core decides durable *Conversation* facts, and a PR
  is not a Conversation fact.
- **Not `SessionStatus`.** That enum is documented as derived-not-stored
  precisely so it cannot disagree with the Conversation
  (`app/src/shared/contract.ts:119-128`). PR state is stored and remote.
- **A separate nullable field on `mailboxSessionSchema`**, modelled on
  `waitingFor` (`app/src/shared/contract.ts:135-136`) — something like
  `pullRequest: {number, url, state: 'draft'|'open'|'merged'|'closed'} | null`
  with `.default(null)` so existing rows validate.
- **Persistence:** follow `SessionSnapshotStore` exactly — per-Session
  directory, zod-validated JSON record, staged-write-then-rename, `0o600`
  (`app/src/main/snapshot-store.ts:59-61`, `:128-130`, `:149-161`), and the
  same lifetime rule: Archive retains, Delete removes (`:14-18`, `:101-103`).
  A PR reference outliving its Session would be an orphan nobody can reach,
  which is exactly the problem `pruneUnknown` (`:110-118`) exists to sweep.
- **Delivery:** push over a new one-way channel following
  `conversationEvent` (`app/src/main/index.ts:999`;
  `app/src/preload/index.ts:77-78`). Not a Renderer timer.

### 6. Who writes the description?

✅ **Prefer the Harness, via the MEM-94 tool.** The agent already has bounded
read access to the recorded Session diff
(`app/src/main/tool-host.ts:95`, `:445`, `:469`, `:538`), and the app does no
inference of its own (`CONTEXT.md:68`). Ask the Harness for a PR body as part
of a Run, or as a dedicated short Run; keep it editable before submission.

⚠️ **Mechanical fallback**, built from `SnapshotComparison`
(`app/src/main/git.ts:311-319`): file list by `changeKind`, the `unlisted`
count stated honestly, the Session title, and the person's own messages. Always
show the body in an editable field before creating — a generated description
the person cannot correct is worse than none.

❌ **`gh pr create --fill`** (*"Use commit info for title and body"*,
[gh pr create](https://cli.github.com/manual/gh_pr_create)). Only as good as the
commit message the app generated, which is circular.

---

## Open risks and unknowns

**Verified risks:**

1. **No remote, no push, no commit anywhere in the app today.** This is the
   feature. Everything about GitHub is easy; this is not. (`app/src/main/git.ts`,
   grep clean for `remote`/`push`/`origin`.)
2. **Project identity is a path, not a remote** (`CONTEXT.md:10`, ADR 0005).
   Deriving `owner/repo` is new observation with real failure modes: no remote,
   several remotes, SSH vs HTTPS, forks (where `head` must be
   `user:branch`, per the documented format), `url.insteadOf` rewrites, and
   GitHub Enterprise Server hosts that are not `github.com` at all.
3. **Local Checkout Sessions cannot be served without reopening ADR 0006's
   rejection of pre-Run commits** (`docs/adr/0006-…:72-73`). Say "unavailable
   for Local Sessions, here is why" rather than half-doing it.
4. **`state` alone cannot express "merged"** — see the three-way rule above.
   Getting this wrong shows a merged PR as plain "closed", which is the single
   most user-visible way to be wrong.
5. **`?head=` requires the `user:ref-name` prefix and defaults to
   `state=open`** — two silent-empty-result traps
   ([pulls reference](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28)).
6. **A background network call is a privacy-surface decision**, not an
   implementation detail — the same fork already documented in
   `.scratch/research/t3-code-provider-update-checks.md`.
7. **Storing a GitHub token softens a promise currently made on screen**
   (`app/src/renderer/src/components/Readiness.tsx:129-130`). `gh` avoids it
   entirely; that is most of why `gh` is recommended.
8. **Linux `safeStorage` may silently fall back to a hardcoded plaintext
   password** ([safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)).
   Moot while macOS-only; a blocker the day it is not.

**Unknowns I did not resolve:**

- Whether `sessionSummarySchema` carries a session id reachable from a mailbox
  row (almost certainly, unread).
- Whether any periodic-refresh loop already exists in Main to reuse, or whether
  a PR poller would be the first (`refreshReadiness` exists as a channel;
  whether it is also scheduled is unconfirmed).
- The exact JSON field names `gh pr view --json` exposes — the manual page was
  not fetched.
- Whether the list-PR *simple* object includes a `merged` boolean or only
  `merged_at`. Use `merged_at`.
- Whether the app has any onboarding surface where a GitHub connection would
  belong, or whether it would be a Project-level setting.
- Test posture: `pnpm verify` runs typecheck, unit, and packaged-shell
  acceptance tests (`docs/agents/code-style.md:5-9`), so anything touching the
  network needs an injected service. Effect `Context.Tag` + `Layer` is the
  documented pattern (`docs/adr/0001-…:64-66`), so this is a known cost, not a
  new one.

---

## Suggested phased path

**Phase 0 — decide, do not build.** Answer two questions in writing: does the
app commit on a Session's worktree branch (and does that need an ADR amending
0006?), and does the app ever store a GitHub credential? Everything else
follows. An ADR is probably warranted for the first, since it lives right
against ADR 0006's rejected options.

**Phase 1 — read-only groundwork.** Add remote observation to `git.ts`
alongside `currentBranch` / `listBranches`
(`app/src/main/git.ts:177`, `:199`): resolve `origin`, parse
`owner/repo`, and return a typed outcome for every failure mode — the file's
existing house style, where `WorktreeCreation` (`:225-235`) and
`CheckoutSnapshot` (`:296-299`) both name their failures rather than throwing.
No UI. This alone tells you how often the derivation actually works on real
repos.

**Phase 2 — create a PR, worktree Sessions only, `gh` only, fire-and-forget.**
Commit on the Session branch, generate a body (Harness-written, mechanically
assembled as fallback), show it editable, then `gh pr create --body-file`.
Store `{number, url}` in a per-Session store shaped like
`SessionSnapshotStore`. Show a static "PR opened" affordance linking out via
`openExternalLink` (`app/src/shared/channels.ts:40`). **No polling yet.** This
is shippable and answers the only question that matters: do people want it.

**Phase 3 — the mailbox indicator, refreshed on demand.** Add the nullable
`pullRequest` field to `mailboxSessionSchema`
(`app/src/shared/contract.ts:132-137`), a colour/label table beside
`DOT_OF_STATUS` (`app/src/renderer/src/components/Mailbox.tsx:995-1000`) with
distinct treatments for draft / open / merged / closed-unmerged, and a second
indicator element in `SessionRow` (`:1002`). Refresh when the mailbox is
queried and when the window regains focus — no timer. Read via `gh` if its JSON
is sufficient, otherwise via a token obtained from `gh auth token` at point of
use.

**Phase 4 — background polling, if Phase 3 proves it is wanted.** A scoped
Effect fiber in the Main runtime, conditional `GET` with stored ETags, 60s
focused / 5min unfocused, serial, terminal-state stop, `retry-after` honoured,
silent on failure. Push via a new one-way channel modelled on
`conversationEvent` (`app/src/main/index.ts:999`;
`app/src/preload/index.ts:77-78`). Disclose the network call.

**Phase 5 — in-app client and Device Flow, only if `gh` proves insufficient.**
`fetch` + zod, Device Flow for auth, `safeStorage` for the token. This is a
genuine product-posture change and should be decided as one, not arrived at.

**Explicitly out of scope, and worth saying so:** merging a PR from the app,
review comments, CI/checks status, PR templates, and any repository the person
does not already have push access to. Each is a plausible next feature and none
of them is this one.
