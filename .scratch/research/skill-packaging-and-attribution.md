# Skill packaging and attribution research

Research date: 2026-07-30

Upstream snapshot verified: [`mattpocock/skills@2ab9580`](https://github.com/mattpocock/skills/tree/2ab958093e83e0ec752e6c1c5932da465bf23e0c)

## Question

What technical, availability, licensing, and attribution constraints govern using the installed Grill Me and Wayfinder skills as product workflows, and what must the app do when those skills are missing or differ between Codex and Claude environments?

## Conclusion

The desktop app can use Matt Pocock's skills with both Codex and Claude Code, but it should treat them as **external, discoverable workflow dependencies**, not as commands with one universal spelling or as APIs with a stable output schema.

For the MVP:

1. Detect the selected harness and its installed skills before starting a Run.
2. Resolve a logical workflow name such as `grill-me` or `wayfinder` to that harness's actual skill identity and invocation mechanism.
3. Check the entire dependency closure, not only the entry skill.
4. Record the skill source, version or commit, path, and content hash on every Run.
5. Never install, update, or substitute a workflow without explicit user approval.
6. If the app ships or embeds any upstream skill text, include Matt Pocock's MIT copyright and permission notice in the distributed product. Visible product credit is recommended, but should not imply endorsement.

This is a product and engineering interpretation of the cited sources, not legal advice.

## What is technically available

### Installed snapshot on the research machine

Both harness CLIs are installed:

| Harness | Executable | Observed version |
| --- | --- | --- |
| Codex | `/opt/homebrew/bin/codex` | `codex-cli 0.146.0` |
| Claude Code | `/Users/guillermoortizrebolledo/.local/bin/claude` | `2.1.220` |

The relevant skills are installed as standalone folders under `~/.agents/skills`: `grill-me`, `grilling`, `wayfinder`, `domain-modeling`, `setup-matt-pocock-skills`, `research`, and `prototype`. Their `SKILL.md` SHA-256 hashes exactly matched the files at upstream commit [`2ab9580`](https://github.com/mattpocock/skills/tree/2ab958093e83e0ec752e6c1c5932da465bf23e0c) on 2026-07-30. This proves the inspected local snapshot matches that commit; it does not guarantee other users have the same snapshot.

No Matt Pocock Claude Code plugin installation was found on this machine. Therefore, local availability in one harness must not be inferred from availability in the other.

### The workflows are instruction packages, not deterministic programs

`grill-me` is a seven-line user-invoked wrapper whose only behavior is to run the separate `grilling` skill. `grilling` asks one question at a time, waits for the user's answer, provides a recommendation, investigates discoverable facts itself, and refuses to act until shared understanding is confirmed. See the upstream [`grill-me`](https://github.com/mattpocock/skills/blob/2ab958093e83e0ec752e6c1c5932da465bf23e0c/skills/productivity/grill-me/SKILL.md) and [`grilling`](https://github.com/mattpocock/skills/blob/2ab958093e83e0ec752e6c1c5932da465bf23e0c/skills/productivity/grilling/SKILL.md) sources.

`wayfinder` is also user-invoked. It orchestrates a persistent issue-tracker map and can invoke `grilling`, `domain-modeling`, `research`, and `prototype`; it expects repository-specific tracker setup and explicitly falls back to local Markdown only when no tracker configuration exists. Its research tickets are delegated to background agents, while grilling and prototype tickets are human-in-the-loop. See the upstream [`wayfinder`](https://github.com/mattpocock/skills/blob/2ab958093e83e0ec752e6c1c5932da465bf23e0c/skills/engineering/wayfinder/SKILL.md), [`setup-matt-pocock-skills`](https://github.com/mattpocock/skills/blob/2ab958093e83e0ec752e6c1c5932da465bf23e0c/skills/engineering/setup-matt-pocock-skills/SKILL.md), [`domain-modeling`](https://github.com/mattpocock/skills/blob/2ab958093e83e0ec752e6c1c5932da465bf23e0c/skills/engineering/domain-modeling/SKILL.md), [`research`](https://github.com/mattpocock/skills/blob/2ab958093e83e0ec752e6c1c5932da465bf23e0c/skills/engineering/research/SKILL.md), and [`prototype`](https://github.com/mattpocock/skills/blob/2ab958093e83e0ec752e6c1c5932da465bf23e0c/skills/engineering/prototype/SKILL.md) sources.

Consequences for the app:

- A Run must remain interactive even if its process continues in the background. "Background" means the CLI stays alive and the user may navigate elsewhere, not that the skill can answer human-in-the-loop questions itself.
- Suggested answers are model output, not a declared machine-readable protocol. The UI may parse conservative option patterns into buttons, but must always preserve the original assistant text and offer a free-form reply.
- Wayfinder readiness includes a writable Idea workspace, an initialized repository where required by the selected tracker, tracker configuration, and every skill/tool needed by the current ticket type.
- The app must observe actual files and tracker artifacts rather than assume a fixed list of generated Markdown filenames.

## Installation and distribution assumptions

Matt Pocock's upstream README describes two supported distribution modes:

- Claude Code's native plugin is a managed, read-only bundle that updates with releases.
- `npx skills@latest add mattpocock/skills` copies editable skill files for Codex and other agents; copied files update only when the user explicitly runs `npx skills update`.

The README warns against installing both modes because that duplicates every skill. It also requires `setup-matt-pocock-skills` once per repository before the engineering workflows. See the upstream [installation instructions](https://github.com/mattpocock/skills/blob/2ab958093e83e0ec752e6c1c5932da465bf23e0c/README.md#installation-30-second-setup).

The upstream architecture decision confirms that the native Claude Code plugin ships the promoted skills, while a native Codex plugin was deferred because the two plugin manifest formats could not express the same curated bucket layout. `skills.sh` remains the upstream project's universal Codex/other-harness route. See [“Ship the skill set as a native Claude Code plugin; defer a native Codex plugin”](https://github.com/mattpocock/skills/blob/2ab958093e83e0ec752e6c1c5932da465bf23e0c/.agents/adr/0002-ship-as-a-claude-code-plugin.md).

The Claude plugin manifest includes both entry workflows and their supporting skills and declares the author as Matt Pocock and the license as MIT. See [`.claude-plugin/plugin.json`](https://github.com/mattpocock/skills/blob/2ab958093e83e0ec752e6c1c5932da465bf23e0c/.claude-plugin/plugin.json).

## Cross-harness compatibility

The shared base is real but limited. The open Agent Skills specification defines a skill as a directory containing `SKILL.md`, with required `name` and `description` fields and optional `license`, `compatibility`, resources, and scripts. It also warns that some fields have implementation-dependent support. See the [Agent Skills specification](https://agentskills.io/specification).

The inspected Matt Pocock `SKILL.md` files use the portable directory/frontmatter/body shape, and upstream says the skills “work with any model.” However, the invocation and packaging surfaces differ:

| Concern | Codex | Claude Code |
| --- | --- | --- |
| Standalone discovery | Scans `.agents/skills` from CWD to repo root plus `~/.agents/skills`; supports local enable/disable configuration | Uses personal `~/.claude/skills`, project `.claude/skills`, enterprise skills, or installed plugins |
| Explicit invocation | `$skill-name` in CLI/IDE; app-server can inject a typed `skill` input with exact path | `/skill-name` for standalone skills |
| Plugin identity | Upstream native plugin deferred at the inspected commit | Plugin skills are namespaced, for example `/mattpocock-skills:wayfinder` |
| User-only invocation | `agents/openai.yaml` can set `policy.allow_implicit_invocation: false` | `disable-model-invocation: true` in `SKILL.md` prevents automatic invocation |
| Programmatic inventory | Codex app-server exposes `skills/list`, `skills/changed`, and `skills/extraRoots/set` | Claude exposes `/skills` and plugin management/discovery; filesystem/plugin metadata remains harness-specific |

Codex's current documentation covers its discovery locations, `$` invocation, and optional `agents/openai.yaml` policy metadata in [Build skills](https://developers.openai.com/codex/skills). Its first-party app-server protocol additionally provides typed skill invocation and inventory/change notifications; see the [Codex app-server Skills section](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#skills).

Claude Code's documentation covers personal, project, enterprise, and plugin skill locations; `disable-model-invocation`; and plugin namespacing in [Extend Claude with skills](https://code.claude.com/docs/en/slash-commands) and [Create plugins](https://code.claude.com/docs/en/plugins).

Therefore the product should expose one stable domain command (`Start Grilling`, `Start Wayfinding`) behind a harness adapter. It should not send the literal string `/wayfinder` to every CLI.

### Compatibility contract the app should own

For each supported harness version, the adapter should:

1. Locate the CLI and report its version.
2. Inventory skills using the harness's native interface where practical, with documented filesystem discovery as a fallback.
3. Resolve standalone and namespaced plugin identities.
4. Validate required entry and dependency skills.
5. Invoke the exact discovered skill rather than relying on implicit model selection.
6. Capture raw events/output and translate only stable harness events into the app's Conversation/Run model.
7. Treat unrecognized output as ordinary assistant Markdown, never as a reason to invent a user choice.

The app should test against a compatibility matrix of pinned CLI versions and pinned skill snapshots. “Agent Skills compatible” alone is insufficient because the workflows also assume harness tools, subagents, repository instructions, and an issue tracker.

## Licensing, attribution, and modification

The repository is licensed under MIT with copyright © 2026 Matt Pocock. The license expressly permits use, copying, modification, merging, publication, distribution, sublicensing, and sale. Its condition is that the copyright notice and permission notice be included in all copies or substantial portions. It also disclaims warranties and liability. See the upstream [`LICENSE`](https://github.com/mattpocock/skills/blob/2ab958093e83e0ec752e6c1c5932da465bf23e0c/LICENSE).

Practical product rules:

- **Invoking a user's existing installation:** the app is not itself distributing that copy merely by discovering and invoking it. Still show provenance in the Run details so users know which workflow drove the session.
- **Bundling, caching, vendoring, or embedding original/adapted skill text:** ship the complete MIT notice in the app's third-party notices and with any separately distributed skill bundle.
- **Modifying the skills:** permitted by MIT. Mark the workflow as modified, retain the notice, give it a distinct app-owned version/hash, and do not label the modified behavior as the unqualified upstream workflow.
- **Visible attribution:** use wording such as “Workflow based on Matt Pocock's Grill Me and Wayfinder skills,” link to the repository, and separately identify the executing harness/model. MIT requires the notice in distributed copies, not a permanent UI badge; visible credit is a product transparency choice.
- **No implied endorsement:** present the app as independent and avoid “official,” “by Matt Pocock,” or branding that suggests sponsorship unless separately authorized. This is a conservative product recommendation, not a conclusion supplied by the MIT license.

For reproducibility, a Run provenance record should include:

```text
workflow_name
workflow_source (standalone path | plugin id)
upstream_repository
upstream_commit_or_release, when known
skill_content_hashes
harness_name
harness_version
model
effort
started_at
```

## Missing, duplicated, changed, or incompatible skills

The failure behavior should be explicit and recoverable:

| State | Required app behavior |
| --- | --- |
| CLI missing | Disable Start for that harness; offer to switch harness or open first-party installation guidance |
| CLI present but unauthenticated/unusable | Preserve the Idea; show the harness's error and a retry action |
| Entry skill missing | Do not silently emulate it; offer explicit install guidance, switch harness, or save/open the Idea without AI |
| Dependency missing | Name the exact missing dependency and block only the affected workflow |
| Duplicate standalone/plugin skills | Show each source and resolved invocation name; require a one-time user choice, rememberable per harness |
| Installed content differs from known upstream | Label it “modified” or “unknown version”; show path/hash and continue only after the user chooses that source |
| Known incompatible version | Block that source with the tested compatibility reason; allow another source/harness |
| Skill changes during a Run | Keep the Run pinned to its starting snapshot where technically possible; otherwise pause and ask whether to restart |
| Wayfinder repo/tracker setup missing | Explain the missing precondition and ask before running setup; never mutate repository configuration merely because the user opened an Idea |
| Option parsing fails | Render the assistant response as Markdown and retain the custom response composer |

Automatic installation is inappropriate for the MVP: it changes the user's agent configuration, may introduce duplicate skill identities, and may update independently managed files. Installation or setup should be a separate, explicit user action with the exact command/source previewed.

## Recommended MVP boundary

The safest small boundary is:

- Support **installed standalone skills** for Codex.
- Support either **installed standalone skills or the official Matt Pocock plugin** for Claude Code.
- Do not redistribute the skills in the first release.
- Detect and display provenance, pin the Run to an observed path/hash, and retain raw output.
- Credit the methodology in the workflow picker and include a repository link.
- Keep a third-party notices mechanism ready before any later decision to vendor or embed upstream content.

This boundary preserves the user's existing CLI authentication and skill installation, avoids silently becoming a skill distributor, and leaves bundling as a later explicit licensing and update-policy decision.

## Primary sources

- [Matt Pocock skills README and installation model](https://github.com/mattpocock/skills/blob/2ab958093e83e0ec752e6c1c5932da465bf23e0c/README.md)
- [Matt Pocock skills MIT license](https://github.com/mattpocock/skills/blob/2ab958093e83e0ec752e6c1c5932da465bf23e0c/LICENSE)
- [Upstream Claude-plugin/Codex distribution decision](https://github.com/mattpocock/skills/blob/2ab958093e83e0ec752e6c1c5932da465bf23e0c/.agents/adr/0002-ship-as-a-claude-code-plugin.md)
- [Upstream Claude plugin manifest](https://github.com/mattpocock/skills/blob/2ab958093e83e0ec752e6c1c5932da465bf23e0c/.claude-plugin/plugin.json)
- [Grill Me source](https://github.com/mattpocock/skills/blob/2ab958093e83e0ec752e6c1c5932da465bf23e0c/skills/productivity/grill-me/SKILL.md)
- [Grilling source](https://github.com/mattpocock/skills/blob/2ab958093e83e0ec752e6c1c5932da465bf23e0c/skills/productivity/grilling/SKILL.md)
- [Wayfinder source](https://github.com/mattpocock/skills/blob/2ab958093e83e0ec752e6c1c5932da465bf23e0c/skills/engineering/wayfinder/SKILL.md)
- [Open Agent Skills specification](https://agentskills.io/specification)
- [Codex skill documentation](https://developers.openai.com/codex/skills)
- [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#skills)
- [Claude Code skill documentation](https://code.claude.com/docs/en/slash-commands)
- [Claude Code plugin documentation](https://code.claude.com/docs/en/plugins)
