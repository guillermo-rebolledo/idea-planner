# 12d — What the changed-files panel knows but does not say

**What to build:** Three places where the panel has the answer and shows something else.

**A deletion reads as a change.** A file the agent removed appears as a row whose diff happens to be all minus lines. Somebody scanning the panel cannot tell "edited" from "gone" — the two need different words. The Checkout comparison already knows which is which, because git says so; the panel simply throws it away.

**Binary and mode-only changes read as nothing.** A change with no text in it shows `+0 −0` and an empty body, which looks exactly like a bug. Not inventing lines for a binary file is right; saying nothing about why there are none is not.

**Two truncations happen in silence.** A Run lists at most 500 changed files, and a stored diff keeps at most 400 lines ([ticket 05](05-the-conversation.md)'s budget). A codemod that touched 900 files reports 500 and looks complete; a large diff shows its first lines and looks whole. A panel that quietly under-reports is worse than one that admits a limit — the point of the panel is that it can be trusted without reading the log.

Renames stay out of scope. Without rename detection git reports one as a deletion and an addition, and labelled correctly that is already honest; a `renamed` row that carries where the file came from is a refinement, not this.

**Blocked by:** 12c

**Status:** done

- [x] A deleted file says it was deleted, and a created one says it was created — from git, and from Codex about its own changes; Claude does not say, and is not guessed at
- [x] A change with no text says why there is nothing to show, rather than showing `+0 −0`
- [x] A Run that changed more files than it lists says how many it did not list
- [x] A diff that was shortened for storage says it was shortened
- [x] `pnpm verify` passes

## Answer — every source is asked, and none is guessed

The Checkout comparison asks git `--name-status -z`, so created, changed and deleted come from git rather than from the shape of a patch. Codex says which of the three each of its own changes was, and that is carried through too. Claude does not say, and its changes stay `changed`: inventing a deletion from an empty diff would name something the Harness never claimed.

The row says the latest thing that happened to the file, so a file created and later deleted reads as deleted. Within a single Run this does not arise — a Run reports one entry per file per source, and a path the Harness already accounted for is not compared again — so it is a Session-level truth, across Runs.

A deleted row is struck through and says `deleted`; a created one says `created`.

## Answer — nothing to show, and two reasons

A change with no lines at all says why, rather than showing `+0 −0`. There are two whys and they are not the same thing: a binary file or a mode change has no text to diff and says `no text change`, while a change whose patch was too large to read back has text that this app does not have and says `diff not kept`. The first version conflated them, and would have told somebody a forty-thousand-line change had no text in it.

## Answer — both truncations speak

A stored diff carries whether it was shortened, so an expanded row says the counts above it are the whole change and the lines are not. The count was already honest ([12c](12c-complete-changed-files.md)); now the body admits it.

A Run that changed more files than it lists records that on its own activity — `500 of 912 changed files are listed; the rest changed too`. It goes there rather than into the panel because it is a fact about that Run, not about any file.

## Answer — renames

Still a deletion and an addition, now labelled as such. That is honest, and it is all this ticket claimed: a `renamed` row carrying where the file came from needs rename detection and a second path on the record, which is a change to what is stored rather than to what is said.
