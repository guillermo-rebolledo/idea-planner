# Decide the harness adapter contract

Type: grilling
Status: open
Blocked by: 03

## Question

What stable application-level contract should normalize Codex and Claude Runs, events, Suggested Responses, skill invocation, permissions, cancellation, resumption, and errors without erasing harness-specific capabilities?

## Comments

Agreed constraints:

- Internal capability-negotiated adapter contract with Codex and Claude implementations; no public plugin API in the MVP.
- Normalize messages, activity, choices, approvals, retries, completion, failure, cancellation, session identity, token usage, and context usage. Retain sanitized raw events locally for recovery and diagnostics.
- Native structured choices first; parse only unambiguous Markdown option lists and always retain typed fallback.
- Separate conversational choices from security approvals.
- One Conversation may span multiple Harness Sessions; one Run means one user submission/AI turn.
- Provider-managed transient retries may continue visibly; terminal retry always requires user action and must avoid duplicate answers.
- Capability probes outrank exact version locks; warn on untested versions and block only failed handshakes or missing required capabilities.
- Detect harness and skill readiness before submission. Missing skills may invoke only the explicitly confirmed `npx skills@latest add mattpocock/skills` installer; npm/npx are installer-only prerequisites.
- Use T3 Code's bounded PATH-hydration pattern with explicit-path fallback and native health probes, but require one-time consent before executing login-shell startup files.
