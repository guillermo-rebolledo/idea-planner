const MAX_TITLE_LENGTH = 60
const FALLBACK_TITLE = 'Untitled Session'

/**
 * Deterministic, local title suggestion derived from captured notes.
 * No AI involvement: first meaningful line, markdown markers stripped,
 * trimmed to a word boundary.
 */
export function suggestSessionTitle(notes: string): string {
  const firstLine = notes
    .split('\n')
    .map((line) => stripMarkdownMarkers(line).trim())
    .find((line) => line.length > 0)

  if (!firstLine) return FALLBACK_TITLE

  const collapsed = firstLine.replace(/\s+/g, ' ')
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed

  const cut = collapsed.slice(0, MAX_TITLE_LENGTH + 1)
  const lastSpace = cut.lastIndexOf(' ')
  const trimmed = (
    lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, MAX_TITLE_LENGTH)
  ).replace(/[\s.,;:!?-]+$/, '')
  return trimmed.length > 0 ? trimmed : FALLBACK_TITLE
}

function stripMarkdownMarkers(line: string): string {
  return line
    .replace(/^\s*(#{1,6}|[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*>\s*/, '')
    .replace(/[*_`]/g, '')
}

export { FALLBACK_TITLE }
