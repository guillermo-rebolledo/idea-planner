# 12c — Everything that changed, not only what was reported

**What to build:** The changed-files panel is currently built from what the Harness said it changed. An agent that edits through a shell command — `sed -i`, a redirect, a codemod, a formatter — changes the Project and reports nothing, so the panel quietly under-reports. A panel that is silently incomplete is worse than one that admits a gap.

Neither Harness solves this for us. Codex's own `turn/diff/updated` is documented as tracking "the net text diff for the current turn from committed `apply_patch` mutations, **without rereading the workspace filesystem**", so it has the same blind spot; its complete answer, `git/diffToRemote`, is the whole worktree and hands back the person's own edits mixed in with the agent's. T3 Code sidesteps the problem entirely by running agents in a git worktree nobody else is editing — which is exactly what [ADR 0004](../../../docs/adr/0004-in-place-primary-checkout.md) gave up when it chose the primary checkout.

So the app answers it itself, with a snapshot of the Checkout taken when a Run starts and again when it ends. Diffing the two says what changed **however it changed**, and because the baseline is taken at Run start, a Project that was already dirty stays the person's.

The snapshot must not touch the person's repository. `GIT_INDEX_FILE` and `GIT_OBJECT_DIRECTORY` point at an app-owned directory with the repository as a read-only alternate, so `git add -A && git write-tree` writes every blob and tree into app-owned state and leaves their index, their HEAD, and their object store exactly as they were. `git add -A` honours `.gitignore`, so build output stays out for free.

The Harness-reported record stays: it says *how* each change happened and it is live while the Run is going. The snapshot is the completeness backstop at the Run boundary. A file the snapshot saw that the Harness never mentioned is shown as exactly that, rather than being blended in — the person can tell what the agent narrated from what merely happened.

Two things this cannot do, and should say so rather than pretend: a person editing the Project while a Run is in flight lands in that Run's diff, and a Session whose Checkout is not a repository has no snapshot at all.

**Blocked by:** 12b

**Status:** done

- [x] A Run snapshots its Checkout at start and at end, writing nothing into the person's repository
- [x] Files changed by a shell command appear in the panel even though no Harness reported them
- [x] Edits the person had already made before the Run are never attributed to the agent
- [x] An unreported change is labelled as one, not blended with what the agent said it did
- [x] A Checkout that is not a repository, or a machine with no git, degrades to the reported record without failing the Run
- [x] `pnpm verify` passes

## Answer — how the snapshot stays out of the way

`GIT_INDEX_FILE` and `GIT_OBJECT_DIRECTORY` point at an app-owned directory and the repository is added as `GIT_ALTERNATE_OBJECT_DIRECTORIES`, so `git add -A && git write-tree` reads everything the repository already has and writes every new blob and tree into app-owned state. A test asserts the loose-object count under `.git` and the person's staged paths are both unchanged across a snapshot.

The alternate is asked for with `rev-parse --git-path objects` rather than assumed to be `.git/objects`: in a linked worktree or a submodule `.git` is a file and the objects are elsewhere, and guessing would make the app rehash the whole tree into its own store. A worktree test covers it.

## Answer — where the baseline lives

Beside the Run, not inside it. A Run that ends badly has its directory removed, and the first version of this kept the baseline there — so the objects describing "before" were deleted moments before the comparison that needed them, and the panel silently gained nothing. The packaged-shell test caught it. The snapshot directory is now app-owned state keyed by the Run, removed once its comparison is done.

## Answer — two records, not one

The Harness-reported record still says *how* each change happened, and it is live while the Run is going. The comparison runs once, when the Run ends, and Core keeps only the paths the Harness did not already account for — recording both would double what the panel says the Run did. A row nothing accounted for reads `changed without being reported`, so what the agent narrated can be told from what merely happened.

## Answer — what it still cannot do

A person editing the Project while a Run is in flight lands in that Run's comparison; there is no way to tell their save from the agent's from the outside. A Checkout that is not a repository, or a machine with no git, has no snapshot, and the Run ends exactly as it would have — the reported record is all there is, which is what this ticket started with.
