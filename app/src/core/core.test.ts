import { mkdtemp, readFile, readdir, rename, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CoreError } from '@shared/contract'
import { createCore, type Core } from './core'

let libraryDir: string
let core: Core

function makeCore(): Core {
  let tick = 0
  return createCore({
    now: () => new Date(Date.UTC(2026, 6, 31, 12, 0, tick++)),
    randomId: (() => {
      let n = 0
      return () => `test-id-${String(++n).padStart(4, '0')}`
    })()
  })
}

beforeEach(async () => {
  libraryDir = await mkdtemp(join(tmpdir(), 'session-library-'))
  core = makeCore()
})

afterEach(async () => {
  await rm(libraryDir, { recursive: true, force: true })
})

describe('opening a library', () => {
  it('opens an existing empty directory and reports no Sessions', async () => {
    const snapshot = await core.openLibrary(libraryDir)
    expect(snapshot.path).toBe(libraryDir)
    expect(snapshot.sessions).toEqual([])
  })

  it('rejects a location that does not exist', async () => {
    const missing = join(libraryDir, 'does-not-exist')
    await expect(core.openLibrary(missing)).rejects.toMatchObject({
      code: 'LIBRARY_MISSING'
    })
  })

  it('rejects a location that is a file', async () => {
    const filePath = join(libraryDir, 'a-file.md')
    await writeFile(filePath, 'not a directory')
    await expect(core.openLibrary(filePath)).rejects.toMatchObject({
      code: 'NOT_A_DIRECTORY'
    })
  })

  it('ignores a library written in the previous format without altering it', async () => {
    // The retired format kept each Session as `idea.md` in a folder. Those
    // folders are not migrated: they are left exactly as found and never read.
    // The app's own disposable index is not part of that promise — it is
    // rebuilt from what the app can read, which is now nothing.
    const legacyDir = join(libraryDir, 'a-previous-session')
    await mkdir(legacyDir)
    const legacy = [
      '---',
      'id: legacy-id',
      'kind: software',
      'status: saved',
      'created: 2026-07-01T10:00:00.000Z',
      'updated: 2026-07-01T10:00:00.000Z',
      'format: 1',
      '---',
      '',
      '# A previous session',
      ''
    ].join('\n')
    await writeFile(join(legacyDir, 'idea.md'), legacy)

    const snapshot = await core.openLibrary(libraryDir)
    expect(snapshot.sessions).toEqual([])
    await expect(readFile(join(legacyDir, 'idea.md'), 'utf8')).resolves.toBe(legacy)
    expect(await readdir(legacyDir)).toEqual(['idea.md'])

    // Querying rebuilds the disposable index and must still not reach into the
    // previous format's Session folders.
    await core.queryMailbox({ search: '', view: 'active', dormantAfterDays: 30 })
    await expect(readFile(join(legacyDir, 'idea.md'), 'utf8')).resolves.toBe(legacy)
    expect(await readdir(legacyDir)).toEqual(['idea.md'])
  })

  it('writes nothing into the directory just by opening it', async () => {
    await core.openLibrary(libraryDir)
    expect(await readdir(libraryDir)).toEqual([])
  })
})

describe('capturing a Session', () => {
  it('requires an open library first', async () => {
    await expect(core.captureSession({ title: 'Anything', notes: '' })).rejects.toMatchObject({
      code: 'NO_LIBRARY_OPEN'
    })
  })

  it('saves a Session and returns its summary', async () => {
    await core.openLibrary(libraryDir)
    const session = await core.captureSession({
      title: 'Offline recipe planner',
      notes: 'An app that plans meals without any accounts.'
    })
    expect(session).toMatchObject({ title: 'Offline recipe planner' })
    expect(session.id).toBeTruthy()
    expect(session.createdAt).toBe(session.updatedAt)
  })

  it('writes the Session as canonical Markdown with minimal frontmatter', async () => {
    await core.openLibrary(libraryDir)
    const session = await core.captureSession({
      title: 'Offline recipe planner',
      notes: 'Plans meals without accounts.\n\nWorks offline.'
    })
    const raw = await readFile(join(libraryDir, session.relativePath, 'session.md'), 'utf8')
    expect(raw).toContain(`id: ${session.id}`)
    expect(raw).toContain('format: 2')
    expect(raw).toContain('# Offline recipe planner')
    expect(raw).toContain('Plans meals without accounts.')
    expect(raw).not.toContain('\r\n')
    expect(raw.startsWith('---\n')).toBe(true)
  })

  it('publishes a portable container with stable managed identities', async () => {
    await core.openLibrary(libraryDir)
    const session = await core.captureSession({
      title: 'Portable history',
      notes: 'Keep the whole history inspectable.'
    })
    const sessionDir = join(libraryDir, session.relativePath)

    const [root, conversation, recovery] = await Promise.all([
      readFile(join(sessionDir, 'session.md'), 'utf8'),
      readFile(join(sessionDir, 'conversation.md'), 'utf8'),
      readFile(join(sessionDir, '.session', 'recovery.json'), 'utf8')
    ])

    expect(root).toContain('format: 2')
    expect(root).toContain('conversation: conversation.md')
    expect(conversation).toContain(`session_id: ${session.id}`)
    expect(conversation).toContain('document_id: test-id-0002')
    expect(JSON.parse(recovery)).toMatchObject({
      format: 2,
      sessionId: session.id,
      documents: {
        root: { id: session.id, path: 'session.md' },
        conversation: { id: 'test-id-0002', path: 'conversation.md' }
      }
    })
    expect(root).not.toContain(libraryDir)
    expect(conversation).not.toContain(libraryDir)
  })

  it('derives a deterministic title when the title is blank', async () => {
    await core.openLibrary(libraryDir)
    const session = await core.captureSession({
      title: '   ',
      notes: 'A tiny CLI that renames screenshots\nwith dates.'
    })
    expect(session.title).toBe('A tiny CLI that renames screenshots')
  })

  it('falls back to Untitled Session when there is nothing to derive from', async () => {
    await core.openLibrary(libraryDir)
    const session = await core.captureSession({ title: '', notes: '' })
    expect(session.title).toBe('Untitled Session')
  })

  it('keeps folder names unique for identical titles', async () => {
    await core.openLibrary(libraryDir)
    const first = await core.captureSession({ title: 'Same title', notes: '' })
    const second = await core.captureSession({ title: 'Same title', notes: '' })
    expect(first.relativePath).not.toBe(second.relativePath)
    const sessions = await core.listSessions()
    expect(sessions).toHaveLength(2)
  })

  it('rejects malformed input with INVALID_INPUT', async () => {
    await core.openLibrary(libraryDir)
    await expect(core.captureSession({ title: 'x', notes: 42 as never })).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
  })

  it('leaves no temporary files behind after a save', async () => {
    await core.openLibrary(libraryDir)
    const session = await core.captureSession({ title: 'Clean writes', notes: 'n' })
    const entries = await readdir(join(libraryDir, session.relativePath), { recursive: true })
    expect(entries.some((entry) => entry.endsWith('.staged'))).toBe(false)
  })
})

describe('an application restart', () => {
  it('lists previously saved Sessions from canonical Markdown alone', async () => {
    await core.openLibrary(libraryDir)
    const saved = await core.captureSession({
      title: 'Survives restart',
      notes: 'The Session must still be here.'
    })

    const rebornCore = makeCore()
    const snapshot = await rebornCore.openLibrary(libraryDir)
    expect(snapshot.sessions).toHaveLength(1)
    expect(snapshot.sessions[0]).toMatchObject({
      id: saved.id,
      title: 'Survives restart'
    })
  })

  it('ignores unrelated folders and unreadable Session files without failing', async () => {
    await core.openLibrary(libraryDir)
    await core.captureSession({ title: 'Valid Session', notes: '' })
    await mkdir(join(libraryDir, 'random-folder'))
    await writeFile(join(libraryDir, 'stray-note.md'), 'just a note')
    await mkdir(join(libraryDir, 'broken-session'))
    await writeFile(join(libraryDir, 'broken-session', 'session.md'), 'no frontmatter at all')

    const snapshot = await makeCore().openLibrary(libraryDir)
    expect(snapshot.sessions).toHaveLength(1)
    expect(snapshot.sessions[0]?.title).toBe('Valid Session')
  })

  it('refuses to rewrite a Session written by a newer version of the app', async () => {
    await core.openLibrary(libraryDir)
    const saved = await core.captureSession({ title: 'From the future', notes: '' })
    const rootPath = join(libraryDir, saved.relativePath, 'session.md')
    const original = await readFile(rootPath, 'utf8')
    await writeFile(rootPath, original.replace('format: 2', 'format: 99'))

    const reborn = makeCore()
    await reborn.openLibrary(libraryDir)
    await expect(reborn.setSessionPinned(saved.relativePath, true)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'This Session was written by a newer version of the app'
    })
    await expect(readFile(rootPath, 'utf8')).resolves.toContain('format: 99')
    await expect(readFile(rootPath, 'utf8')).resolves.not.toContain('pinned: true')
  })

  it('orders Sessions newest first', async () => {
    await core.openLibrary(libraryDir)
    await core.captureSession({ title: 'First', notes: '' })
    await core.captureSession({ title: 'Second', notes: '' })
    const snapshot = await makeCore().openLibrary(libraryDir)
    expect(snapshot.sessions.map((s) => s.title)).toEqual(['Second', 'First'])
  })

  it('rebuilds a missing or corrupt projection from canonical content', async () => {
    await core.openLibrary(libraryDir)
    const session = await core.captureSession({
      title: 'Canonical wins',
      notes: 'Truth.'
    })
    const projectionPath = join(libraryDir, session.relativePath, '.session', 'projection.json')
    await writeFile(projectionPath, '{ definitely not valid json')

    const snapshot = await makeCore().openLibrary(libraryDir)
    expect(snapshot.sessions[0]).toMatchObject({ id: session.id, title: 'Canonical wins' })
    expect(JSON.parse(await readFile(projectionPath, 'utf8'))).toMatchObject({
      source: 'canonical-markdown',
      session: { id: session.id, title: 'Canonical wins' }
    })
  })

  it('reopens managed content by stable identity after title and ordinary path changes', async () => {
    await core.openLibrary(libraryDir)
    const captured = await core.captureSession({
      title: 'Original title',
      notes: 'Identity must not depend on names.'
    })
    const originalDir = join(libraryDir, captured.relativePath)
    const movedDir = join(libraryDir, 'renamed-container')
    await rename(originalDir, movedDir)
    await rename(join(movedDir, 'session.md'), join(movedDir, 'overview.md'))
    await rename(join(movedDir, 'conversation.md'), join(movedDir, 'history.md'))
    const rootPath = join(movedDir, 'overview.md')
    await writeFile(
      rootPath,
      (await readFile(rootPath, 'utf8')).replace('# Original title', '# New title')
    )

    const reborn = makeCore()
    const snapshot = await reborn.openLibrary(libraryDir)
    expect(snapshot.sessions[0]).toMatchObject({
      id: captured.id,
      title: 'New title',
      relativePath: 'renamed-container'
    })
    const workspace = await reborn.openSession('renamed-container')
    expect(workspace.documents).toMatchObject({
      root: { id: captured.id, path: 'overview.md' },
      conversation: { id: 'test-id-0002', path: 'history.md' }
    })
    const recovery = JSON.parse(
      await readFile(join(movedDir, '.session', 'recovery.json'), 'utf8')
    ) as {
      documents: { conversation: { path: string } }
    }
    expect(recovery.documents.conversation.path).toBe('history.md')
    await expect(readFile(rootPath, 'utf8')).resolves.toContain('conversation: history.md')
  })
})

describe('CoreError', () => {
  it('is what open/capture failures are made of', async () => {
    await expect(core.captureSession({ title: 'x', notes: '' })).rejects.toBeInstanceOf(CoreError)
  })
})
