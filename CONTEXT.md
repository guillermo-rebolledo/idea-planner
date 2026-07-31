# Idea Development

This context describes how a person develops a loosely formed thought into a concrete, actionable outcome with optional AI assistance.

## Language

**Idea**:
The top-level container for a thought being developed, from its initial capture through its resulting specifications, requirements, and actionable issues.
_Avoid_: Effort, project

**Conversation**:
A permanent, user-visible history belonging to one Idea. It spans every planning phase and contains the Idea's user messages, AI responses, and Run boundaries.
_Avoid_: Agent session, chat

**Proposal**:
A change to an Idea's durable content suggested through a Conversation. A Proposal has no effect until the user explicitly accepts it.
_Avoid_: Automatic edit, agent action

**Artifact**:
A durable Markdown document promoted from a Draft Artifact when the user accepts the Planning Package. The user may edit it directly; later AI changes require approval as Proposals.
_Avoid_: File, item

**Draft Artifact**:
A Markdown document created and revised during planning. It remains read-only inside the application until the user accepts the complete Planning Package.
_Avoid_: Artifact, Proposal

**MVP Spec**:
A user-reviewed specification synthesized from an Idea's accepted Artifacts and Conversation context. It remains open to discussion and revision until the user explicitly accepts it as the basis for implementation planning.
_Avoid_: PRD, plan

**Implementation Ticket**:
A user-approved, dependency-aware vertical slice of an accepted MVP Spec, represented as a durable Markdown document.
_Avoid_: Task, issue

**Run**:
One user submission followed by AI work until the application is waiting for the user, completes, fails, or is stopped. A Run is configured with a harness, model, and reasoning effort.
_Avoid_: Conversation, Harness Session

**Harness Session**:
The provider-specific continuity record behind a Conversation, such as a Codex thread or Claude session. A Conversation may cross Harness Sessions when the user switches harnesses.
_Avoid_: Conversation, Run

**Suggested Response**:
A selectable answer offered by the AI during a Conversation. Selecting it submits that answer on the user's behalf, while the user may always write a custom response instead.
_Avoid_: Command, action

**Idea Library**:
The user-selected, local folder containing Ideas and their Markdown artifacts. Its contents remain visible and usable outside the application.
_Avoid_: Workspace, vault, app database

**Working Directory**:
The user-approved local directory containing an Idea's root Markdown file and managed planning files. It may be a folder in the Idea Library or an attached existing project.
_Avoid_: Idea Library, repository

**Planning Package**:
The complete set of planning Markdown accepted when an Idea becomes Ready, including its Conversation transcript and, for a Software Idea, its MVP Spec and Implementation Tickets.
_Avoid_: Export, deliverable

**Software Idea**:
An Idea intended to produce an MVP Spec and Implementation Tickets.
_Avoid_: Project

**General Idea**:
An Idea that may use Grill Me or Wayfinder but does not require an engineering spec or Implementation Tickets to become Ready.
_Avoid_: Note
