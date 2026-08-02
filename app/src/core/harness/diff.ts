import { redactCredentials, type DiffHunk } from '@shared/conversation'

/**
 * A patch from git, read into the hunks the Conversation holds. A patch with
 * no hunk header changed no text at all — a binary file, or only a mode — and
 * reading its own headers as added lines would invent a change.
 */
export function parseGitPatch(diff: string): DiffHunk[] {
  return parse(diff, false)
}

/**
 * A patch from Codex. It sends a new file's whole content instead of a diff of
 * it, so a patch with no hunk header is everything in it being added.
 */
export function parseCodexPatch(diff: string): DiffHunk[] {
  return parse(diff, true)
}

/**
 * Codex and a comparison of a Checkout both send patches, and a diff read
 * differently depending on who sent it is a diff nobody can trust. This is the
 * one reading; what differs is only what a patch with no hunks means. Claude
 * needs none of it — it sends the hunks already parsed.
 */
function parse(diff: string, wholeFileWhenNoHunks: boolean): DiffHunk[] {
  const empty: DiffHunk = { oldStart: 0, oldLines: 0, newStart: 1, newLines: 0, lines: [] }
  if (!diff) return [empty]
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
  const lines = diff.split('\n')
  if (!lines.some((line) => header.test(line))) {
    if (!wholeFileWhenNoHunks) return [empty]
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
