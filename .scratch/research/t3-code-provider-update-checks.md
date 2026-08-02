# T3 Code provider update checks

Research date: 2026-08-01  
Source snapshot: official [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) repository at commit [`0ad91b6e7fc1fcb6d5f4bc736d84c337e912bc62`](https://github.com/pingdotgg/t3code/tree/0ad91b6e7fc1fcb6d5f4bc736d84c337e912bc62)

Companion research: [T3 Code executable discovery and launch](t3-code-executable-discovery.md), which covers how the same product *finds* a provider. This note covers what it does once a provider is found and its version is known.

## Executive summary

T3 Code answers one question the readiness work in this product does not yet ask: **is the provider the user already has older than the one they could have?**

1. It asks the npm registry for the provider package's `latest` version and compares it to the version the provider reported about itself.
2. A newer published version produces an advisory on the provider snapshot, never a failure. The provider stays usable.
3. It infers *which package manager installed this provider* from the already-resolved absolute command path, and offers that manager's upgrade command — Homebrew, npm, pnpm, Bun, or Vite Plus — rather than assuming npm.
4. Updating is always an explicit user action. Nothing is installed automatically, and after the command runs it re-probes and admits when the version did not actually change.
5. Registry failure, being offline, and rate limiting all degrade to "unknown", which renders as nothing at all.
6. Separately from advisories, minimum versions are enforced per provider, and the two enforcement styles differ meaningfully: one provider is blocked outright, another hides individual models.

The interesting result for us is not the registry lookup. It is that their own bug history shows the value sits in **keeping "too old", "not signed in", and "not installed" as distinct states with different fixes** — which is the part this product already models, and the part worth protecting.

## How the advisory is produced

### 1. Ask npm, cache hard, fail quiet

`fetchNpmLatestVersion` issues a single `GET https://registry.npmjs.org/<package>/latest` with an `accept: application/json` header, wrapped in a 4-second timeout (`LATEST_VERSION_TIMEOUT_MS`). A timeout, a non-2xx status, or a payload that fails schema decoding all resolve to `null` rather than an error. [Source: `providerMaintenance.ts`](https://github.com/pingdotgg/t3code/blob/0ad91b6e7fc1fcb6d5f4bc736d84c337e912bc62/apps/server/src/provider/providerMaintenance.ts)

`resolveLatestProviderVersion` memoizes the answer per package name in a `ProviderVersionCache` for `LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000` — one hour. A `null` is cached on the same terms, so an offline or rate-limited machine makes one request per hour rather than one per provider snapshot.

### 2. Compare, and only ever downgrade to advice

`deriveVersionAdvisory` returns `behind_latest` only when `compareSemverVersions(current, latest) < 0`. A missing current version or a missing latest version returns `unknown` with no message. The message for a behind provider is a single constant: `"Install the update now or review provider settings."`

The advisory attached to the provider snapshot carries `status`, `currentVersion`, `latestVersion`, `updateCommand`, `canUpdate`, `checkedAt`, and `message`. `enrichProviderSnapshotWithVersionAdvisory` only performs the lookup when the check is enabled and the provider is enabled, installed, and has reported a version:

```ts
const shouldResolveLatestVersion =
  options?.enableProviderUpdateChecks !== false &&
  snapshot.enabled &&
  snapshot.installed &&
  Boolean(snapshot.version);
```

Every driver's snapshot pipeline calls it (`Drivers/CodexDriver.ts`, `ClaudeDriver.ts`, `CursorDriver.ts`, `GrokDriver.ts`, `OpenCodeDriver.ts`). A failed version check never affects provider availability.

### 3. Infer the installer from the resolved path

This is the part worth borrowing. T3 Code has already resolved the command to an absolute path in order to launch it, so it reuses that path to classify how the provider was installed, and offers the matching upgrade command:

| Detected in the resolved path                                                | Offered update command             |
| ---------------------------------------------------------------------------- | ---------------------------------- |
| `/opt/homebrew/cellar/`, `/usr/local/cellar/`, `/opt/homebrew/bin/`, `/usr/local/bin/` | `brew upgrade <formula>`           |
| `/.bun/bin/`                                                                   | `bun i -g <pkg>@latest`            |
| `/.local/share/pnpm/`, `/library/pnpm/`, `/appdata/local/pnpm/`, `/pnpm/global/` | `pnpm add -g <pkg>@latest`         |
| `/.vite-plus/bin/`                                                             | `vp i -g <pkg>`                    |
| `/node_modules/.bin/`, `/lib/node_modules/`, `/npm/node_modules/`              | `npm install -g <pkg>@latest`      |
| a provider-specific native updater, when the definition supplies one           | that provider's own update command |
| anything else                                                                  | none — advisory only, no button    |

Both the resolved path and its `realpath` are classified, so a symlinked shim still matches. A bare command name with no path separator defaults to npm. An unrecognized absolute path degrades to `makeManualOnlyProviderMaintenanceCapabilities` — the user is told an update exists but is not offered a command that would silently do nothing.

### 4. Updating is explicit, serialized, and honest about failure

The update runs only from a click. `providerMaintenanceRunner.ts` spawns the classified executable with a `UPDATE_TIMEOUT_MS = 5 * 60_000` timeout and captures output up to `UPDATE_OUTPUT_MAX_BYTES = 10_000` — captured, not streamed. A `lockKey` (`"npm-global"`, `"homebrew"`, and so on) serializes updates that share a package manager, so two providers installed the same way cannot race.

Afterwards it re-probes the provider. If the version is still behind, the result is `status: "unchanged"` with `"Update command completed, but T3 Code still detects an outdated provider version."` A failed post-update verification is logged as a warning and falls back to the unverified snapshot.

Toast dismissals persist in the browser under `t3code:provider-update-dismissals:v1`, so an advisory the user has waved away does not return every launch.

## Minimum versions: two different enforcement styles

Advisories are separate from compatibility floors, and T3 Code deliberately treats providers differently.

**OpenCode is blocked.** `MINIMUM_OPENCODE_VERSION = "1.14.19"`; below it the snapshot is an error state with `"OpenCode v${version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer."` An unparseable version is also an error.

**Claude gates features, not the provider.** Individual model options carry their own floors — `MINIMUM_CLAUDE_OPUS_5_VERSION = "2.1.219"`, `MINIMUM_CLAUDE_FABLE_5_VERSION = "2.1.169"`, and older ones besides — and a too-old CLI simply hides those models with an explanation naming the version required. The provider stays fully usable for everything else.

**Codex, Cursor, and Grok have no floor at all** — advisory only.

## Why they built it

The stated rationale is thinner than the implementation suggests. There is no explanation in `docs/` or the README. The originating pull request (#2312) frames it purely as user experience: users should see that an update exists, trigger it from the UI, and see progress and result state. It does not mention protocol drift.

The follow-up history is more informative, and reads as consequences rather than intentions:

- **Issue #3550** — an update reported success while the provider stayed outdated. This is what motivated the install-path classification; the app had been offering `npm install -g` to people who installed via Homebrew.
- **Issue #3806** — the clearest statement of the real problem: *"the UI conflates 'your CLI is too old' with 'you're logged out,' which have opposite fixes."*
- **PR #3130** — added an opt-out because *"Some users install providers through external package managers such as Nix/nixpkgs, where npm latest is not the source of truth. In that case T3 Code should not run the provider update checker at all."*

So the durable lesson is not "check npm". It is that a provider can be unusable for several unrelated reasons, and collapsing them into one message sends the user to the wrong fix.

## Friction analysis

The product goal this note was written against is minimising friction when a person uses the AI features. Judged against that goal, T3 Code's design has clear wins and one clear cost.

### What removes friction

- **Advisory never blocks.** A behind-latest provider keeps working. The user chooses when to deal with it.
- **The offered command matches how they actually installed it.** Being handed `npm install -g` for a Homebrew install is worse than being handed nothing, because it appears to work.
- **Silence on failure.** No registry, no network, rate limited — the user sees nothing rather than a scary unresolved warning.
- **Dismissal sticks.** The advisory does not re-nag every launch.
- **Honest post-update state.** "Completed, but still outdated" is more useful than a success message that contradicts what the user can see.
- **Per-feature gating over whole-provider blocking.** Claude's approach — hide the models that need a newer CLI, keep everything else working — costs the user nothing when they do not want those models.

### What adds friction

- **On by default.** Every enabled provider triggers a registry request. PR #3130 exists precisely because that assumption is wrong for some users' install method.
- **Hard floors.** OpenCode's block is the highest-friction choice in the codebase: a user with a working CLI is refused entirely. It is justified only when the app genuinely cannot function, which is a judgement that should be revisited as the floor ages.

### Where this product's friction actually is

Observed while implementing and manually testing the Grill Me slice (MEM-61), the largest friction sources were **not** version staleness:

1. **Guessing a model name.** Defaulting the model to a specific identifier failed outright on a ChatGPT-plan account that is not entitled to it, and the failure surfaced as an uninformative Run failure. Resolved by defaulting to the provider's own configured model and passing `--model` only when the person names one.
2. **A provider that cannot start.** The sandbox denied execution of a symlinked, interpreter-based CLI. Nothing about this is a readiness problem — readiness reported the provider ready — so no amount of version checking would have caught it. Resolved by resolving the launch closure the way the loader does.
3. **Failure text with no content.** "Provider process failed" told the user nothing while the real explanation sat one layer down in the provider's own diagnostics. Resolved by promoting the provider's last diagnostic line into the failure message.

All three are the same class of problem T3 Code hit in issue #3806: a single opaque state standing in for several distinct causes with different fixes.

## Implications for this product

Take:

- **Classify the install layout from the already-resolved executable path**, and only offer a remediation command that matches it. This product already resolves an absolute path for every provider and already shows a copyable command for missing skills; the same discipline should apply to any update guidance. Offer nothing rather than something wrong.
- **Keep an advisory advisory.** Newer-version-available must never disable a provider or block a Run.
- **Prefer feature gating to provider blocking** when a version floor is eventually needed — hide what genuinely requires a newer CLI, keep the rest working.
- **Make a failed check invisible**, and cache the failure so an offline machine is not repeatedly delayed.

Leave, or decide deliberately:

- **On-by-default registry lookups.** `registry.npmjs.org` is a network call this app does not currently make. The accepted Spec is explicit that analytics are off by default, that there are no automatic uploads, and that the app never installs or upgrades providers. A silent hourly request to a third party is a privacy-surface decision, not an implementation detail: it should be opt-in or, at minimum, disclosed in onboarding alongside the other privacy choices. T3 Code shipped it on-by-default and then had to add an opt-out.
- **Running the update command.** T3 Code executes `brew upgrade` and `npm install -g` on the user's behalf. This product's Spec states it never installs, upgrades, authenticates, or stores credentials for providers or skills, and shows the exact command for the user to run themselves. Adopting one-click updates would reverse an accepted decision and should be raised as such rather than absorbed into a readiness change.

Open question worth its own decision:

- **Protocol drift is the real version risk here, and an advisory does not address it.** The Codex adapter in this product is written against the thread/turn/item protocol emitted by codex-cli 0.146.0; an earlier envelope format is not understood, and a future format may not be either. Claude's per-feature floors are the closest working pattern: name the version a capability needs and degrade that capability with an explanation, rather than failing the Run with unreadable output. This should be decided alongside the harness Adapter contract, not bolted onto readiness.
