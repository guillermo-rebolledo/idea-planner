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

  it('publishes a portable planning container with stable managed identities', async () => {
    await core.openLibrary(libraryDir)
    const idea = await core.captureIdea({
      kind: 'software',
      title: 'Portable planning',
      notes: 'Keep the whole planning history inspectable.'
    })
    const ideaDir = join(libraryDir, idea.relativePath)

    const [root, planningIndex, conversation, recovery] = await Promise.all([
      readFile(join(ideaDir, 'idea.md'), 'utf8'),
      readFile(join(ideaDir, 'planning', 'index.md'), 'utf8'),
      readFile(join(ideaDir, 'planning', 'conversation.md'), 'utf8'),
      readFile(join(ideaDir, '.idea', 'recovery.json'), 'utf8')
    ])

    expect(root).toContain('format: 1')
    expect(root).toContain('planning_index: planning/index.md')
    expect(root).toContain('conversation: planning/conversation.md')
    expect(planningIndex).toContain(`idea_id: ${idea.id}`)
    expect(planningIndex).toContain('document_id: test-id-0002')
    expect(planningIndex).toContain('[Conversation](conversation.md)')
    expect(conversation).toContain(`idea_id: ${idea.id}`)
    expect(conversation).toContain('document_id: test-id-0003')
    expect(JSON.parse(recovery)).toMatchObject({
      format: 1,
      ideaId: idea.id,
      documents: {
        root: { id: idea.id, path: 'idea.md' },
        planningIndex: { id: 'test-id-0002', path: 'planning/index.md' },
        conversation: { id: 'test-id-0003', path: 'planning/conversation.md' }
      },
      transaction: null
    })
    expect(root).not.toContain(libraryDir)
    expect(planningIndex).not.toContain(libraryDir)
    expect(conversation).not.toContain(libraryDir)
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
    const entries = await readdir(join(libraryDir, idea.relativePath), { recursive: true })
    expect(entries.some((entry) => entry.endsWith('.staged'))).toBe(false)
    expect(entries).not.toContain('.idea/transactions/capture')
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

  it('finishes an interrupted multi-document capture without partial canonical content', async () => {
    let interrupted = false
    const crashyCore = createCore({
      now: () => new Date('2026-07-31T12:00:00.000Z'),
      randomId: (() => {
        let n = 0
        return () => `crash-id-${++n}`
      })(),
      onTransactionBoundary: (boundary) => {
        if (
          !interrupted &&
          boundary.phase === 'document-committed' &&
          boundary.documentIndex === 0
        ) {
          interrupted = true
          throw new Error('simulated process loss')
        }
      }
    })
    await crashyCore.openLibrary(libraryDir)

    await expect(
      crashyCore.captureIdea({ kind: 'software', title: 'Recovered capture', notes: 'Durable.' })
    ).rejects.toThrow('simulated process loss')

    const snapshot = await makeCore().openLibrary(libraryDir)
    expect(snapshot.ideas).toHaveLength(1)
    expect(snapshot.ideas[0]).toMatchObject({
      id: 'crash-id-1',
      title: 'Recovered capture',
      openState: 'recovered'
    })

    const reopenedIdea = snapshot.ideas[0]
    expect(reopenedIdea).toBeDefined()
    if (!reopenedIdea) throw new Error('Expected the recovered Idea')
    const ideaDir = join(libraryDir, reopenedIdea.relativePath)
    await expect(readFile(join(ideaDir, 'idea.md'), 'utf8')).resolves.toContain(
      '# Recovered capture'
    )
    await expect(readFile(join(ideaDir, 'planning', 'index.md'), 'utf8')).resolves.toContain(
      '# Planning Index'
    )
    await expect(readFile(join(ideaDir, 'planning', 'conversation.md'), 'utf8')).resolves.toContain(
      '# Conversation'
    )
    expect(
      JSON.parse(await readFile(join(ideaDir, '.idea', 'recovery.json'), 'utf8'))
    ).toMatchObject({ transaction: null })
  })

  it('finishes a transaction interrupted immediately before journal finalization', async () => {
    const crashyCore = createCore({
      now: () => new Date('2026-07-31T12:00:00.000Z'),
      randomId: (() => {
        let n = 0
        return () => `finalize-id-${++n}`
      })(),
      onTransactionBoundary: (boundary) => {
        if (boundary.phase === 'before-finalize') throw new Error('lost before finalization')
      }
    })
    await crashyCore.openLibrary(libraryDir)
    await expect(
      crashyCore.captureIdea({ kind: 'general', title: 'Finalize recovery', notes: '' })
    ).rejects.toThrow('lost before finalization')

    const snapshot = await makeCore().openLibrary(libraryDir)
    expect(snapshot.ideas).toHaveLength(1)
    expect(snapshot.ideas[0]).toMatchObject({
      id: 'finalize-id-1',
      openState: 'recovered'
    })
  })

  it('rolls back when an interrupted capture cannot be completed', async () => {
    const crashyCore = createCore({
      now: () => new Date('2026-07-31T12:00:00.000Z'),
      randomId: (() => {
        let n = 0
        return () => `rollback-id-${++n}`
      })(),
      onTransactionBoundary: (boundary) => {
        if (boundary.phase === 'prepared') throw new Error('lost after prepare')
      }
    })
    await crashyCore.openLibrary(libraryDir)
    await expect(
      crashyCore.captureIdea({ kind: 'software', title: 'Rollback capture', notes: '' })
    ).rejects.toThrow('lost after prepare')

    const ideaDir = join(libraryDir, 'rollback-capture')
    await rm(join(ideaDir, '.idea', 'transactions', 'capture', 'planning', 'conversation.md'))
    const snapshot = await makeCore().openLibrary(libraryDir)
    expect(snapshot.ideas).toEqual([])
    await expect(readdir(libraryDir)).resolves.not.toContain('rollback-capture')
  })

  it('snapshots a supported legacy Idea completely before migrating it', async () => {
    const legacyDir = join(libraryDir, 'legacy-idea')
    await mkdir(legacyDir)
    const legacy = [
      '---',
      'id: legacy-id',
      'kind: software',
      'status: saved',
      'created: 2026-07-01T10:00:00.000Z',
      'updated: 2026-07-01T10:00:00.000Z',
      '---',
      '',
      '# Legacy title',
      '',
      'Original canonical content.',
      ''
    ].join('\n')
    await writeFile(join(legacyDir, 'idea.md'), legacy)

    const snapshot = await makeCore().openLibrary(libraryDir)
    expect(snapshot.ideas[0]).toMatchObject({ id: 'legacy-id', openState: 'ready' })
    await expect(readFile(join(legacyDir, 'planning', 'index.md'), 'utf8')).resolves.toContain(
      'idea_id: legacy-id'
    )
    await expect(readFile(join(legacyDir, 'idea.md'), 'utf8')).resolves.toContain('format: 1')

    const snapshots = await readdir(join(legacyDir, '.idea', 'snapshots'))
    expect(snapshots).toHaveLength(1)
    const snapshotName = snapshots[0]
    expect(snapshotName).toBeDefined()
    if (!snapshotName) throw new Error('Expected a baseline snapshot')
    const baselineDir = join(legacyDir, '.idea', 'snapshots', snapshotName)
    await expect(readFile(join(baselineDir, 'idea.md'), 'utf8')).resolves.toBe(legacy)
    expect(JSON.parse(await readFile(join(baselineDir, 'manifest.json'), 'utf8'))).toMatchObject({
      reason: 'before-format-1-migration',
      files: [{ path: 'idea.md' }]
    })
  })

  it('opens an unknown newer format read-only without changing canonical content', async () => {
    const newerDir = join(libraryDir, 'from-the-future')
    await mkdir(newerDir)
    const newer = [
      '---',
      'format: 99',
      'id: future-id',
      'kind: general',
      'status: saved',
      'created: 2026-07-01T10:00:00.000Z',
      'updated: 2026-07-01T10:00:00.000Z',
      '---',
      '',
      '# Future Idea',
      ''
    ].join('\n')
    await writeFile(join(newerDir, 'idea.md'), newer)

    const snapshot = await makeCore().openLibrary(libraryDir)
    expect(snapshot.ideas[0]).toMatchObject({
      id: 'future-id',
      title: 'Future Idea',
      openState: 'read-only-newer-format'
    })
    await expect(readFile(join(newerDir, 'idea.md'), 'utf8')).resolves.toBe(newer)
    await expect(readdir(newerDir)).resolves.toEqual(['idea.md'])
  })

  it('does not replay an unfamiliar transaction journal for a newer format', async () => {
    const newerDir = join(libraryDir, 'future-journal')
    const stagedPath = join(newerDir, '.idea', 'transactions', 'capture', 'idea.md')
    await mkdir(join(stagedPath, '..'), { recursive: true })
    const newer = [
      '---',
      'format: 99',
      'id: future-journal-id',
      'kind: general',
      'status: saved',
      'created: 2026-07-01T10:00:00.000Z',
      'updated: 2026-07-01T10:00:00.000Z',
      '---',
      '',
      '# Future journal',
      ''
    ].join('\n')
    await writeFile(join(newerDir, 'idea.md'), newer)
    await writeFile(stagedPath, 'must not replace newer canonical content')
    await writeFile(
      join(newerDir, '.idea', 'recovery.json'),
      JSON.stringify({
        format: 1,
        ideaId: 'future-journal-id',
        documents: {
          root: { id: 'future-journal-id', path: 'idea.md' },
          planningIndex: { id: 'future-index', path: 'planning/index.md' },
          conversation: { id: 'future-conversation', path: 'planning/conversation.md' }
        },
        events: [],
        transaction: {
          id: 'capture',
          state: 'prepared',
          writes: [{ target: 'idea.md', staged: '.idea/transactions/capture/idea.md' }]
        }
      })
    )

    const snapshot = await makeCore().openLibrary(libraryDir)
    expect(snapshot.ideas[0]).toMatchObject({
      id: 'future-journal-id',
      openState: 'read-only-newer-format'
    })
    await expect(readFile(join(newerDir, 'idea.md'), 'utf8')).resolves.toBe(newer)
    await expect(readFile(stagedPath, 'utf8')).resolves.toBe(
      'must not replace newer canonical content'
    )
  })

  it('rebuilds a missing or corrupt projection from canonical content', async () => {
    await core.openLibrary(libraryDir)
    const idea = await core.captureIdea({
      kind: 'general',
      title: 'Canonical wins',
      notes: 'Truth.'
    })
    const projectionPath = join(libraryDir, idea.relativePath, '.idea', 'projection.json')
    await writeFile(projectionPath, '{ definitely not valid json')

    const snapshot = await makeCore().openLibrary(libraryDir)
    expect(snapshot.ideas[0]).toMatchObject({ id: idea.id, title: 'Canonical wins' })
    expect(JSON.parse(await readFile(projectionPath, 'utf8'))).toMatchObject({
      source: 'canonical-markdown',
      idea: { id: idea.id, title: 'Canonical wins' }
    })
  })

  it('reopens managed content by stable identity after title and ordinary path changes', async () => {
    await core.openLibrary(libraryDir)
    const captured = await core.captureIdea({
      kind: 'software',
      title: 'Original title',
      notes: 'Identity must not depend on names.'
    })
    const originalDir = join(libraryDir, captured.relativePath)
    const movedDir = join(libraryDir, 'renamed-container')
    await rename(originalDir, movedDir)
    await rename(join(movedDir, 'idea.md'), join(movedDir, 'overview.md'))
    await rename(join(movedDir, 'planning', 'index.md'), join(movedDir, 'planning', 'guide.md'))
    await rename(
      join(movedDir, 'planning', 'conversation.md'),
      join(movedDir, 'planning', 'history.md')
    )
    const rootPath = join(movedDir, 'overview.md')
    await writeFile(
      rootPath,
      (await readFile(rootPath, 'utf8')).replace('# Original title', '# New title')
    )

    const reborn = makeCore()
    const snapshot = await reborn.openLibrary(libraryDir)
    expect(snapshot.ideas[0]).toMatchObject({
      id: captured.id,
      title: 'New title',
      relativePath: 'renamed-container'
    })
    const workspace = await reborn.openIdea('renamed-container')
    expect(workspace.documents).toMatchObject({
      root: { id: captured.id, path: 'overview.md' },
      planningIndex: { id: 'test-id-0002', path: 'planning/guide.md' },
      conversation: { id: 'test-id-0003', path: 'planning/history.md' }
    })
    const recovery = JSON.parse(
      await readFile(join(movedDir, '.idea', 'recovery.json'), 'utf8')
    ) as {
      documents: { planningIndex: { path: string }; conversation: { path: string } }
    }
    expect(recovery.documents.planningIndex.path).toBe('planning/guide.md')
    expect(recovery.documents.conversation.path).toBe('planning/history.md')
    await expect(readFile(rootPath, 'utf8')).resolves.toContain('planning_index: planning/guide.md')
    await expect(readFile(rootPath, 'utf8')).resolves.toContain('conversation: planning/history.md')
    const repairedIndex = await readFile(join(movedDir, 'planning', 'guide.md'), 'utf8')
    expect(repairedIndex).toContain('[Idea](../overview.md)')
    expect(repairedIndex).toContain('[Conversation](history.md)')
  })

  it('restores recovery identity when an interrupted link repair rolls back', async () => {
    await core.openLibrary(libraryDir)
    const captured = await core.captureIdea({
      kind: 'software',
      title: 'Repair rollback',
      notes: 'Keep identity authoritative.'
    })
    const ideaDir = join(libraryDir, captured.relativePath)
    await rename(join(ideaDir, 'planning', 'index.md'), join(ideaDir, 'planning', 'guide.md'))

    const crashyCore = createCore({
      onTransactionBoundary: (boundary) => {
        if (boundary.phase === 'document-committed' && boundary.documentIndex === 0) {
          throw new Error('lost during link repair')
        }
      }
    })
    await crashyCore.openLibrary(libraryDir)
    await expect(crashyCore.openIdea(captured.relativePath)).rejects.toThrow(
      'lost during link repair'
    )
    await rm(join(ideaDir, '.idea', 'transactions', 'repair-links', 'planning', 'guide.md'))

    const reborn = makeCore()
    await reborn.openLibrary(libraryDir)
    const reopened = await reborn.openIdea(captured.relativePath)
    expect(reopened.documents.planningIndex.path).toBe('planning/guide.md')
    const recovery = JSON.parse(
      await readFile(join(ideaDir, '.idea', 'recovery.json'), 'utf8')
    ) as { documents: { planningIndex: { path: string } }; transaction: unknown }
    expect(recovery.documents.planningIndex.path).toBe('planning/guide.md')
    expect(recovery.transaction).toBeNull()
  })

  it('keeps a recognized Idea visible when canonical content is unrecoverable', async () => {
    await core.openLibrary(libraryDir)
    const captured = await core.captureIdea({
      kind: 'general',
      title: 'Needs recovery',
      notes: 'Do not hide this Idea.'
    })
    await writeFile(join(libraryDir, captured.relativePath, 'idea.md'), 'corrupt content')

    const reborn = makeCore()
    const snapshot = await reborn.openLibrary(libraryDir)
    expect(snapshot.ideas[0]).toMatchObject({
      id: captured.id,
      title: 'Needs recovery',
      openState: 'unrecoverable-content'
    })
    await expect(reborn.openIdea(captured.relativePath)).rejects.toMatchObject({
      code: 'UNRECOVERABLE_CONTENT'
    })
  })
})

describe('CoreError', () => {
  it('is what open/capture failures are made of', async () => {
    await expect(
      core.captureIdea({ kind: 'general', title: 'x', notes: '' })
    ).rejects.toBeInstanceOf(CoreError)
  })
})
