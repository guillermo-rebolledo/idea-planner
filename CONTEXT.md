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
The directory a Session operates on — either the **primary checkout**, the Project's own working directory edited in place, or an **isolated checkout**, a linked git worktree created for the Session from a chosen base branch.
_Avoid_: Working Directory, workspace, worktree, sandbox

### Conversation

**Conversation**:
The permanent message history belonging to one Session, containing its user messages, agent responses, and Run boundaries.
_Avoid_: Session, chat, transcript

**Run**:
One user submission followed by agent work until the application is waiting for the user, completes, fails, or is stopped. A Run is configured with a Harness, model, reasoning effort, and Permission Mode.
_Avoid_: Conversation, turn, Harness Thread

**Harness**:
A locally installed CLI coding agent the app drives as a child process, such as Codex or Claude Code. The app never provides inference itself.
_Avoid_: Provider, model, backend

**Harness Thread**:
The Harness-specific continuity record behind a Conversation, such as a Codex thread or Claude session. A Conversation may cross Harness Threads when the user switches Harness.
_Avoid_: Conversation, Run, Harness Session

**Skill**:
An installed instruction document that gives the agent a defined methodology for a Run, such as test-driven development or bug diagnosis. Discovered from the user's global skill directories or from the Project, and never installed by the app. A Project's own Skills stay inert until the user trusts that Project.
_Avoid_: Workflow, command, prompt

### Permission

**Permission Mode**:
The posture the user selects for a Run: **Ask**, where the agent requests consent before changing files or running commands, or **Full access**, where it does not.
_Avoid_: Approval policy, sandbox mode, YOLO

**Standing Approval**:
A permission the user has granted permanently for a Project — a command the agent may run, or a class of file changes it may make, without asking. Applies across all Sessions in that Project and is revocable.
_Avoid_: Allowlist, whitelist, permission

**Readiness**:
Whether a Harness is installed, compatible, and authenticated on this machine. A Harness clearing all three is **usable**, and at least one usable Harness is required before the app can be used at all. Reported per Harness and repaired by the user, never by the app.
_Avoid_: Health, status, setup
