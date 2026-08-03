import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DetectedEditor, EditorId } from '@shared/contract'

const run = promisify(execFile)

/**
 * What "Open in" can offer on this Mac. Detection is looking for the
 * application bundle where macOS installs applications — nothing is launched
 * to ask, and an editor that lives somewhere unusual is simply not offered.
 * Terminal and Finder are part of the operating system, so they are not
 * probed for.
 */

/** The editors this app knows how to detect and address, in offer order. */
const KNOWN_EDITORS: { id: EditorId; name: string; bundle: string }[] = [
  { id: 'cursor', name: 'Cursor', bundle: 'Cursor.app' },
  { id: 'vscode', name: 'Visual Studio Code', bundle: 'Visual Studio Code.app' },
  { id: 'zed', name: 'Zed', bundle: 'Zed.app' }
]

/** What every Mac has, offered after the editors. */
const SYSTEM_PLACES: DetectedEditor[] = [
  { id: 'terminal', name: 'Terminal' },
  { id: 'finder', name: 'Finder' }
]

/** Where macOS installs applications: for everyone, and for this user. */
export function macApplicationDirs(): string[] {
  return ['/Applications', join(homedir(), 'Applications')]
}

interface DetectOptions {
  applicationDirs?: string[]
  /** Whether a path exists, injectable so a test can be any machine. */
  exists?: (path: string) => Promise<boolean>
}

export async function detectEditors(options: DetectOptions = {}): Promise<DetectedEditor[]> {
  const dirs = options.applicationDirs ?? macApplicationDirs()
  const exists = options.exists ?? pathExists
  const detected = await Promise.all(
    KNOWN_EDITORS.map(async (editor) => {
      const installs = await Promise.all(dirs.map((dir) => exists(join(dir, editor.bundle))))
      return installs.some(Boolean) ? [{ id: editor.id, name: editor.name }] : []
    })
  )
  return [...detected.flat(), ...SYSTEM_PLACES]
}

/**
 * The exact `open` invocation for one choice. Applications are addressed by
 * the name they registered rather than a bundle path, so an install moved by
 * the person still opens; Finder is given the folder itself.
 */
export function openCommand(editor: EditorId, path: string): { command: 'open'; args: string[] } {
  if (editor === 'finder') return { command: 'open', args: [path] }
  const name =
    KNOWN_EDITORS.find((known) => known.id === editor)?.name ??
    // Terminal is the one non-editor left, and `open -a` addresses it too.
    'Terminal'
  return { command: 'open', args: ['-a', name, path] }
}

/** Opens the Checkout. Failure surfaces to the caller — a silent chip lies. */
export async function openInEditor(editor: EditorId, path: string): Promise<void> {
  const invocation = openCommand(editor, path)
  await run(invocation.command, invocation.args, { timeout: 10_000 })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
