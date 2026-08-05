import { createHash, type Hash } from 'node:crypto'
import { createReadStream, type Dirent } from 'node:fs'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { skillNameSchema } from '@shared/run'
import type { HarnessId } from '@shared/readiness'
import type { Skill, SkillCatalog, SkillSource } from '@shared/skill'
import type { ProjectSkillDigest, ProjectSkillsTrust } from '@shared/project'
import { HARNESS_SPECS } from './readiness'

/**
 * Skill discovery. Each Harness documents one directory it reads Skills from,
 * and this reads the same one: `~/.claude/skills` for Claude Code,
 * `~/.agents/skills` for Codex, and the same two names inside the Project.
 *
 * This enumerates those directories, which readiness deliberately does not do
 * for executables. The difference is that a Skill *is* a directory entry —
 * there is no name to resolve, and the Harness itself finds them the same way
 * — whereas an executable has an exact name and enumerating for it is how a
 * program nobody asked for gets run.
 */

/** A Skill is a directory holding this file. Anything else is not one. */
const MANIFEST = 'SKILL.md'

/** Enough of a Skill to describe it; the rest is the Harness's business. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/
const DESCRIPTION = /^description:\s*(.+)$/m

/** A Project cannot make trust observation unbounded by filling its Skill roots. */
export const PROJECT_SKILL_LIMITS = {
  maxSkills: 500,
  maxFiles: 10_000,
  maxBytes: 100 * 1024 * 1024,
  maxEntries: 20_000,
  maxDepth: 64
} as const

export type ProjectSkillObservation =
  | { status: 'ok'; digest: string; manifest: ProjectSkillDigest[] }
  | { status: 'error'; reason: 'unreadable' | 'unsupported' | 'cyclic' | 'over-limit' }

interface ObservationBudget {
  files: number
  bytes: number
  maxFiles: number
  maxBytes: number
  maxEntries: number
  maxDepth: number
  entries: number
}

class ObservationFailure extends Error {
  constructor(readonly reason: Extract<ProjectSkillObservation, { status: 'error' }>['reason']) {
    super(reason)
  }
}

export interface DiscoverSkillsOptions {
  homeDirectory: string
  projectRoot: string
  harness: HarnessId
  /** False keeps the Project's own Skills out of what a Run may use. */
  projectTrusted: boolean
}

/** What this machine has installed for a Harness, wherever it is working. */
export async function discoverGlobalSkills(
  homeDirectory: string,
  harness: HarnessId
): Promise<Skill[]> {
  return read(join(homeDirectory, HARNESS_SPECS[harness].skillsRoot), 'global', harness)
}

export async function discoverSkills(options: DiscoverSkillsOptions): Promise<SkillCatalog> {
  const root = HARNESS_SPECS[options.harness].skillsRoot
  const [global, project] = await Promise.all([
    discoverGlobalSkills(options.homeDirectory, options.harness),
    read(join(options.projectRoot, root), 'project', options.harness)
  ])
  // A Project Skill of the same name shadows a global one only once trusted,
  // because that is the whole of what trusting it means.
  const available = options.projectTrusted ? merge(global, project) : global
  return {
    available,
    untrusted: options.projectTrusted ? [] : project,
    projectTrusted: options.projectTrusted,
    reviewedDigest: null,
    projectTrustError: null,
    changes: { added: [], removed: [], changed: [] }
  }
}

/**
 * Observes every Project Skill supported by either Harness as one trust unit.
 * Paths are relative and sorted, so directory enumeration and Project location
 * cannot affect the result. Symlinks and special files are rejected rather
 * than followed or silently omitted.
 */
export async function observeProjectSkills(
  projectRoot: string,
  limits: {
    maxSkills?: number
    maxFiles: number
    maxBytes: number
    maxEntries?: number
    maxDepth?: number
  } = PROJECT_SKILL_LIMITS
): Promise<ProjectSkillObservation> {
  const budget: ObservationBudget = {
    files: 0,
    bytes: 0,
    entries: 0,
    maxEntries: limits.maxEntries ?? PROJECT_SKILL_LIMITS.maxEntries,
    maxDepth: limits.maxDepth ?? PROJECT_SKILL_LIMITS.maxDepth,
    ...limits
  }
  try {
    const manifest: ProjectSkillDigest[] = []
    for (const harness of ['claude', 'codex'] as const) {
      const skillsRoot = join(projectRoot, HARNESS_SPECS[harness].skillsRoot)
      const entries = await readSkillsRoot(skillsRoot)
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new ObservationFailure('unsupported')
        if (!entry.isDirectory()) continue
        const name = skillNameSchema.safeParse(entry.name)
        if (!name.success) continue
        const directory = join(skillsRoot, entry.name)
        const skillManifest = await lstat(join(directory, MANIFEST)).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null
          throw new ObservationFailure('unreadable')
        })
        if (skillManifest === null) continue
        if (!skillManifest.isFile()) throw new ObservationFailure('unsupported')
        if (manifest.length >= (limits.maxSkills ?? PROJECT_SKILL_LIMITS.maxSkills)) {
          throw new ObservationFailure('over-limit')
        }
        manifest.push({
          harness,
          name: name.data,
          digest: await digestTree(directory, budget)
        })
      }
    }
    manifest.sort((left, right) =>
      compareText(`${left.harness}/${left.name}`, `${right.harness}/${right.name}`)
    )
    const hash = createHash('sha256')
    hashField(hash, 'project-skills-v1')
    for (const skill of manifest) {
      hashField(hash, skill.harness)
      hashField(hash, skill.name)
      hashField(hash, skill.digest)
    }
    return { status: 'ok', digest: hash.digest('hex'), manifest }
  } catch (error) {
    if (error instanceof ObservationFailure) return { status: 'error', reason: error.reason }
    return { status: 'error', reason: 'unreadable' }
  }
}

/** Re-observes the reviewed tree at the last possible moment before storage. */
export async function confirmProjectSkillsTrust(
  projectRoot: string,
  reviewedDigest: string
): Promise<ProjectSkillsTrust> {
  const observed = await observeProjectSkills(projectRoot)
  if (observed.status === 'error') {
    throw new Error(`Project Skills could not be trusted: ${observed.reason}`)
  }
  if (observed.digest !== reviewedDigest) {
    throw new Error('Project Skills changed after review; review them again before trusting')
  }
  return { digest: observed.digest, manifest: observed.manifest }
}

export function diffProjectSkillManifests(
  trusted: ProjectSkillDigest[],
  observed: ProjectSkillDigest[]
): SkillCatalog['changes'] {
  const key = (skill: Pick<ProjectSkillDigest, 'harness' | 'name'>): string =>
    `${skill.harness}/${skill.name}`
  const before = new Map(trusted.map((skill) => [key(skill), skill]))
  const after = new Map(observed.map((skill) => [key(skill), skill]))
  const identity = (
    skill: Pick<ProjectSkillDigest, 'harness' | 'name'>
  ): Pick<ProjectSkillDigest, 'harness' | 'name'> => ({
    harness: skill.harness,
    name: skill.name
  })
  return {
    added: observed.filter((skill) => !before.has(key(skill))).map(identity),
    removed: trusted.filter((skill) => !after.has(key(skill))).map(identity),
    changed: observed
      .filter((skill) => {
        const prior = before.get(key(skill))
        return prior !== undefined && prior.digest !== skill.digest
      })
      .map(identity)
  }
}

async function digestTree(directory: string, budget: ObservationBudget): Promise<string> {
  const hash = createHash('sha256')
  const visited = new Set<string>()
  hashField(hash, 'project-skill-tree-v1')
  await visit(directory, directory, hash, budget, visited, 0)
  return hash.digest('hex')
}

async function visit(
  root: string,
  path: string,
  hash: Hash,
  budget: ObservationBudget,
  visited: Set<string>,
  depth: number
): Promise<void> {
  budget.entries += 1
  if (budget.entries > budget.maxEntries || depth > budget.maxDepth) {
    throw new ObservationFailure('over-limit')
  }
  const info = await lstat(path).catch(() => {
    throw new ObservationFailure('unreadable')
  })
  const normalized = path === root ? '.' : relative(root, path).split(sep).join('/')
  if (info.isSymbolicLink()) throw new ObservationFailure('unsupported')
  if (info.isDirectory()) {
    const identity = `${String(info.dev)}:${String(info.ino)}`
    if (visited.has(identity)) throw new ObservationFailure('cyclic')
    visited.add(identity)
    hashEntry(hash, normalized, 'directory', 0)
    const entries = await readDirectory(path)
    for (const entry of entries) {
      await visit(root, join(path, entry.name), hash, budget, visited, depth + 1)
    }
    visited.delete(identity)
    return
  }
  if (!info.isFile()) throw new ObservationFailure('unsupported')
  budget.files += 1
  budget.bytes += info.size
  if (budget.files > budget.maxFiles || budget.bytes > budget.maxBytes) {
    throw new ObservationFailure('over-limit')
  }
  hashEntry(hash, normalized, 'file', info.size)
  let bytesRead = 0
  try {
    for await (const chunk of createReadStream(path)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytesRead += bytes.length
      if (budget.bytes - info.size + bytesRead > budget.maxBytes) {
        throw new ObservationFailure('over-limit')
      }
      if (bytesRead > info.size) throw new ObservationFailure('unreadable')
      hash.update(bytes)
    }
  } catch (error) {
    if (error instanceof ObservationFailure) throw error
    throw new ObservationFailure('unreadable')
  }
  if (bytesRead !== info.size) throw new ObservationFailure('unreadable')
}

async function readSkillsRoot(directory: string): Promise<Dirent[]> {
  const info = await lstat(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null
    throw new ObservationFailure('unreadable')
  })
  if (info === null) return []
  if (info.isSymbolicLink() || !info.isDirectory()) throw new ObservationFailure('unsupported')
  return readDirectory(directory)
}

async function readDirectory(directory: string): Promise<Dirent[]> {
  try {
    return (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareText(left.name, right.name)
    )
  } catch {
    throw new ObservationFailure('unreadable')
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function hashEntry(hash: Hash, path: string, type: 'directory' | 'file', length: number): void {
  hashField(hash, path)
  hashField(hash, type)
  hashField(hash, String(length))
}

function hashField(hash: Hash, value: string): void {
  const bytes = Buffer.from(value)
  hash.update(String(bytes.length))
  hash.update(':')
  hash.update(bytes)
}

/** The Skills in one directory, in a stable order, ignoring anything else. */
async function read(directory: string, source: SkillSource, harness: HarnessId): Promise<Skill[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const found: Skill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // The name is the directory's, and it has to be one this app can carry
    // through a Run configuration unchanged.
    const name = skillNameSchema.safeParse(entry.name)
    if (!name.success) continue
    const path = join(directory, entry.name)
    const manifest = join(path, MANIFEST)
    const readable = await stat(manifest).then(
      (info) => info.isFile(),
      () => false
    )
    if (!readable) continue
    found.push({
      name: name.data,
      path,
      source,
      harness,
      description: await describe(manifest)
    })
  }
  return found.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * What the Skill says it is for, from its own frontmatter. Bounded and taken
 * as text: it is written by whoever wrote the Skill, and it is shown to the
 * person rather than acted on.
 */
async function describe(manifest: string): Promise<string> {
  const head = await readFile(manifest, 'utf8').then(
    (text) => text.slice(0, 4_000),
    () => ''
  )
  const frontmatter = FRONTMATTER.exec(head)?.[1] ?? ''
  const described = DESCRIPTION.exec(frontmatter)?.[1] ?? ''
  return described
    .trim()
    .replace(/^["']|["']$/g, '')
    .slice(0, 500)
}

function merge(global: Skill[], project: Skill[]): Skill[] {
  const byName = new Map(global.map((skill) => [skill.name, skill]))
  for (const skill of project) byName.set(skill.name, skill)
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
}
