import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  confirmProjectSkillsTrust,
  diffProjectSkillManifests,
  discoverSkills,
  observeProjectSkills
} from './skills'

/**
 * Skill discovery, against real directories. A Skill is instruction text that
 * steers an agent with write and command access, so what this suite is really
 * about is which text the app is willing to offer and whose it is.
 */

let home: string
let project: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'skills-home-'))
  project = await mkdtemp(join(tmpdir(), 'skills-project-'))
})

afterEach(async () => {
  await Promise.all([home, project].map((path) => rm(path, { recursive: true, force: true })))
})

async function install(
  root: string,
  name: string,
  body = `---\nname: ${name}\ndescription: Does ${name} properly\n---\n\nSteps…\n`
): Promise<void> {
  const directory = join(root, '.claude', 'skills', name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), body)
}

function discover(projectTrusted = false): ReturnType<typeof discoverSkills> {
  return discoverSkills({
    homeDirectory: home,
    projectRoot: project,
    harness: 'claude',
    projectTrusted
  })
}

describe('what is installed', () => {
  it('finds the Skills in the directory the Harness itself reads', async () => {
    await install(home, 'tdd')
    await install(home, 'diagnosing-bugs')

    const catalog = await discover()
    expect(catalog.available).toMatchObject([
      { name: 'diagnosing-bugs', source: 'global', harness: 'claude' },
      { name: 'tdd', source: 'global', description: 'Does tdd properly' }
    ])
  })

  it('says nothing at all when nothing is installed', async () => {
    // Skills are optional. Nothing installed is a perfectly ordinary machine.
    expect(await discover()).toMatchObject({ available: [], untrusted: [] })
  })

  it('ignores a directory that is not a Skill', async () => {
    await mkdir(join(home, '.claude', 'skills', 'not-a-skill'), { recursive: true })
    await writeFile(join(home, '.claude', 'skills', 'loose.md'), '# not a directory')
    await install(home, 'tdd')

    expect((await discover()).available.map((skill) => skill.name)).toEqual(['tdd'])
  })

  it('takes the description as text, bounded, and survives having none', async () => {
    await install(home, 'terse', '# No frontmatter here\n')
    await install(home, 'wordy', `---\ndescription: "${'x'.repeat(900)}"\n---\n`)

    const [terse, wordy] = (await discover()).available
    expect(terse?.description).toBe('')
    expect(wordy?.description).toHaveLength(500)
  })
})

describe("the Project's own Skills", () => {
  it('are found and deliberately not offered until they are trusted', async () => {
    await install(home, 'tdd')
    await install(project, 'deploy-to-prod')

    const untrusted = await discover(false)
    // Shown, so the decision is made with them in front of the person.
    expect(untrusted.untrusted).toMatchObject([{ name: 'deploy-to-prod', source: 'project' }])
    expect(untrusted.available.map((skill) => skill.name)).toEqual(['tdd'])

    const trusted = await discover(true)
    expect(trusted.untrusted).toEqual([])
    expect(trusted.available.map((skill) => skill.name)).toEqual(['deploy-to-prod', 'tdd'])
  })

  it('shadow a global Skill of the same name only once trusted', async () => {
    await install(home, 'tdd', '---\ndescription: The global one\n---\n')
    await install(project, 'tdd', '---\ndescription: The repository’s own\n---\n')

    expect((await discover(false)).available).toMatchObject([{ description: 'The global one' }])
    expect((await discover(true)).available).toMatchObject([
      { description: 'The repository’s own', source: 'project' }
    ])
  })
})

describe('Project-wide Skill trust content', () => {
  it('has the same digest regardless of enumeration order and ignores global Skills', async () => {
    const other = await mkdtemp(join(tmpdir(), 'skills-project-order-'))
    try {
      await install(project, 'alpha')
      await writeFile(join(project, '.claude', 'skills', 'alpha', 'script.sh'), 'one')
      await install(project, 'beta')

      await install(other, 'beta')
      await install(other, 'alpha')
      await writeFile(join(other, '.claude', 'skills', 'alpha', 'script.sh'), 'one')

      const beforeGlobal = await observeProjectSkills(project)
      await install(home, 'global-only')
      const afterGlobal = await observeProjectSkills(project)
      const reordered = await observeProjectSkills(other)

      expect(beforeGlobal).toMatchObject({ status: 'ok' })
      expect(afterGlobal).toEqual(beforeGlobal)
      expect(reordered).toEqual(beforeGlobal)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it('changes when any nested file changes and covers both Harness locations', async () => {
    await install(project, 'claude-skill')
    const codexDirectory = join(project, '.agents', 'skills', 'codex-skill')
    await mkdir(join(codexDirectory, 'templates'), { recursive: true })
    await writeFile(join(codexDirectory, 'SKILL.md'), '# Codex')
    await writeFile(join(codexDirectory, 'templates', 'prompt.md'), 'first')
    const first = await observeProjectSkills(project)

    await writeFile(join(codexDirectory, 'templates', 'prompt.md'), 'second')
    const second = await observeProjectSkills(project)

    expect(first).toMatchObject({
      status: 'ok',
      manifest: [
        { harness: 'claude', name: 'claude-skill' },
        { harness: 'codex', name: 'codex-skill' }
      ]
    })
    expect(second).toMatchObject({ status: 'ok' })
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('observation failed')
    expect(second.digest).not.toBe(first.digest)
    expect(second.manifest[1]?.digest).not.toBe(first.manifest[1]?.digest)
  })

  it('names unsupported and over-limit trees instead of treating them as no Skills', async () => {
    await install(project, 'unsafe')
    await symlink('SKILL.md', join(project, '.claude', 'skills', 'unsafe', 'alias.md'))
    await expect(observeProjectSkills(project)).resolves.toEqual({
      status: 'error',
      reason: 'unsupported'
    })

    await rm(join(project, '.claude', 'skills', 'unsafe', 'alias.md'))
    await writeFile(join(project, '.claude', 'skills', 'unsafe', 'extra.md'), 'extra')
    await expect(observeProjectSkills(project, { maxFiles: 1, maxBytes: 1_000 })).resolves.toEqual({
      status: 'error',
      reason: 'over-limit'
    })
  })

  it('does not follow a symlink used as a Harness Skill root or Skill entry', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'skills-outside-'))
    try {
      await install(outside, 'external')
      await mkdir(join(project, '.agents'), { recursive: true })
      await symlink(join(outside, '.claude', 'skills'), join(project, '.agents', 'skills'))
      await expect(observeProjectSkills(project)).resolves.toEqual({
        status: 'error',
        reason: 'unsupported'
      })

      await rm(join(project, '.agents', 'skills'))
      await mkdir(join(project, '.agents', 'skills'), { recursive: true })
      await symlink(
        join(outside, '.claude', 'skills', 'external'),
        join(project, '.agents', 'skills', 'external')
      )
      await expect(observeProjectSkills(project)).resolves.toEqual({
        status: 'error',
        reason: 'unsupported'
      })
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('bounds directory entries and depth as well as files and bytes', async () => {
    await install(project, 'deep')
    await mkdir(join(project, '.claude', 'skills', 'deep', 'a', 'b'), { recursive: true })

    await expect(
      observeProjectSkills(project, {
        maxFiles: 10,
        maxBytes: 1_000,
        maxEntries: 2,
        maxDepth: 20
      })
    ).resolves.toEqual({ status: 'error', reason: 'over-limit' })
    await expect(
      observeProjectSkills(project, {
        maxFiles: 10,
        maxBytes: 1_000,
        maxEntries: 20,
        maxDepth: 1
      })
    ).resolves.toEqual({ status: 'error', reason: 'over-limit' })
  })

  it('refuses a grant when content changes after the review', async () => {
    await install(project, 'reviewed')
    const reviewed = await observeProjectSkills(project)
    expect(reviewed).toMatchObject({ status: 'ok' })
    if (reviewed.status !== 'ok') return

    await writeFile(join(project, '.claude', 'skills', 'reviewed', 'SKILL.md'), '# changed')

    await expect(confirmProjectSkillsTrust(project, reviewed.digest)).rejects.toThrow(
      'changed after review'
    )
  })

  it('classifies added, removed, and changed Skills by Harness and name', () => {
    const digest = (character: string): string => character.repeat(64)
    expect(
      diffProjectSkillManifests(
        [
          { harness: 'claude', name: 'removed', digest: digest('a') },
          { harness: 'codex', name: 'changed', digest: digest('b') }
        ],
        [
          { harness: 'claude', name: 'added', digest: digest('c') },
          { harness: 'codex', name: 'changed', digest: digest('d') }
        ]
      )
    ).toEqual({
      added: [{ harness: 'claude', name: 'added' }],
      removed: [{ harness: 'claude', name: 'removed' }],
      changed: [{ harness: 'codex', name: 'changed' }]
    })
  })
})
