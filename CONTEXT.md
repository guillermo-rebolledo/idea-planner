# Idea Development

This context describes how a person develops a loosely formed thought into a concrete, actionable outcome with optional AI assistance.

## Language

**Idea**:
The top-level container for a thought being developed, from its initial capture through its resulting specifications, requirements, and actionable issues.
_Avoid_: Effort, project

**Conversation**:
An optional AI-assisted exchange attached to an Idea. A Conversation may be pinned, settled as resolved context, or discarded from the active view while remaining recoverable.
_Avoid_: Agent session, chat

**Proposal**:
A change to an Idea's durable content suggested through a Conversation. A Proposal has no effect until the user explicitly accepts it.
_Avoid_: Automatic edit, agent action

**Artifact**:
A durable Markdown document accepted by the user from a Run, such as an MVP specification, requirements, decisions, or issue drafts. The user may edit it directly; later AI changes require approval as Proposals.
_Avoid_: File, item

**Draft Artifact**:
A read-only Markdown document created and continuously revised by an active Run. It becomes an Artifact only when the user accepts it.
_Avoid_: Artifact, Proposal

**MVP Spec**:
A user-reviewed specification synthesized from an Idea's accepted Artifacts and Conversation context. It remains open to discussion and revision until the user explicitly accepts it as the basis for implementation planning.
_Avoid_: PRD, plan

**Implementation Ticket**:
A user-approved, dependency-aware vertical slice of an accepted MVP Spec, represented as a durable Markdown document.
_Avoid_: Task, issue

**Run**:
An explicitly started AI execution within a Conversation, configured with a local harness, model, and reasoning effort. A Run may continue in the background until it completes, is paused, or is stopped.
_Avoid_: Conversation, background agent

**Suggested Response**:
A selectable answer offered by the AI during a Conversation. Selecting it submits that answer on the user's behalf, while the user may always write a custom response instead.
_Avoid_: Command, action

**Idea Library**:
The user-selected, local folder containing Ideas and their Markdown artifacts. Its contents remain visible and usable outside the application.
_Avoid_: Workspace, vault, app database
