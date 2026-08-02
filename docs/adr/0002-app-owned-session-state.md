# ADR 0002: Session state is app-owned, not user-visible Markdown

Status: accepted
Date: 2026-08-01

Supersedes the Idea Library storage model of the pre-pivot planning product
(see git history for `.scratch/idea-development-desktop/`).

## Context

The product pivoted from developing Ideas into specifications and tickets, to a
chat with a coding agent that edits a local git Project. See `CONTEXT.md` for
the current domain language.

Every storage decision in this repo followed from one principle: the durable
output is Markdown the user owns, visible and usable outside the app. That
principle earned its keep when the output was **specs and tickets** — documents
whose entire value is being readable elsewhere.

Under the pivot the durable output is **code in the user's repository**, which is
already local, already user-visible, and already versioned by git. The
Conversation becomes a log of how that code came to exist, not a deliverable.

## Decision

Sessions, Conversations, and Runs are stored as **app-owned state** in
application support. They are not user-editable files, and there is no Idea
Library.

The user's canonical, portable artifact is their git repository.

Portability, if it is ever wanted, is an **export action** — not a storage
architecture.

## Considered options

- **A separate Library of Markdown transcripts, repositories left clean.** The
  tempting compromise. Rejected because it retains roughly a thousand lines of
  reconciliation machinery to solve a problem nobody has: the user hand-editing
  a chat log behind the app's back.
- **Transcripts written into the repository** (`.agent/sessions/*.md`).
  Rejected: the app would write files into every repository the user touches,
  and every user would have to gitignore it.

Codex (`~/.codex/sessions`) and Claude Code (`~/.claude/projects`) both store
session history as opaque app state, and portability of the transcript is not a
reported pain point for either.

## Consequences

- The following exist only to protect **user-editable canonical files**, and are
  removed: `app/src/core/external-content.ts` (Reference Attachment
  reconciliation), managed-document versions, conflicts and duplicates, the
  multi-document transaction staging under `.idea/transactions/`, and the
  `reconciliation` / `missing` / `unrecoverable` center surfaces.
- Onboarding no longer asks for a folder before the app is usable. It asks the
  user to add their first Project.
- What survives is the part that was never about user-visible files: the
  Conversation journal, projection and recovery in `app/src/core/conversation.ts`,
  persist-before-AI, and per-Run usage accounting.
- Losing application support data loses conversation history. It cannot lose
  work, because work lives in the user's repository under git.
