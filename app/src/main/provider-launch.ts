import { open, realpath } from 'node:fs/promises'
import { delimiter, dirname, join, sep } from 'node:path'

/**
 * What one provider needs in order to start at all.
 *
 * A provider CLI is rarely a single self-contained binary: the command on PATH
 * is usually a symlink to a script, the script names an interpreter, and the
 * package ships its own native helper. The sandbox matches resolved paths, so
 * the launch closure has to be resolved the same way the loader will.
 *
 * This widens nothing the model can reach. It describes only how the provider
 * process boots; every model-visible operation still goes through the planning
 * tool host.
 */
export interface ProviderLaunch {
  /** Exact programs allowed to start, as canonical paths. */
  executables: string[]
  /** The provider's own installation tree, which may contain native helpers. */
  executableTrees: string[]
  /** Read-only roots the provider and its interpreter load from. */
  readRoots: string[]
}

/** Everything two launches need, so one profile can admit both. */
export function mergeProviderLaunches(...launches: ProviderLaunch[]): ProviderLaunch {
  return {
    executables: unique(launches.flatMap((launch) => launch.executables)),
    executableTrees: unique(launches.flatMap((launch) => launch.executableTrees)),
    readRoots: unique(launches.flatMap((launch) => launch.readRoots))
  }
}

export async function resolveProviderLaunch(
  executable: string,
  extraReadRoots: string[] = []
): Promise<ProviderLaunch> {
  const canonical = await canonicalize(executable)
  const executables = [canonical]
  const interpreter = await readInterpreter(canonical)
  for (const program of interpreter) {
    executables.push(await canonicalize(program))
  }
  const trees = [installRoot(canonical)]
  const readRoots = [
    ...executables.map(installRoot),
    ...trees,
    ...(await Promise.all(extraReadRoots.map(canonicalize)))
  ]
  return {
    executables: unique(executables),
    executableTrees: unique(trees),
    readRoots: unique(readRoots).filter((root) => root !== sep)
  }
}

/**
 * The tree a program loads from.
 *
 * A macOS bundle resolves to the bundle itself, which is where its frameworks
 * live — without them the executable cannot start at all. A versioned
 * package-manager layout (`<prefix>/Cellar/<name>/<version>/bin/x`) resolves
 * to its prefix, because that is where its libraries and configuration live.
 * Anything else resolves to the directory above `bin`.
 */
function installRoot(path: string): string {
  const bundle = path.indexOf(`.app${sep}`)
  if (bundle > 0) return path.slice(0, bundle + 4)
  const cellar = path.indexOf(`${sep}Cellar${sep}`)
  if (cellar > 0) return path.slice(0, cellar)
  const parent = dirname(path)
  return parent.endsWith(`${sep}bin`) ? dirname(parent) : parent
}

/**
 * The program named by a `#!` line, if there is one. `env` is kept as the
 * program to exec and its argument resolved on the provider's own PATH.
 */
async function readInterpreter(path: string): Promise<string[]> {
  const handle = await open(path, 'r').catch(() => null)
  if (!handle) return []
  try {
    const buffer = Buffer.alloc(256)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const first = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? ''
    if (!first.startsWith('#!')) return []
    const parts = first.slice(2).trim().split(/\s+/).filter(Boolean)
    const program = parts[0]
    if (!program) return []
    if (!program.endsWith(`${sep}env`)) return [program]
    const named = parts.find((part, index) => index > 0 && !part.startsWith('-'))
    const resolved = named ? await onPath(named, dirname(path)) : null
    return resolved ? [program, resolved] : [program]
  } finally {
    await handle.close()
  }
}

/** Resolves a bare interpreter name the way `env` will, with no shell involved. */
async function onPath(name: string, near: string): Promise<string | null> {
  const directories = [near, ...(process.env['PATH'] ?? '').split(delimiter)].filter(Boolean)
  for (const directory of directories) {
    const candidate = join(directory, name)
    const resolved = await realpath(candidate).catch(() => null)
    if (resolved) return resolved
  }
  return null
}

async function canonicalize(path: string): Promise<string> {
  return await realpath(path).catch(() => path)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
