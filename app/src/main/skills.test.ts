import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverSkills } from './skills'

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
