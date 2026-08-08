# Coding Agent Chat

This context describes how a developer works with an AI coding agent on a local git repository — chatting with it, letting it change code, and controlling what it is allowed to do.

## Language

### Work

**Project**:
A local git repository the user has added to the app. Owns its Sessions and its Standing Approvals, and is identified by the resolved path of its root.
_Avoid_: Repository, folder, workspace

**Session**:
One unit of work with the agent against a Project. Owns a Checkout, a Conversation, and the changes made, and appears as a single item in the inbox.
_Avoid_: Idea, task, thread, chat

**Checkout**:
The directory a Session operates on — either the **primary checkout**, the Project's own working directory edited in place, or an **isolated checkout**, a linked git worktree created for the Session from a chosen base branch. On screen the two variants read **Local** and **Worktree** (title-bar cluster and Project card, design spec 2a/2b), and the contract spells them `local` / `worktree`; "worktree" stays out of prose that means a Checkout in general. One deliberate asymmetry: in the New Session picker the chip reads **Worktree** while the popover option it opens reads **Isolated** — the chip names what you get, the option names what you are asking for, each per the design spec's wording for its surface.
_Avoid_: Working Directory, workspace, sandbox

**Checkout State**:
The Git operation observed in a Checkout right now: **Clean**, **Merge in progress**, **Rebase in progress**, **Squash merge in progress**, **Cherry-pick in progress**, **Revert in progress**, **Unresolved index**, or **Unsafe Checkout root**. It is advisory context for a Run, so an agent can finish an operation already underway; an app action that requires a stable tree is blocked and names the exact state. Missing Git and a folder that is not a repository are observation failures, not Checkout States, and stay distinct in typed outcomes.
_Avoid_: Git status, busy, dirty

**Archive**:
Setting a Session aside while keeping everything it owns. An archived Session leaves the inbox but is restorable at any time; archiving says "not now", never "gone".
_Avoid_: Delete, hide, close

**Delete**:
Permanently removing a Session, its Conversation, and the Run Snapshots kept for it. The one destructive act in the app, and the only one that asks for confirmation. Files the Session changed stay on disk in its Checkout — git, not the app, is the undo for those.
_Avoid_: Archive, remove, clear

**Run Snapshot**:
The Checkout as it stood before and after one Run, held as Git objects the app owns rather than anything written into the Project. Kept for as long as its Session is, which is what makes **Run Undo** possible; Archive keeps it and Delete removes it. A Run from before snapshots were kept simply reports undo unavailable.
_Avoid_: Backup, version, checkpoint, commit

**Run Undo**:
Putting one Run's file changes back, from its Run Snapshot. Never automatic and never ⌘Z: the person asks for it on the Run. A **Worktree** Checkout may be restored **directly**, and only when every path it changed still holds exactly what the Run left there; anything else — every **Local** Checkout, and any Worktree where something has moved — is a **review**, where the inverse patch is read first and one confirmation applies only the **safe** paths. A path is safe, **diverged** (changed since, and never written to), or **already restored**. Undo appends to the Conversation and never rewrites it: the Run and its diff stay exactly as they were recorded.
_Avoid_: Revert, rollback, discard, restore point

**Pull Request**:
The GitHub proposal created when a person explicitly publishes one Worktree Session. Publishing is a reviewed staircase — commit, push, then create — driven through the person's authenticated `gh`; Argos stores only its link and remotely observed draft, open, merged, or closed state. The state is an inbox adornment, never what the Session is doing, and Archive keeps it while Delete removes it.
_Avoid_: Change Request, merge request, PR status as Session status

### Conversation

**Conversation**:
The permanent message history belonging to one Session, containing its user messages, agent responses, and Run boundaries.
_Avoid_: Session, chat, transcript

**Run**:
One user submission followed by agent work until the application is waiting for the user, completes, fails, or is stopped. A Run is configured with a Harness, model, reasoning effort, and Permission Mode.
_Avoid_: Conversation, turn, Harness Thread

**Queued Submission**:
A durable, editable request waiting inside one Session while another Run is active. It captures the message and its Run configuration when queued, keeps a stable submission identity through edits and reordering, and contacts a Harness only when Main claims it after an explicit Resume or a completed Run.
_Avoid_: Held message, draft, follow-up, pending prompt

**Review Attachment**:
Code the user selected while reading what a Session changed — a whole recorded write, one hunk, or a range of its lines — copied at the moment of selecting it and carried by exactly one message or Queued Submission. It is historical context for the Harness, never a live reference: later writes to the same file leave it untouched, and it has no thread, reply, resolved state, or synchronization anywhere.
_Avoid_: Review comment, annotation, code selection, snippet

**Subagent**:
A worker a Run dispatched to do one piece of its work and report back, carrying a name, the brief it was given where the Harness supplies one, and — once it ends — what it reported. Its own commands, reads and prose are its work rather than the Run's, and never appear as steps the Run took. The Run stays responsible for it: a Subagent has no Conversation of its own and is never spoken to directly.
_Avoid_: Child agent, task, worker thread, delegate

**Subagents dock**:
The surface holding one Run's Subagents, beside the Conversation rather than inside it, which collapses to a rail that keeps every Subagent's state visible. The Conversation itself says only that they exist.
_Avoid_: Sidebar, panel, drawer, fleet view

**Harness**:
A locally installed CLI coding agent the app drives as a child process, such as Codex or Claude Code. The app never provides inference itself.
_Avoid_: Provider, model, backend

**Harness Thread**:
The Harness-specific continuity record behind a Conversation, such as a Codex thread or Claude session. A Conversation may cross Harness Threads when the user switches Harness.
_Avoid_: Conversation, Run, Harness Session

**Adapter**:
The translation between one Harness's own protocol and the events the rest of the app understands, so nothing outside it sees a raw Harness frame. A Harness the app has no Adapter for can be perfectly usable and still unable to run a Session here, which is why the Launch Gate asks about Sessions rather than about Readiness.
_Avoid_: Driver, integration, plugin, connector

**Skill**:
An installed instruction document that gives the agent a defined methodology for a Run, such as test-driven development or bug diagnosis. Discovered from the user's global skill directories or from the Project, and never installed by the app. A Project's own Skills stay inert until the user trusts that Project.
_Avoid_: Workflow, command, prompt

### Permission

**Permission Mode**:
The posture the user selects for a Run: **Ask**, where the agent requests consent before changing files or running commands, or **Full access**, where it does not.
_Avoid_: Approval policy, sandbox mode, YOLO

**Approval Request**:
One thing the agent asks to be allowed before it does it, in Ask mode, carrying the command or change it would make. Its Run is blocked while the request stands; approving lets the agent proceed and denying refuses it — the agent is told, and carries on without.
_Avoid_: Permission prompt, confirmation, dialog

**Standing Approval**:
A permission the user has granted permanently for a Project — a command the agent may run, or a class of file changes it may make, without asking. Applies across all Sessions in that Project and is revocable.
_Avoid_: Allowlist, whitelist, permission

**Readiness**:
Whether a Harness is installed, compatible, and authenticated on this machine. A Harness clearing all three is **usable**. Reported per Harness and repaired by the user, never by the app.
_Avoid_: Health, status, setup

**Launch Gate**:
The app opening only when at least one Harness can run a Session. That is narrower than usable: a Harness this app cannot drive yet is one the person would send their first message to and watch do nothing. Stated per Harness, repaired in the user's own terminal, and re-checked without restarting.
_Avoid_: Blocker, paywall, splash
