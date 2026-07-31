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
  return { search: '', kind: 'all', view: 'active', dormantAfterDays: 14, ...overrides }
}

function group(snapshot: MailboxSnapshot, key: string): string[] {
  return (snapshot.groups.find((g) => g.key === key)?.ideas ?? []).map((idea) => idea.title)
}

beforeEach(async () => {
  libraryDir = await mkdtemp(join(tmpdir(), 'idea-mailbox-'))
  now = new Date('2026-07-31T12:00:00.000Z')
  core = makeCore()
  await core.openLibrary(libraryDir)
})

afterEach(async () => {
  await rm(libraryDir, { recursive: true, force: true })
})

async function capture(title: string, kind: 'software' | 'general' = 'software', notes = '') {
  return core.captureIdea({ kind, title, notes })
}

describe('pinning', () => {
  it('persists a pin in canonical frontmatter and groups pinned Ideas first', async () => {
    const pinnedIdea = await capture('Pinned older idea')
    now = new Date(now.getTime() + DAY_MS)
    await capture('Newer unpinned idea')

    const updated = await core.setIdeaPinned(pinnedIdea.relativePath, true)
    expect(updated.pinned).toBe(true)
    const raw = await readFile(join(libraryDir, pinnedIdea.relativePath, 'idea.md'), 'utf8')
    expect(raw).toContain('pinned: true')

    const snapshot = await core.queryMailbox(query())
    expect(group(snapshot, 'pinned')).toEqual(['Pinned older idea'])
    expect(group(snapshot, 'recent')).toEqual(['Newer unpinned idea'])
    expect(snapshot.groups.map((g) => g.key)).toEqual([
      'pinned',
      'needs-attention',
      'running',
      'recent'
    ])
  })

  it('survives a restart and honors an external pinned edit', async () => {
    const idea = await capture('Hand pinned')
    const rootPath = join(libraryDir, idea.relativePath, 'idea.md')
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
    const idea = await capture('Toggle pin')
    await core.setIdeaPinned(idea.relativePath, true)
    const unpinned = await core.setIdeaPinned(idea.relativePath, false)
    expect(unpinned.pinned).toBe(false)
    const snapshot = await core.queryMailbox(query())
    expect(group(snapshot, 'pinned')).toEqual([])
    expect(group(snapshot, 'recent')).toEqual(['Toggle pin'])
  })

  it('marks a pinned Idea Dormant after the configured threshold without reordering it', async () => {
    const dormantIdea = await capture('Sleepy pinned idea')
    await core.setIdeaPinned(dormantIdea.relativePath, true)
    now = new Date(now.getTime() + 20 * DAY_MS)
    await capture('Fresh unpinned idea')

    const snapshot = await core.queryMailbox(query({ dormantAfterDays: 14 }))
    const pinnedGroup = snapshot.groups.find((g) => g.key === 'pinned')
    expect(pinnedGroup?.ideas[0]).toMatchObject({ title: 'Sleepy pinned idea', dormant: true })
    // Still presented in the pinned group, ahead of unpinned Ideas.
    expect(snapshot.groups[0]?.key).toBe('pinned')

    const relaxed = await core.queryMailbox(query({ dormantAfterDays: 30 }))
    expect(relaxed.groups.find((g) => g.key === 'pinned')?.ideas[0]?.dormant).toBe(false)
  })
})

describe('archiving', () => {
  it('archives in place, reversibly, without moving canonical content', async () => {
    const idea = await capture('Archivable idea', 'general', 'Some notes to keep.')
    const before = await readdir(join(libraryDir, idea.relativePath), { recursive: true })

    const archived = await core.setIdeaArchived(idea.relativePath, true)
    expect(archived.archivedAt).toBe(now.toISOString())
    const raw = await readFile(join(libraryDir, idea.relativePath, 'idea.md'), 'utf8')
    expect(raw).toContain(`archived: ${now.toISOString()}`)
    const after = await readdir(join(libraryDir, idea.relativePath), { recursive: true })
    expect(after.filter((f) => !f.startsWith('.idea'))).toEqual(
      before.filter((f) => !f.startsWith('.idea'))
    )

    const active = await core.queryMailbox(query())
    expect(active.matched).toBe(0)
    const archivedView = await core.queryMailbox(query({ view: 'archived' }))
    expect(group(archivedView, 'archived')).toEqual(['Archivable idea'])

    const restored = await core.setIdeaArchived(idea.relativePath, false)
    expect(restored.archivedAt).toBeNull()
    const activeAgain = await core.queryMailbox(query())
    expect(group(activeAgain, 'recent')).toEqual(['Archivable idea'])
  })

  it('keeps archive state across restarts from canonical content alone', async () => {
    const idea = await capture('Stays archived')
    await core.setIdeaArchived(idea.relativePath, true)

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
    await capture('Offline recipe planner', 'software', 'Plans weekly meals without accounts.')
    now = new Date(now.getTime() + 1000)
    await capture('Community tool library', 'general', 'Neighbors share rarely used tools.')
  })

  it('matches title and body text', async () => {
    const byTitle = await core.queryMailbox(query({ search: 'recipe' }))
    expect(group(byTitle, 'recent')).toEqual(['Offline recipe planner'])
    const byBody = await core.queryMailbox(query({ search: 'neighbors share' }))
    expect(group(byBody, 'recent')).toEqual(['Community tool library'])
  })

  it('filters by kind', async () => {
    const software = await core.queryMailbox(query({ kind: 'software' }))
    expect(group(software, 'recent')).toEqual(['Offline recipe planner'])
    const general = await core.queryMailbox(query({ kind: 'general' }))
    expect(group(general, 'recent')).toEqual(['Community tool library'])
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
    await capture('Index survivor', 'software', 'Canonical content is the truth.')
    const before = await core.queryMailbox(query({ search: 'canonical' }))
    await rm(join(libraryDir, '.index'), { recursive: true, force: true })
    const after = await core.queryMailbox(query({ search: 'canonical' }))
    expect(after.groups).toEqual(before.groups)
    expect(after.index).toBe('rebuilt')
  })

  it('answers identically after the index is corrupted', async () => {
    const idea = await capture('Corruption survivor')
    await core.setIdeaPinned(idea.relativePath, true)
    const before = await core.queryMailbox(query())
    await writeFile(join(libraryDir, '.index', 'mailbox.sqlite'), 'not a database at all')
    const after = await core.queryMailbox(query())
    expect(after.groups).toEqual(before.groups)
    expect(after.index).toBe('rebuilt')
  })

  it('does not list the private index folder as an Idea', async () => {
    await capture('Only idea')
    await core.queryMailbox(query())
    const snapshot = await makeCore().openLibrary(libraryDir)
    expect(snapshot.ideas.map((idea) => idea.title)).toEqual(['Only idea'])
  })
})

describe('needs attention', () => {
  it('groups unrecoverable and newer-format Ideas under needs-attention', async () => {
    const broken = await capture('Broken idea')
    now = new Date(now.getTime() + 1000)
    const future = await capture('Future idea')
    now = new Date(now.getTime() + 1000)
    await capture('Healthy idea')
    await writeFile(join(libraryDir, broken.relativePath, 'idea.md'), 'corrupt content')
    const futureRoot = join(libraryDir, future.relativePath, 'idea.md')
    await writeFile(
      futureRoot,
      (await readFile(futureRoot, 'utf8')).replace('format: 1', 'format: 99')
    )

    const reborn = makeCore()
    await reborn.openLibrary(libraryDir)
    const snapshot = await reborn.queryMailbox(query())
    expect(group(snapshot, 'needs-attention').sort()).toEqual(['Broken idea', 'Future idea'])
    expect(group(snapshot, 'recent')).toEqual(['Healthy idea'])
    expect(group(snapshot, 'running')).toEqual([])
  })
})

describe('permanent delete preview', () => {
  it('targets the whole folder when it only holds app-owned content', async () => {
    const idea = await capture('Cleanly deletable')
    const preview = await core.previewDeleteIdea(idea.relativePath)
    expect(preview.title).toBe('Cleanly deletable')
    expect(preview.targets).toEqual([idea.relativePath])
    expect(preview.keeps).toEqual([])
  })

  it('targets only app-owned files when the folder holds foreign content', async () => {
    const idea = await capture('Shared folder idea')
    await writeFile(join(libraryDir, idea.relativePath, 'my-own-notes.md'), 'user content')
    const preview = await core.previewDeleteIdea(idea.relativePath)
    expect(preview.targets.sort()).toEqual([
      `${idea.relativePath}/.idea`,
      `${idea.relativePath}/idea.md`,
      `${idea.relativePath}/planning`
    ])
    expect(preview.keeps).toEqual([`${idea.relativePath}/my-own-notes.md`])
  })

  it('refuses to preview an unknown Idea', async () => {
    await expect(core.previewDeleteIdea('nowhere')).rejects.toMatchObject({
      code: 'IDEA_NOT_FOUND'
    })
  })
})
