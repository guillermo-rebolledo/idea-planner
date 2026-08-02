# 12d — What the changed-files panel knows but does not say

**What to build:** Three places where the panel has the answer and shows something else.

**A deletion reads as a change.** A file the agent removed appears as a row whose diff happens to be all minus lines. Somebody scanning the panel cannot tell "edited" from "gone" — the two need different words. The Checkout comparison already knows which is which, because git says so; the panel simply throws it away.

**Binary and mode-only changes read as nothing.** A change with no text in it shows `+0 −0` and an empty body, which looks exactly like a bug. Not inventing lines for a binary file is right; saying nothing about why there are none is not.

**Two truncations happen in silence.** A Run lists at most 500 changed files, and a stored diff keeps at most 400 lines ([ticket 05](05-the-conversation.md)'s budget). A codemod that touched 900 files reports 500 and looks complete; a large diff shows its first lines and looks whole. A panel that quietly under-reports is worse than one that admits a limit — the point of the panel is that it can be trusted without reading the log.

Renames stay out of scope. Without rename detection git reports one as a deletion and an addition, and labelled correctly that is already honest; a `renamed` row that carries where the file came from is a refinement, not this.

**Blocked by:** 12c

**Status:** done

- [x] A deleted file says it was deleted, and a created one says it was created
- [x] A change with no text says why there is nothing to show, rather than showing `+0 −0`
- [x] A Run that changed more files than it lists says how many it did not list
- [x] A diff that was shortened for storage says it was shortened
- [x] `pnpm verify` passes

## Answer — git already knew

The comparison asks `--name-status -z` rather than `--name-only -z`, so which files were created, changed and deleted comes from git rather than being guessed from the shape of a patch. A deleted row is struck through and says `deleted`; a created one says `created`.

The latest thing to happen to a file is what the row says it is: a file created and then removed in one Session reads as deleted, because that is what is true of it now.

Harness-reported changes stay `changed` unless the Harness itself says otherwise. Neither Adapter says today, and inventing it from an empty original would guess.

## Answer — nothing to show, and why

A change with no lines at all — a binary file, a mode, a rename of either — says `no text change` instead of `+0 −0`, and opening it says why there is nothing there. Not inventing lines was already right; saying nothing about it was what made it look broken.

## Answer — both truncations speak

A stored diff carries whether it was shortened, so an expanded row says the counts above it are the whole change and the lines are not. The count was already honest ([12c](12c-complete-changed-files.md)); now the body admits it.

A Run that changed more files than it lists records that on its own activity — `500 of 912 changed files are listed; the rest changed too`. It goes there rather than into the panel because it is a fact about that Run, not about any file.

## Answer — renames

Still a deletion and an addition, now labelled as such. That is honest, and it is all this ticket claimed: a `renamed` row carrying where the file came from needs rename detection and a second path on the record, which is a change to what is stored rather than to what is said.
