# 10b — Codex approvals and Standing Approvals

**What to build:** Ask mode on Codex. The agent stops to ask before it edits or runs anything, the request appears in the Conversation and resolves exactly as Claude's does from the person's point of view, and "always allow" grants a Standing Approval that persists for the Project.

10a laid the transport this needs: the app-server protocol carries a full approval round-trip as server-initiated requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`), answered with a JSON-RPC response the app already knows how to write.

## What is different from Claude

**The request arrives in-band.** Claude's approvals arrive out-of-band, on the app's own MCP socket, because its prompt tool is an MCP tool. Codex's arrive as JSON-RPC requests on the same stream as everything else, and are answered by writing a response frame. The Conversation-facing behaviour is identical; what answers a request is not, so that seam needs an owner rather than a second copy of `resolveApproval`.

**Codex proposes the rule itself.** A command approval carries `proposedExecpolicyAmendment`, the prefix Codex computed, and the decision `acceptWithExecpolicyAmendment` applies it. The app should use what Codex proposes rather than synthesising a prefix as it must for Claude — ticket 08 built that synthesis because Claude offers nothing, and this is the case where the Harness does. `StandingApproval` already records which Harness's syntax a rule is written in, so the two cannot be handed to the wrong one.

**Standing Approvals are execpolicy rules.** `prefix_rule(pattern=[...], decision="allow")` in a `rules/` file inside the staged `CODEX_HOME`, validated with `codex execpolicy check` before it is written. Codex splits compound shell commands with tree-sitter, so allowing one command cannot smuggle another — the hazard ticket 08 had to constrain by hand for Claude.

**Repo-wide edits are not a rule.** There is no reliable file-edit equivalent; `grantRoot` is marked `[UNSTABLE]` in the installed schema. The honest expression is `workspace-write` with the repository as the writable root, which is what Ask already uses.

**Blocked by:** 10a

**Status:** done

- [x] Ask maps to `untrusted` with `workspace-write`, and Codex Runs stop being refused in Ask
- [x] Approval requests surface in the Conversation and resolve identically to Claude from the user's point of view
- [x] Standing Approvals use the rule proposed in the approval request rather than one the app synthesises
- [x] A granted rule is written as execpolicy into the staged Codex home, validated before use, and never into the user's own configuration
- [x] `serverRequest/resolved` dismisses a request the Harness has stopped waiting on
- [x] Stopping a Run interrupts the turn rather than only killing the process
- [x] `pnpm verify` passes

## Answer — the tool-disabling condition 10a set

10a asked this ticket to verify, before Ask shipped, whether `thread/start.config` could restore the `--disable browser_use …` set that `codex exec` took on the command line.

**It cannot be verified, and that is the finding.** Measured on 0.146.0: `config: {features: {browser_use: false, …}}` is accepted by `thread/start` — and so is `config: {this_key_does_not_exist_xyz: {...}}`. The field is `additionalProperties: true`, unknown keys are swallowed, and acceptance says nothing about whether a key was applied. Proving the tools are actually off would take observing Codex decline to use one, which is a model-behaviour test, not a protocol one.

So Ask ships with the widening rather than with a claim the app cannot support: Codex's own browser use, computer use, hooks, and plugins are reachable, approval gates commands and out-of-workspace writes, and the composer says so. Recorded in `docs/harness-permission-mapping.md` under per-Run configuration injection.

## Answer — what Ask on Codex actually asks about

Unverified, and said that way in the UI. The documentation describes `untrusted` + `workspace-write` as asking before untrusted *commands* while permitting in-workspace edits, and the research file lists this exact combination as not directly tested. The composer therefore says Codex stops for commands and that whether it also stops for edits depends on the version, rather than promising behaviour nobody here has observed.
