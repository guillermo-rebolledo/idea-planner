# Prototype the conversation-first workspace

Type: prototype
Status: open
Blocked by: 01, 07, 09

## Question

What three-pane desktop interaction design makes the Idea inbox, question-and-answer Conversation, Suggested Responses, live Run status, evolving Markdown Draft Artifacts, MVP Spec review, and Implementation Ticket review understandable without making the product feel like an autonomous agent?

## Comments

Agreed constraints to validate in the prototype:

- Collapsible Idea inbox left, permanent Conversation center, collapsible Artifact reader/diff sidebar right.
- Artifact focus mode temporarily takes the center; editing appears only after Ready.
- Suggested Responses fill the composer for editing before submission; custom responses always remain available.
- Informational phase indicator only; phase transitions occur through Conversation actions.
- Collapsed-by-default activity rows retain all sanitized details; secrets never persist or display.
- Status uses icon, label, and color: Running, Waiting, Failed, Ready, and Saved.
- Pinned Ideas remain first; unpinned groups are Needs attention, Running, and Recent. Pinned Ideas show a Dormant indicator after 30 inactive days.
- Idea-level Changes view compares all files against app snapshots, independent of Git.
- Compact context-window indicator sits near model/effort controls; detailed per-Run and per-Idea tokens live outside the Conversation.
- Background notifications are opt-in and contain no content.
- Ready includes a collapsible **Implement elsewhere** guide with spec/ticket paths and a warning that `/implement` commits to the current branch.
