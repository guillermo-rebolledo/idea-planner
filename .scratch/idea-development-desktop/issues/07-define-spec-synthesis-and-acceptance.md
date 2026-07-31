# Define MVP Spec synthesis and acceptance

Type: grilling
Status: open
Blocked by: 01, 05

## Question

Which accepted Artifacts and Conversation context may `/to-spec` synthesize, how is its testing-seam checkpoint represented, how do the user and AI discuss and revise the MVP Spec, and what explicit acceptance state permits ticket drafting to begin?

## Comments

Agreed constraints:

- Explicit **Create MVP Spec** is available while waiting once planning context exists and is promoted when the AI suggests completion; prose never advances phase automatically.
- Continue the same Conversation with a visible Spec Review divider.
- `/to-spec` receives the complete user/assistant Conversation plus latest complete Draft Artifacts, excluding raw tool/protocol logs, retries, and abandoned partial writes.
- Preserve `/to-spec`'s testing-seam confirmation before it writes `spec.md`.
- Feedback and revisions remain conversational. Continuing to tickets freezes the chosen spec snapshot but does not yet promote files.
- Grill mode relies on `conversation.md` as its sole pre-spec input; Wayfinder also contributes its native map and decision artifacts.
