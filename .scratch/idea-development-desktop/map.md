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
- Planning only: this map ends at the MVP specification and implementation-ready issues, not a built application.

## Decisions so far

- [Research local CLI harness capabilities](issues/03-research-local-cli-harness-capabilities.md) — Use separate Codex App Server and Claude stream-JSON/hook adapters behind stable product events, with typed-response fallbacks.
- [Research skill packaging and attribution](issues/05-research-skill-packaging-and-attribution.md) — Discover and verify external skill dependencies, pin Run provenance, fail visibly when missing, and retain MIT attribution without implying endorsement.

## Not yet specified

- Search, organization, pinning, and archive behavior across a large Idea Library.
- Recovery semantics when the app, CLI harness, or machine exits during a Run.
- The boundary between software-engineering outputs and general-purpose Idea development.
- Git integration, history, and rollback beyond the minimum needed for safe artifact acceptance.
- Extensibility beyond the initial Grill Me and Wayfinder workflows.
- Distribution, updates, and onboarding once platform and harness constraints are known.

## Out of scope

- Building the desktop application as part of this Wayfinder effort.
- Cloud collaboration, account systems, and cross-device synchronization for the MVP.
- Hosting a proprietary AI inference service; the MVP uses locally installed CLI harnesses.
- External issue-tracker publishing and synchronization; the MVP produces local Markdown only.
