import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type Core } from './core'

let stateDir: string
let projectRoot: string
let core: Core

function makeCore(): Core {
  let tick = 0
  let id = 0
  return createCore({
    stateDirectory: stateDir,
    now: () => new Date(Date.UTC(2026, 6, 31, 12, 0, tick++)),
    randomId: () => `session-${String(++id).padStart(4, '0')}`
  })
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'app-state-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'a-project-'))
  await mkdir(join(projectRoot, '.git'))
  core = makeCore()
  await core.addProject(projectRoot)
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

describe('Sessions', () => {
  it('starts a Session against a Project and gives it an id, not a path', async () => {
    const session = await core.startSession({ projectRoot, title: 'Fix the failing build' })

    expect(session).toMatchObject({
      id: 'session-0001',
      projectRoot,
      title: 'Fix the failing build'
    })
    expect(JSON.stringify(session)).not.toContain('relativePath')
    await expect(core.listSessions()).resolves.toEqual([session])
  })

  it('refuses to start a Session without a Project', async () => {
    await expect(
      core.startSession({ projectRoot: join(tmpdir(), 'never-added'), title: 'Nowhere' })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('writes nothing into the Project', async () => {
    await core.startSession({ projectRoot, title: 'Leaves no trace' })

    // Work lives in the Project; the record of asking for it does not.
    await expect(readFile(join(projectRoot, 'session.md'), 'utf8')).rejects.toBeDefined()
    expect(await listing(projectRoot)).toEqual(['.git'])
  })

  it('keeps Sessions across a restart', async () => {
    const session = await core.startSession({ projectRoot, title: 'Survives' })

    await expect(makeCore().listSessions()).resolves.toEqual([session])
  })

  it('never lists a Session whose record was only half written', async () => {
    const kept = await core.startSession({ projectRoot, title: 'Whole' })
    const torn = await core.startSession({ projectRoot, title: 'Half written' })
    // A crash mid-write, modelled as the truncation it would leave behind.
    await writeFile(join(stateDir, 'sessions', torn.id, 'session.json'), '{"id":"session-')

    const listed = await makeCore().listSessions()

    // The whole Session is still there, and the torn one is reported, never
    // silently dropped.
    expect(listed).toEqual([kept])
    await expect(makeCore().listDamagedSessions()).resolves.toEqual([torn.id])
  })

  it('archives and unarchives a Session by id', async () => {
    const session = await core.startSession({ projectRoot, title: 'Done with this' })

    const archived = await core.setSessionArchived(session.id, true)
    expect(archived.archivedAt).not.toBeNull()
    await expect(core.setSessionArchived(session.id, false)).resolves.toMatchObject({
      archivedAt: null
    })
  })

  it('deletes a Session from the store and leaves the Project alone', async () => {
    await writeFile(join(projectRoot, 'source.ts'), 'export const kept = true')
    const session = await core.startSession({ projectRoot, title: 'Delete me' })

    await core.deleteSession(session.id)

    await expect(core.listSessions()).resolves.toEqual([])
    expect((await listing(projectRoot)).sort()).toEqual(['.git', 'source.ts'])
  })
})

async function listing(path: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  return (await readdir(path)).sort()
}

describe('the Conversation journal', () => {
  it('keeps the messages before a torn line rather than losing the Conversation', async () => {
    const session = await core.startSession({ projectRoot, title: 'Journalled' })
    await core.submitConversationMessage({
      sessionId: session.id,
      submissionId: 'first',
      text: 'The first thing I asked',
      source: 'composer'
    })
    await core.submitConversationMessage({
      sessionId: session.id,
      submissionId: 'second',
      text: 'The second thing I asked',
      source: 'composer'
    })

    // A crash mid-append leaves a line that never finished.
    const journal = join(stateDir, 'sessions', session.id, 'conversation.jsonl')
    await writeFile(journal, `${await readFile(journal, 'utf8')}{"kind":"messa`, 'utf8')

    const snapshot = await makeCore().getConversation(session.id)

    const said = snapshot.entries.flatMap((entry) => (entry.kind === 'message' ? [entry.text] : []))
    expect(said).toEqual(['The first thing I asked', 'The second thing I asked'])
  })
})

describe('a store that cannot be read', () => {
  it('fails loudly rather than reporting that there are no Sessions', async () => {
    await core.startSession({ projectRoot, title: 'Exists' })
    // An unreadable store is not an empty one. Answering "no Sessions" here is
    // the vanishing-without-a-word failure this store exists to prevent.
    await rm(join(stateDir, 'sessions'), { recursive: true, force: true })
    await writeFile(join(stateDir, 'sessions'), 'not a directory')

    await expect(makeCore().listSessions()).rejects.toMatchObject({ code: 'IO_ERROR' })
  })

  it('orders Sessions newest first', async () => {
    await core.startSession({ projectRoot, title: 'First' })
    await core.startSession({ projectRoot, title: 'Second' })

    await expect(makeCore().listSessions()).resolves.toMatchObject([
      { title: 'Second' },
      { title: 'First' }
    ])
  })

  it('ignores stray files beside the Sessions without failing', async () => {
    const session = await core.startSession({ projectRoot, title: 'Real' })
    await writeFile(join(stateDir, 'sessions', '.DS_Store'), 'junk')

    await expect(makeCore().listSessions()).resolves.toEqual([session])
    await expect(makeCore().listDamagedSessions()).resolves.toEqual([])
  })
})
