import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MailboxCoreQuery, MailboxSnapshot } from '@shared/contract'
import { createCore, type Core } from './core'

const DAY_MS = 24 * 60 * 60 * 1000

let stateDir: string
let projectRoot: string
let now: Date
let core: Core

function makeCore(): Core {
  let n = 0
  return createCore({
    stateDirectory: stateDir,
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
  stateDir = await mkdtemp(join(tmpdir(), 'session-mailbox-state-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'session-mailbox-project-'))
  now = new Date('2026-07-31T12:00:00.000Z')
  core = makeCore()
  await core.addProject(projectRoot)
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

/** A Session is started by a message; its title is derived from it. */
async function start(message: string) {
  return core.startSession({ projectRoot, message })
}

describe('pinning', () => {
  it('groups pinned Sessions first', async () => {
    const pinnedSession = await start('Pinned older Session')
    now = new Date(now.getTime() + DAY_MS)
    await start('Newer unpinned Session')

    const updated = await core.setSessionPinned(pinnedSession.id, true)
    expect(updated.pinned).toBe(true)

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

  it('survives a restart', async () => {
    const session = await start('Stays pinned')
    await core.setSessionPinned(session.id, true)

    const snapshot = await makeCore().queryMailbox(query())
    expect(group(snapshot, 'pinned')).toEqual(['Stays pinned'])
  })

  it('unpins reversibly', async () => {
    const session = await start('Toggle pin')
    await core.setSessionPinned(session.id, true)
    const unpinned = await core.setSessionPinned(session.id, false)
    expect(unpinned.pinned).toBe(false)
    const snapshot = await core.queryMailbox(query())
    expect(group(snapshot, 'pinned')).toEqual([])
    expect(group(snapshot, 'recent')).toEqual(['Toggle pin'])
  })

  it('marks a pinned Session Dormant after the configured threshold without reordering it', async () => {
    const dormantSession = await start('Sleepy pinned Session')
    await core.setSessionPinned(dormantSession.id, true)
    now = new Date(now.getTime() + 20 * DAY_MS)
    await start('Fresh unpinned Session')

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

  it('refuses to pin a Session that does not exist', async () => {
    await expect(core.setSessionPinned('never-started', true)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND'
    })
  })
})

describe('archiving', () => {
  it('archives reversibly, without touching the Project', async () => {
    const session = await start('Archivable Session')
    const before = await readdir(projectRoot)

    const archived = await core.setSessionArchived(session.id, true)
    expect(archived.archivedAt).toBe(now.toISOString())
    expect(await readdir(projectRoot)).toEqual(before)

    const active = await core.queryMailbox(query())
    expect(active.matched).toBe(0)
    const archivedView = await core.queryMailbox(query({ view: 'archived' }))
    expect(group(archivedView, 'archived')).toEqual(['Archivable Session'])

    const restored = await core.setSessionArchived(session.id, false)
    expect(restored.archivedAt).toBeNull()
    const activeAgain = await core.queryMailbox(query())
    expect(group(activeAgain, 'recent')).toEqual(['Archivable Session'])
  })

  it('keeps archive state across restarts', async () => {
    const session = await start('Stays archived')
    await core.setSessionArchived(session.id, true)

    const reborn = makeCore()
    const active = await reborn.queryMailbox(query())
    expect(active.total).toBe(0)
    const archivedView = await reborn.queryMailbox(query({ view: 'archived' }))
    expect(group(archivedView, 'archived')).toEqual(['Stays archived'])
  })
})

describe('search and filters', () => {
  beforeEach(async () => {
    await start('Offline recipe planner')
    now = new Date(now.getTime() + 1000)
    await start('Community tool library')
  })

  it('matches Session titles, term by term', async () => {
    const oneTerm = await core.queryMailbox(query({ search: 'recipe' }))
    expect(group(oneTerm, 'recent')).toEqual(['Offline recipe planner'])
    const bothTerms = await core.queryMailbox(query({ search: 'community tool' }))
    expect(group(bothTerms, 'recent')).toEqual(['Community tool library'])
  })

  it('distinguishes no results from having no Sessions at all', async () => {
    const snapshot = await core.queryMailbox(query({ search: 'zeppelin' }))
    expect(snapshot.total).toBe(2)
    expect(snapshot.matched).toBe(0)
  })
})
