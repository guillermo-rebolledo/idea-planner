# Define the Conversation and Artifact lifecycle

Type: grilling
Status: resolved

## Question

What exact states, transitions, user actions, interruption behavior, and acceptance rules take an Idea from its initial prompt through an interactive Conversation, evolving Draft Artifacts, settled or discarded Conversations, and user-editable accepted Artifacts?

## Answer

Persist the Idea and its opening message before starting AI. Creation offers **Save for later** or **Start developing**, and the latter explicitly selects Grill Me or Wayfinder, harness, model, and effort. Grill Me and Wayfinder remain faithful separate workflows; neither silently upgrades into the other.

Each Idea has one permanent Conversation. A Run is one submitted user turn followed by AI work and may be Running, Waiting for user, Waiting for approval, Completed, Failed, or Stopped. Stop behaves like ChatGPT: cancel current work while retaining history and the last complete atomic Draft Artifact snapshots. Failure, cancellation, harness switching, app restart, and model changes create visible boundaries without losing the Idea. Only one Run may be active per Idea; cross-Idea concurrency is bounded and user-configurable.

Software Ideas move through **Captured → Developing → Spec Review → Ticket Review → Ready** via explicit user actions. General Ideas use **Captured → Developing → Ready**. All AI-generated Markdown remains draft and read-only in the app throughout planning. Phase transitions freeze snapshot baselines without final promotion. `/to-tickets`' existing approval is the final acceptance event: after the complete file set validates, the Planning Package becomes user-editable and the Idea becomes Ready.

Pin, archive, inactivity, and permanent deletion apply to the Idea, not its Conversation. Archive is recoverable and must stop an active Run; permanent deletion is separately confirmed. Ready Ideas may be edited manually without changing phase, show a changed-baseline indicator, and enter a new planning cycle only through explicit **Reopen planning**. App exit, update, or archive never leaves an orphaned CLI process.
