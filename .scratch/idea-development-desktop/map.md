Label: wayfinder:map

# Define the conversation-first Idea development desktop MVP

## Destination

A decision-complete MVP product specification that another agent can implement without inventing product behavior, domain language, architecture boundaries, or acceptance criteria for a local-first desktop app that develops Ideas into specifications, requirements, and actionable issues.

## Notes

- Use `/grill-me`, `/grilling`, `/wayfinder`, and `/domain-modeling` throughout this effort.
- Use Matt Pocock's installed skills as the behavioral baseline and attribute the methodology to Matt Pocock in the product.
- The Idea Library is local-first and user-visible, with Markdown as the durable content format.
- The main UI is conversation-first: a collapsible Idea inbox on the left, the Conversation in the center, and read-only Draft Artifacts in a collapsible right sidebar.
- AI starts only through an explicit user submission or action. A Run uses a user-selected installed harness, model, and reasoning effort.
- An active Run may revise its read-only Draft Artifacts. Once accepted, Artifacts become user-editable and later AI changes require approval.
- Suggested Responses must be selectable in the UI, with custom text always available.
- After the user accepts the exploratory Artifacts, `/to-spec` synthesizes a reviewable MVP Spec. The user may discuss and iterate on it until explicitly accepting it.
- After the user accepts the MVP Spec, `/to-tickets` drafts dependency-aware Implementation Tickets. The user reviews the breakdown and blocking edges before publishing.
- The MVP has no external issue-tracker integration. Specs and Implementation Tickets are local Markdown.
- Software Ideas use Captured → Developing → Spec Review → Ticket Review → Ready; General Ideas use Captured → Developing → Ready.
- The MVP is an Electron macOS app distributed outside the App Store as signed/notarized builds with automatic updates from GitHub Releases.
- The app enforces a planning-only sandbox: no source edits, no Git mutations beyond explicit `git init`, no secret reads, and no writes outside managed planning files—even in provider Auto/YOLO modes.
- Planning only: this map ends at the MVP specification and implementation-ready issues, not a built application.

## Decisions so far

- [Research local CLI harness capabilities](issues/03-research-local-cli-harness-capabilities.md) — Use separate Codex App Server and Claude stream-JSON/hook adapters behind stable product events, with typed-response fallbacks.
- [Research skill packaging and attribution](issues/05-research-skill-packaging-and-attribution.md) — Discover and verify external skill dependencies, pin Run provenance, fail visibly when missing, and retain MIT attribution without implying endorsement.
- [Define the Conversation and Artifact lifecycle](issues/01-define-conversation-and-artifact-lifecycle.md) — Persist before AI, keep one permanent Conversation, advance through explicit phase gates, and promote one final Planning Package at Ready.
- [Research T3 Code executable discovery](issues/10-research-t3-code-executable-discovery.md) — Use bounded PATH hydration and native probes without filesystem scans, with consent before executing login-shell startup files.

## Not yet specified

- Product naming and visual identity after the interaction prototype establishes the product's character.

## Out of scope

- Building the desktop application as part of this Wayfinder effort.
- Cloud collaboration, account systems, and cross-device synchronization for the MVP.
- Hosting a proprietary AI inference service; the MVP uses locally installed CLI harnesses.
- External issue-tracker publishing and synchronization; the MVP produces local Markdown only.
- Running `/implement` inside the app; Ready provides an informational handoff to the user's external TUI or GUI.
- Public adapter plugins and third-party harnesses beyond Codex and Claude.
- Windows, Linux, Mac App Store, multi-window, accounts, cloud sync, and collaboration.
- Token budgets, provider-quota estimates, automatic Git commits, and automatic implementation.
