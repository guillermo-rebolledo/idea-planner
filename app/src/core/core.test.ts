import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
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
  libraryDir = await mkdtemp(join(tmpdir(), 'idea-library-'))
  core = makeCore()
})

afterEach(async () => {
  await rm(libraryDir, { recursive: true, force: true })
})

describe('opening an Idea Library', () => {
  it('opens an existing empty directory and reports no Ideas', async () => {
    const snapshot = await core.openLibrary(libraryDir)
    expect(snapshot.path).toBe(libraryDir)
    expect(snapshot.ideas).toEqual([])
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

  it('writes nothing into the directory just by opening it', async () => {
    await core.openLibrary(libraryDir)
    expect(await readdir(libraryDir)).toEqual([])
  })
})

describe('capturing an Idea', () => {
  it('requires an open library first', async () => {
    await expect(
      core.captureIdea({ kind: 'software', title: 'Anything', notes: '' })
    ).rejects.toMatchObject({ code: 'NO_LIBRARY_OPEN' })
  })

  it('saves a Software Idea and returns its summary', async () => {
    await core.openLibrary(libraryDir)
    const idea = await core.captureIdea({
      kind: 'software',
      title: 'Offline recipe planner',
      notes: 'An app that plans meals without any accounts.'
    })
    expect(idea).toMatchObject({
      kind: 'software',
      title: 'Offline recipe planner',
      status: 'saved'
    })
    expect(idea.id).toBeTruthy()
    expect(idea.createdAt).toBe(idea.updatedAt)
  })

  it('saves a General Idea too', async () => {
    await core.openLibrary(libraryDir)
    const idea = await core.captureIdea({
      kind: 'general',
      title: 'Community tool library',
      notes: ''
    })
    expect(idea.kind).toBe('general')
  })

  it('writes the Idea as canonical Markdown with minimal frontmatter', async () => {
    await core.openLibrary(libraryDir)
    const idea = await core.captureIdea({
      kind: 'software',
      title: 'Offline recipe planner',
      notes: 'Plans meals without accounts.\n\nWorks offline.'
    })
    const raw = await readFile(join(libraryDir, idea.relativePath, 'idea.md'), 'utf8')
    expect(raw).toContain(`id: ${idea.id}`)
    expect(raw).toContain('kind: software')
    expect(raw).toContain('status: saved')
    expect(raw).toContain('# Offline recipe planner')
    expect(raw).toContain('Plans meals without accounts.')
    expect(raw).not.toContain('\r\n')
    expect(raw.startsWith('---\n')).toBe(true)
  })

  it('derives a deterministic title when the title is blank', async () => {
    await core.openLibrary(libraryDir)
    const idea = await core.captureIdea({
      kind: 'software',
      title: '   ',
      notes: 'A tiny CLI that renames screenshots\nwith dates.'
    })
    expect(idea.title).toBe('A tiny CLI that renames screenshots')
  })

  it('falls back to Untitled Idea when there is nothing to derive from', async () => {
    await core.openLibrary(libraryDir)
    const idea = await core.captureIdea({ kind: 'general', title: '', notes: '' })
    expect(idea.title).toBe('Untitled Idea')
  })

  it('keeps folder names unique for identical titles', async () => {
    await core.openLibrary(libraryDir)
    const first = await core.captureIdea({ kind: 'software', title: 'Same title', notes: '' })
    const second = await core.captureIdea({ kind: 'software', title: 'Same title', notes: '' })
    expect(first.relativePath).not.toBe(second.relativePath)
    const ideas = await core.listIdeas()
    expect(ideas).toHaveLength(2)
  })

  it('rejects malformed input with INVALID_INPUT', async () => {
    await core.openLibrary(libraryDir)
    await expect(
      core.captureIdea({ kind: 'wrong' as never, title: 'x', notes: '' })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('leaves no temporary files behind after a save', async () => {
    await core.openLibrary(libraryDir)
    const idea = await core.captureIdea({ kind: 'software', title: 'Clean writes', notes: 'n' })
    const entries = await readdir(join(libraryDir, idea.relativePath))
    expect(entries).toEqual(['idea.md'])
  })
})

describe('an application restart', () => {
  it('lists previously saved Ideas from canonical Markdown alone', async () => {
    await core.openLibrary(libraryDir)
    const saved = await core.captureIdea({
      kind: 'software',
      title: 'Survives restart',
      notes: 'The idea must still be here.'
    })

    const rebornCore = makeCore()
    const snapshot = await rebornCore.openLibrary(libraryDir)
    expect(snapshot.ideas).toHaveLength(1)
    expect(snapshot.ideas[0]).toMatchObject({
      id: saved.id,
      kind: 'software',
      title: 'Survives restart',
      status: 'saved'
    })
  })

  it('ignores unrelated folders and unreadable idea files without failing', async () => {
    await core.openLibrary(libraryDir)
    await core.captureIdea({ kind: 'general', title: 'Valid idea', notes: '' })
    await mkdir(join(libraryDir, 'random-folder'))
    await writeFile(join(libraryDir, 'stray-note.md'), 'just a note')
    await mkdir(join(libraryDir, 'broken-idea'))
    await writeFile(join(libraryDir, 'broken-idea', 'idea.md'), 'no frontmatter at all')

    const snapshot = await makeCore().openLibrary(libraryDir)
    expect(snapshot.ideas).toHaveLength(1)
    expect(snapshot.ideas[0]?.title).toBe('Valid idea')
  })

  it('orders Ideas newest first', async () => {
    await core.openLibrary(libraryDir)
    await core.captureIdea({ kind: 'general', title: 'First', notes: '' })
    await core.captureIdea({ kind: 'general', title: 'Second', notes: '' })
    const snapshot = await makeCore().openLibrary(libraryDir)
    expect(snapshot.ideas.map((i) => i.title)).toEqual(['Second', 'First'])
  })
})

describe('CoreError', () => {
  it('is what open/capture failures are made of', async () => {
    try {
      await core.captureIdea({ kind: 'general', title: 'x', notes: '' })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(CoreError)
    }
  })
})
