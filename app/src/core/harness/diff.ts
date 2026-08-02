import { redactCredentials, type DiffHunk } from '@shared/conversation'

/**
 * A unified diff, read into the hunks the Conversation holds. Three things
 * send patches — the Codex Adapter, the Claude Adapter, and the comparison of
 * a Checkout before and after a Run — and a diff that is read differently
 * depending on who sent it is a diff nobody can trust.
 *
 * `wholeFileWhenNoHunks` is the one difference between them. Codex sends a new
 * file's whole content instead of a diff of it, so a patch with no hunk header
 * is everything in it being added. Git never does that: a patch of its with no
 * hunks changed no text at all — a binary file, or only a mode — and reading
 * its headers as added lines would invent a change.
 */
export function parseUnifiedDiff(
  diff: string,
  options: { wholeFileWhenNoHunks: boolean }
): DiffHunk[] {
  const empty: DiffHunk = { oldStart: 0, oldLines: 0, newStart: 1, newLines: 0, lines: [] }
  if (!diff) return [empty]
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
  const lines = diff.split('\n')
  if (!lines.some((line) => header.test(line))) {
    if (!options.wholeFileWhenNoHunks) return [empty]
    return [bounded({ ...empty, newLines: lines.length, lines: lines.map((line) => `+${line}`) })]
  }
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  for (const line of lines) {
    const match = header.exec(line)
    if (match) {
      current = {
        oldStart: Number(match[1]),
        oldLines: Number(match[2] ?? '1'),
        newStart: Number(match[3]),
        newLines: Number(match[4] ?? '1'),
        lines: []
      }
      hunks.push(current)
      continue
    }
    // Anything before the first hunk header is the patch's own preamble —
    // git's `diff --git`, `index`, `---` and `+++` lines — and belongs to no
    // hunk. A `+++` line read as an addition would show up as changed text.
    current?.lines.push(line)
  }
  return hunks.length > 0 ? hunks.map(bounded) : [empty]
}

/**
 * One hunk as the Conversation should hold it: redacted, and without the empty
 * final line a trailing newline leaves behind.
 */
function bounded(hunk: DiffHunk): DiffHunk {
  const lines = [...hunk.lines]
  const last = lines.at(-1)
  if (last === '' || last === '+') lines.pop()
  return { ...hunk, lines: lines.map((line) => redactCredentials(line)) }
}
