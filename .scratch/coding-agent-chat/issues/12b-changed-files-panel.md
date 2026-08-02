# 12b — The changed-files panel

**What to build:** Each Session summarises what it has done to the Project: the files the agent changed, and a read-only diff for each one.

Inline diffs in the Conversation answer "what is happening". This answers "what is the state of this work" when the person comes back tomorrow, without scrolling a chat log.

Because [ADR 0004](../../../docs/adr/0004-in-place-primary-checkout.md) edits the primary checkout in place, `git diff` conflates the person's own edits with the agent's. A Project that was already dirty when the Session started would have the person's work attributed to the agent — so the panel is built from a per-Session record of what the agent changed, not from repository state.

The app offers no accept or reject. It reports what happened; git is what decides what to keep.

Split out of ticket 12, which shipped the inbox itself. The panel is a per-Session record the app does not yet keep, and building it is a change to what a Run writes rather than to how Sessions are listed.

**Blocked by:** 12

**Status:** done

- [x] Each Session shows the files the agent changed, derived from a per-Session record rather than repository state
- [x] The changed-files panel is correct when the Project was already dirty at Session start
- [x] Opening a changed file shows a read-only diff; the app offers no accept or reject
- [x] `pnpm verify` passes

## Answer — the record already existed

The Conversation has recorded a `file-change` entry per file the Harness reported since ticket 05, with the hunks the Harness itself computed. That *is* the per-Session record this ticket asked for, so nothing new is written to disk: the panel folds those entries into one row per file, counting how many times each was written and what it added and removed.

Being right about a dirty Project falls out of that rather than being handled. The app never asks git what changed, so a file the person had already edited cannot appear — there is no code path that could attribute it to the agent. A test asserts it anyway, in Core and in the packaged shell, because the failure mode this guards against is somebody later reaching for `git diff`.

## Answer — nothing to accept

The panel opens a file to a read-only diff and offers no button that would take a change back. The change is already on disk (ADR 0004) and git is the only undo; an accept or reject here would be the app pretending to own a decision it does not.

## Answer — one diff renderer, one count

The Conversation's inline diff and the panel's share `DiffView`, and `countDiffLines` in the contract is the single definition of what a change added and removed — Core and the Renderer both use it rather than each counting for themselves.

The count is taken from the whole change, not from the diff that was stored. A long diff keeps only its first lines (ticket 05's budget), so counting what survived would report a smaller change than the one that happened. The entry carries the real totals, and the Conversation's own row uses them too.

## Answer — what the panel cannot see

It shows what the Harness reported changing. An agent that edits through a shell command rather than an edit tool changes the Project without reporting a file change, and nothing here would list it. That is the same limit the Conversation's inline diffs already have, and the honest alternative — reading the repository — is exactly what this ticket exists to avoid.
