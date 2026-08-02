import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MailboxCoreQuery, MailboxSnapshot } from '@shared/contract'
import { createCore, type Core } from './core'

const DAY_MS = 24 * 60 * 60 * 1000

let libraryDir: string
let now: Date
let core: Core

function makeCore(): Core {
  let n = 0
  return createCore({
    now: () => now,
    randomId: () => `mailbox-id-${String(++n).padStart(4, '0')}`
  })
}

function query(overrides: Partial<MailboxCoreQuery> = {}): MailboxCoreQuery {
  return { search: '', view: 'active', dormantAfterDays: 14, ...overrides }
}

function group(snapshot: MailboxSnapshot, key: string): string[] {
  return (snapshot.groups.find((g) => g.key === key)?.sessions ?? []).map(
    (session) => session.title
  )
}

beforeEach(async () => {
  libraryDir = await mkdtemp(join(tmpdir(), 'session-mailbox-'))
  now = new Date('2026-07-31T12:00:00.000Z')
  core = makeCore()
  await core.openLibrary(libraryDir)
})

afterEach(async () => {
  await rm(libraryDir, { recursive: true, force: true })
})

async function capture(title: string, notes = '') {
  return core.captureSession({ title, notes })
}

describe('pinning', () => {
  it('persists a pin in canonical frontmatter and groups pinned Sessions first', async () => {
    const pinnedSession = await capture('Pinned older Session')
    now = new Date(now.getTime() + DAY_MS)
    await capture('Newer unpinned Session')

    const updated = await core.setSessionPinned(pinnedSession.relativePath, true)
    expect(updated.pinned).toBe(true)
    const raw = await readFile(join(libraryDir, pinnedSession.relativePath, 'session.md'), 'utf8')
    expect(raw).toContain('pinned: true')

    const snapshot = await core.queryMailbox(query())
    expect(group(snapshot, 'pinned')).toEqual(['Pinned older Session'])
    expect(group(snapshot, 'recent')).toEqual(['Newer unpinned Session'])
    expect(snapshot.groups.map((g) => g.key)).toEqual([
      'pinned',
      'needs-attention',
      'running',
      'recent'
    ])
  })

  it('survives a restart and honors an external pinned edit', async () => {
    const session = await capture('Hand pinned')
    const rootPath = join(libraryDir, session.relativePath, 'session.md')
    await writeFile(
      rootPath,
      (await readFile(rootPath, 'utf8')).replace('pinned: false', 'pinned: true')
    )

    const reborn = makeCore()
    await reborn.openLibrary(libraryDir)
    const snapshot = await reborn.queryMailbox(query())
    expect(group(snapshot, 'pinned')).toEqual(['Hand pinned'])
  })

  it('unpins reversibly', async () => {
    const session = await capture('Toggle pin')
    await core.setSessionPinned(session.relativePath, true)
    const unpinned = await core.setSessionPinned(session.relativePath, false)
    expect(unpinned.pinned).toBe(false)
    const snapshot = await core.queryMailbox(query())
    expect(group(snapshot, 'pinned')).toEqual([])
    expect(group(snapshot, 'recent')).toEqual(['Toggle pin'])
  })

  it('marks a pinned Session Dormant after the configured threshold without reordering it', async () => {
    const dormantSession = await capture('Sleepy pinned Session')
    await core.setSessionPinned(dormantSession.relativePath, true)
    now = new Date(now.getTime() + 20 * DAY_MS)
    await capture('Fresh unpinned Session')

    const snapshot = await core.queryMailbox(query({ dormantAfterDays: 14 }))
    const pinnedGroup = snapshot.groups.find((g) => g.key === 'pinned')
    expect(pinnedGroup?.sessions[0]).toMatchObject({
      title: 'Sleepy pinned Session',
      dormant: true
    })
    // Still presented in the pinned group, ahead of unpinned Sessions.
    expect(snapshot.groups[0]?.key).toBe('pinned')

    const relaxed = await core.queryMailbox(query({ dormantAfterDays: 30 }))
    expect(relaxed.groups.find((g) => g.key === 'pinned')?.sessions[0]?.dormant).toBe(false)
  })
})

describe('archiving', () => {
  it('archives in place, reversibly, without moving canonical content', async () => {
    const session = await capture('Archivable Session', 'Some notes to keep.')
    const before = await readdir(join(libraryDir, session.relativePath), { recursive: true })

    const archived = await core.setSessionArchived(session.relativePath, true)
    expect(archived.archivedAt).toBe(now.toISOString())
    const raw = await readFile(join(libraryDir, session.relativePath, 'session.md'), 'utf8')
    expect(raw).toContain(`archived: ${now.toISOString()}`)
    const after = await readdir(join(libraryDir, session.relativePath), { recursive: true })
    expect(after.filter((f) => !f.startsWith('.session'))).toEqual(
      before.filter((f) => !f.startsWith('.session'))
    )

    const active = await core.queryMailbox(query())
    expect(active.matched).toBe(0)
    const archivedView = await core.queryMailbox(query({ view: 'archived' }))
    expect(group(archivedView, 'archived')).toEqual(['Archivable Session'])

    const restored = await core.setSessionArchived(session.relativePath, false)
    expect(restored.archivedAt).toBeNull()
    const activeAgain = await core.queryMailbox(query())
    expect(group(activeAgain, 'recent')).toEqual(['Archivable Session'])
  })

  it('keeps archive state across restarts from canonical content alone', async () => {
    const session = await capture('Stays archived')
    await core.setSessionArchived(session.relativePath, true)

    const reborn = makeCore()
    await reborn.openLibrary(libraryDir)
    const active = await reborn.queryMailbox(query())
    expect(active.total).toBe(0)
    const archivedView = await reborn.queryMailbox(query({ view: 'archived' }))
    expect(group(archivedView, 'archived')).toEqual(['Stays archived'])
  })
})

describe('search and filters', () => {
  beforeEach(async () => {
    await capture('Offline recipe planner', 'Plans weekly meals without accounts.')
    now = new Date(now.getTime() + 1000)
    await capture('Community tool library', 'Neighbors share rarely used tools.')
  })

  it('matches title and body text', async () => {
    const byTitle = await core.queryMailbox(query({ search: 'recipe' }))
    expect(group(byTitle, 'recent')).toEqual(['Offline recipe planner'])
    const byBody = await core.queryMailbox(query({ search: 'neighbors share' }))
    expect(group(byBody, 'recent')).toEqual(['Community tool library'])
  })

  it('distinguishes no results from an empty library', async () => {
    const snapshot = await core.queryMailbox(query({ search: 'zeppelin' }))
    expect(snapshot.total).toBe(2)
    expect(snapshot.matched).toBe(0)
  })

  it('treats a LIKE wildcard in the search as literal text', async () => {
    const snapshot = await core.queryMailbox(query({ search: '%' }))
    expect(snapshot.matched).toBe(0)
  })
})

describe('the rebuildable index', () => {
  it('answers identically after the index is deleted', async () => {
    await capture('Index survivor', 'Canonical content is the truth.')
    const before = await core.queryMailbox(query({ search: 'canonical' }))
    await rm(join(libraryDir, '.index'), { recursive: true, force: true })
    const after = await core.queryMailbox(query({ search: 'canonical' }))
    expect(after.groups).toEqual(before.groups)
    expect(after.index).toBe('rebuilt')
  })

  it('answers identically after the index is corrupted', async () => {
    const session = await capture('Corruption survivor')
    await core.setSessionPinned(session.relativePath, true)
    const before = await core.queryMailbox(query())
    await writeFile(join(libraryDir, '.index', 'mailbox.sqlite'), 'not a database at all')
    const after = await core.queryMailbox(query())
    expect(after.groups).toEqual(before.groups)
    expect(after.index).toBe('rebuilt')
  })

  it('does not list the private index folder as a Session', async () => {
    await capture('Only Session')
    await core.queryMailbox(query())
    const snapshot = await makeCore().openLibrary(libraryDir)
    expect(snapshot.sessions.map((session) => session.title)).toEqual(['Only Session'])
  })
})

describe('permanent delete preview', () => {
  it('targets the whole folder when it only holds app-owned content', async () => {
    const session = await capture('Cleanly deletable')
    const preview = await core.previewDeleteSession(session.relativePath)
    expect(preview.title).toBe('Cleanly deletable')
    expect(preview.targets).toEqual([session.relativePath])
    expect(preview.keeps).toEqual([])
  })

  it('targets only app-owned files when the folder holds foreign content', async () => {
    const session = await capture('Shared folder Session')
    await writeFile(join(libraryDir, session.relativePath, 'my-own-notes.md'), 'user content')
    const preview = await core.previewDeleteSession(session.relativePath)
    expect(preview.targets.sort()).toEqual([
      `${session.relativePath}/.session`,
      `${session.relativePath}/conversation.md`,
      `${session.relativePath}/session.md`
    ])
    expect(preview.keeps).toEqual([`${session.relativePath}/my-own-notes.md`])
  })

  it('refuses to preview an unknown Session', async () => {
    await expect(core.previewDeleteSession('nowhere')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND'
    })
  })
})
