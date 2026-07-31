# Prototype the conversation-first workspace

Type: prototype
Status: resolved
Blocked by: 01, 07, 09

## Question

What three-pane desktop interaction design makes the Idea inbox, question-and-answer Conversation, Suggested Responses, live Run status, evolving Markdown Draft Artifacts, MVP Spec review, and Implementation Ticket review understandable without making the product feel like an autonomous agent?

## Answer

Use **Focus Mailbox** for the complete lifecycle: a full Mailbox-style Idea inbox that is expanded by default and collapses into a compact rail; one permanent Conversation as the central Focus Deck; and an independently collapsible Artifact drawer with Markdown preview and app-snapshot diffs. Artifact focus may temporarily take the center, but phase decisions and every AI interaction remain visible user turns in the Conversation.

The validated workflow-state presentation keeps one layout across Developing, Spec Review, Ticket Review, publication failure, and Ready:

- Spec Review carries prior Conversation context forward, exposes its frozen input summary and testing-seam decision, and pairs explicit Spec acceptance with read-only preview/diff.
- Ticket Review presents the numbered vertical slices inline, using readable blocker labels, a frontier summary, and direct responses for granularity and dependency changes.
- Transactional publication failure remains in Ticket Review, states that no partial package became authoritative, identifies validation problems, and offers repair, details, or safe retry.
- Ready makes the accepted Planning Package editable, shows the current implementation frontier, and keeps the external `/implement` guide collapsed with its current-branch commit warning.

Suggested Responses are one-click submissions, not composer-prefill shortcuts. Clicking an option immediately appends it as a normal user message and begins the next Run. The custom composer remains available for an editable response and requires an explicit Send action. Phase acceptance actions use the same visible user-message path and are never available to unattended Auto/YOLO execution.

Theme is whole-application, never a mixed light-content/dark-chrome treatment. The default is **System**, reacting to macOS appearance; the user may explicitly override it with Light or Dark. All shell, Conversation, Artifact, diff, overlay, status, and review surfaces must share the resolved theme while retaining semantic status contrast and respecting reduced motion.

The prototype validates structure and interaction only. Production uses source-owned shadcn/ui for the shell, Nexus UI conversational primitives, assistant-ui's standalone Diff Viewer, and normalized product events rather than prototype-local state. The throwaway source remains intentionally uncommitted because the explicit product Git boundary overrides the prototype skill's branch-capture rule.

## Comments

Agreed constraints to validate in the prototype:

- Collapsible Idea inbox left, permanent Conversation center, collapsible Artifact reader/diff sidebar right.
- Artifact focus mode temporarily takes the center; editing appears only after Ready.
- The validated baseline is **Focus Mailbox**: a central Focus Deck plus a full Mailbox-style inbox that is expanded by default and collapses to a compact rail.
- Use Linear as the interaction-density and polish reference. Use source-owned shadcn/ui for the shell, Nexus UI registry primitives for the AI conversation, and assistant-ui's standalone Diff Viewer for app-snapshot diffs.
- Suggested Responses submit immediately as user turns; custom responses remain editable in the composer until explicitly sent.
- Informational phase indicator only; phase transitions occur through Conversation actions.
- Collapsed-by-default activity rows retain all sanitized details; secrets never persist or display.
- Status uses icon, label, and color: Running, Waiting, Failed, Ready, and Saved.
- Pinned Ideas remain first; unpinned groups are Needs attention, Running, and Recent. Pinned Ideas show a Dormant indicator after 30 inactive days.
- Idea-level Changes view compares all files against app snapshots, independent of Git.
- Compact context-window indicator sits near model/effort controls; detailed per-Run and per-Idea tokens live outside the Conversation.
- Background notifications are opt-in and contain no content.
- Ready includes a collapsible **Implement elsewhere** guide with spec/ticket paths and a warning that `/implement` commits to the current branch.
- Validate the Spec Review divider, testing-seam choice card, deterministic input summary, read-only Spec plus snapshot diff, explicit **Accept MVP Spec**, Ticket Review handoff, and changed-Spec invalidation without displacing the central Conversation.
- Validate the `/to-tickets` numbered quiz, editable granularity/dependency Suggested Responses, blocker chips and frontier summary, **Approve and create ticket files**, publication failure/retry, and final Ready handoff.

Prototype update:

- The validated Focus Mailbox now has a URL-persisted workflow-state walkthrough: Developing, Spec Review, Ticket Review, publication failure, and Ready.
- Spec Review includes carried Conversation history, frozen-input context, a required testing-seam decision, read-only Spec preview/diff, editable Suggested Responses, and explicit acceptance.
- Ticket Review includes the numbered breakdown, blocker labels, frontier summary, editable revision prompts, and the single final publication action.
- Publication failure keeps the Idea in Ticket Review, explains that no partial package became authoritative, identifies the invalid edge, and offers repair/details/retry paths.
- Ready makes the Planning Package editable, shows the current implementation frontier, and keeps the external `/implement` guide collapsed with its current-branch warning.
- Run with `pnpm prototype`, then open `/?variant=D&stage=spec`; the workflow-state control walks every state without persistence or real mutations.
- `pnpm prototype:check` passes. The throwaway source remains intentionally uncommitted because the product Git boundary overrides the prototype skill's branch-capture rule.

Validated:

- The permanent Conversation remains visually primary in every review state.
- Phase actions feel like user-authored Conversation turns, not autonomous state transitions.
- The Ticket Review breakdown and failure recovery are understandable without opening the Artifact drawer.
- Ready provides enough handoff context without implying that implementation runs inside the app.
- Whole-app System/Light/Dark appearance and direct Suggested Response submission are the accepted interaction model.
