# `.worktreeinclude`

An isolated Checkout arrives usable: it receives the Project's ignored directories and its
ignored local configuration. When a `.worktreeinclude` file exists at the Project root, it replaces
that default selection entirely.

## The default set

Without `.worktreeinclude`, a new isolated Checkout receives:

- **every directory Git reports as ignored**, collapsed at its highest level — `node_modules`,
  `.venv`, `target`, build caches, and the same directories nested inside a workspace package; and
- the ignored files matching the single pattern `.env*`.

The directory set is Git's answer, never a list of ecosystem names Argos knows: a curated list rots
and is wrong for polyglot repositories. Git collapses a directory only when the whole of it is
ignored, so nothing tracked — and nothing merely untracked — can ride along inside one.

## The grammar

The file uses a deliberately small Git pathspec glob grammar:

- one Project-root-relative pattern per line;
- empty lines and lines beginning with `#` are comments;
- a leading `!` excludes its matches from all positive patterns; exclusion order does not override
  later positive patterns;
- a leading `/` is accepted as an explicit Project-root anchor;
- `*`, `?`, character classes such as `[ab]`, and `**` use Git's `glob` pathspec rules;
- backslash escaping is not supported; and
- absolute paths, NUL bytes, and any `..` path component are refused.

## Directories

A pattern that matches a directory Git reports as ignored carries that whole directory — `vendor`,
`node_modules`, and `local/**` all name the directory when Git considers the whole of it ignored. A
directory Git does not report as ignored is never carried whole; its contents are then considered
one file at a time, and the ones Git does not ignore are skipped as `not-ignored`.

One interaction is worth knowing: if a `!` pattern **names a place inside** a directory —
`!node_modules/.cache`, `!node_modules/*/fixtures` — that directory is not carried whole, because a
clone would quietly re-admit exactly what the exclusion refused. Its ignored files are carried one
by one instead, which is much slower for a large dependency tree.

Only the part of a pattern before its first wildcard names a place, so an exclusion anchored to no
directory in particular — `!*.log`, `!**/.DS_Store` — keeps applying to the files it is matched
against and does **not** reach inside a directory carried whole. To keep something out of such a
directory, name it: `!node_modules/.cache`.

Carried directories keep Git's trailing slash in what Argos reports, so `node_modules/` reads as the
tree it is rather than a file of that name.

## How a directory is carried

Directories are carried by **copy-on-write clone**, so a Checkout costs close to nothing to create
and diverges into real disk only as something writes to it. A filesystem that cannot clone — most
often a Project on a different volume from Argos's own state directory — is a typed
`clone-unsupported` skip: the person is told the Checkout was not bootstrapped, and no partial
directory is left behind. Argos never falls back to a multi-gigabyte byte copy nobody asked to
wait for; the clone is run through the system `/bin/cp` by absolute path, because a GNU `cp` found
first on `PATH` reads the same flag as `--preserve=context` and would byte-copy without a word.

A clone that fails partway is undone rather than left: half a dependency tree reads as installed.

**The symlink exception.** A symlink named by a pattern is never carried, exactly as before. The
symlinks _inside_ a cloned directory are kept as symlinks, including ones resolving outside the
Project: a pnpm `node_modules` is a farm of links into a store elsewhere on the machine, and a clone
that dropped them would look present and not work.

## What is never carried

Matching is only the first filter. Argos asks Git to enumerate matches with NUL-delimited output and
verifies every candidate; tracked paths, paths Git does not report as ignored, named symlinks, and
anything resolving outside the Project are never carried.

No repository-provided command is run at any point of Checkout creation.
