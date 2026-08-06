# `.worktreeinclude`

An isolated Checkout can receive ignored local configuration from its Project. When a
`.worktreeinclude` file exists at the Project root, it replaces the default `.env*` selection.

The file uses a deliberately small Git pathspec glob grammar:

- one Project-root-relative pattern per line;
- empty lines and lines beginning with `#` are comments;
- a leading `!` excludes a pattern selected by an earlier positive pattern;
- a leading `/` is accepted as an explicit Project-root anchor;
- `*`, `?`, character classes such as `[ab]`, and `**` use Git's `glob` pathspec rules;
- backslash escaping is not supported; and
- absolute paths, NUL bytes, and any `..` path component are refused.

Argos asks Git to enumerate matches with NUL-delimited output and verifies every candidate with
`git check-ignore`. Matching is only the first filter: tracked paths, directories, symlinks, and
anything outside the Project are never copied.

Without `.worktreeinclude`, the single pattern `.env*` is used. No repository-provided command is
run as part of Checkout creation.
