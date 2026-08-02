import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type Core } from './core'

let stateDir: string
let projectRoot: string
let core: Core

function makeCore(): Core {
  let tick = 0
  return createCore({
    stateDirectory: stateDir,
    now: () => new Date(Date.UTC(2026, 6, 31, 12, 0, tick++))
  })
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'app-state-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'a-project-'))
  await mkdir(join(projectRoot, '.git'))
  core = makeCore()
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

describe('Projects', () => {
  it('adds a Project and lists it by the root git resolved', async () => {
    const added = await core.addProject(projectRoot)
    expect(added).toMatchObject({ root: projectRoot, available: true })
    await expect(core.listProjects()).resolves.toEqual([added])
  })

  it('adds the same Project once, however many times it is offered', async () => {
    const first = await core.addProject(projectRoot)
    const second = await core.addProject(projectRoot)

    expect(second.addedAt).toBe(first.addedAt)
    await expect(core.listProjects()).resolves.toHaveLength(1)
  })

  it('reports a Project whose directory has gone as unavailable', async () => {
    await core.addProject(projectRoot)
    await rm(projectRoot, { recursive: true, force: true })

    const listed = await core.listProjects()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ root: projectRoot, available: false })
  })

  it('removes a Project without touching the directory on disk', async () => {
    await writeFile(join(projectRoot, 'source.ts'), 'export const kept = true')
    await core.addProject(projectRoot)

    await core.removeProject(projectRoot)

    await expect(core.listProjects()).resolves.toEqual([])
    expect((await readdir(projectRoot)).sort()).toEqual(['.git', 'source.ts'])
  })

  it('keeps Projects across a restart', async () => {
    await core.addProject(projectRoot)

    await expect(makeCore().listProjects()).resolves.toMatchObject([{ root: projectRoot }])
  })

  it('rejects a root that is not an absolute path', async () => {
    await expect(core.addProject('a-project')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('fails loudly when the store cannot be read, rather than reporting no Projects', async () => {
    await core.addProject(projectRoot)
    // Unreadable is not the same as absent. Answering "no Projects" here would
    // let the next add overwrite a store we could not read.
    await rm(join(stateDir, 'projects.json'))
    await mkdir(join(stateDir, 'projects.json'))

    await expect(core.listProjects()).rejects.toMatchObject({ code: 'IO_ERROR' })
  })

  it('refuses to guess a state directory when none is configured', async () => {
    // Writing the Project list somewhere nobody chose is worse than not
    // writing it, because the user is never told.
    await expect(createCore({}).listProjects()).rejects.toMatchObject({ code: 'IO_ERROR' })
  })
})
