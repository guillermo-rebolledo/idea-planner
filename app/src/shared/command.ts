/**
 * A command as the transcript reads it, rather than as the operating system
 * received it.
 *
 * Codex runs everything through a login shell, so its record of one command is
 * `/bin/zsh -lc 'git log --oneline -15'` where Claude's record of the same
 * command is `git log --oneline -15`. Both are true, and the wrapper is what
 * the journal keeps, because what actually ran is the thing worth recording.
 * This is only how it is drawn: the same work should read the same way
 * whichever Harness did it, and the wrapper is a fact about the Harness rather
 * than about the command.
 *
 * It is deliberately not used where a command is being authorized. An approval
 * has to show exactly what will run — wrapper and all — because that is the
 * thing being agreed to.
 */

/** `/bin/zsh -lc '…'`, `bash -lc "…"`, `sh -c '…'` — one quoted script, whole. */
const WRAPPED = /^(?:[\w.-]*\/)*(?:ba|z|k|da|fi)?sh\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/

/**
 * Stands in for an escaped quote while the body is checked for a bare one.
 * A NUL cannot occur in a command a shell agreed to run, so it can never be
 * mistaken for content — written as an escape because an invisible control
 * character in source is a bug waiting to be introduced by an editor.
 */
const SENTINEL = '\u0000'

export function displayCommand(command: string): string {
  const match = WRAPPED.exec(command.trim())
  if (match === null) return command
  const quote = match[1]
  const body = match[2]
  if (quote === undefined || body === undefined || body === '') return command

  /* The outer quotes only wrap one script if every quote of the same kind
     inside them is escaped. `zsh -lc 'a' 'b'` passes two arguments and reads
     as one script to a regex, so it is left exactly as it was recorded —
     shortening a command into something that would do a different thing is
     worse than showing the wrapper. */
  const escaped = quote === "'" ? "'\\''" : '\\"'
  const masked = body.split(escaped).join(SENTINEL)
  if (masked.includes(quote)) return command
  return masked.split(SENTINEL).join(quote)
}
