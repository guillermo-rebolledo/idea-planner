import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { skillNameSchema } from '@shared/run'
import type { HarnessId } from '@shared/readiness'
import type { Skill, SkillCatalog, SkillSource } from '@shared/skill'
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
    projectTrusted: options.projectTrusted
  }
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
