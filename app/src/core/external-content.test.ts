import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { EventEmitter } from 'node:events'
import { encode as encodeJpeg } from 'jpeg-js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReconciliationReason } from '@shared/contract'
import { createCore } from './core'
import { observeExactPaths } from './external-content'

describe('external managed content', () => {
  let libraryDir: string
  let outsideDir: string

  beforeEach(async () => {
    libraryDir = await mkdtemp(join(tmpdir(), 'idea-reconcile-library-'))
    outsideDir = await mkdtemp(join(tmpdir(), 'idea-reconcile-outside-'))
  })

  afterEach(async () => {
    await rm(libraryDir, { recursive: true, force: true })
    await rm(outsideDir, { recursive: true, force: true })
  })

  it('observes only the exact managed documents in the approved Working Directory', async () => {
    const observed: string[][] = []
    const core = createCore({
      observeManagedPaths: (paths) => {
        observed.push(paths)
        return undefined
      }
    })
    await core.openLibrary(libraryDir)
    const idea = await core.captureIdea({ kind: 'software', title: 'Bounded watch', notes: '' })

    const state = await core.reconcileIdea({ relativePath: idea.relativePath, reason: 'opened' })

    expect(observed).toEqual([
      state.documents.map((document) => join(libraryDir, idea.relativePath, document.path))
    ])
    expect(observed[0]).not.toContain(libraryDir)
    expect(observed[0]?.some((path) => path.startsWith(outsideDir))).toBe(false)
  })

  it('waits for stable bytes across rapid partial writes and records one new version', async () => {
    const core = createCore({
      observeManagedPaths: () => undefined
    })
    await core.openLibrary(libraryDir)
    const idea = await core.captureIdea({ kind: 'general', title: 'External edit', notes: 'Old' })
    const initial = await core.reconcileIdea({ relativePath: idea.relativePath, reason: 'opened' })
    const root = join(libraryDir, idea.relativePath, 'idea.md')
    const original = await readFile(root, 'utf8')
    await writeFile(root, original.replace('Old', 'Par'))
    const finalWrite = new Promise<void>((resolve) => {
      setTimeout(() => {
        void writeFile(root, original.replace('Old', 'Partial write completed')).then(() =>
          resolve()
        )
      }, 25)
    })
    const changed = await core.reconcileIdea({ relativePath: idea.relativePath, reason: 'changed' })
    await finalWrite

    expect(changed.status).toBe('changed')
    expect(changed.documents.find((document) => document.kind === 'root')?.version).toBe(
      (initial.documents.find((document) => document.kind === 'root')?.version ?? 0) + 1
    )
    expect(await readFile(root, 'utf8')).toContain('Partial write completed')
  })

  it('rearms from an atomic replacement hint and performs a bounded overflow rescan', async () => {
    let hint: ((reason: ReconciliationReason) => void) | undefined
    let observationCount = 0
    const core = createCore({
      observeManagedPaths: (_paths, onHint) => {
        observationCount += 1
        hint = onHint
        return undefined
      }
    })
    await core.openLibrary(libraryDir)
    const idea = await core.captureIdea({ kind: 'software', title: 'Watcher hints', notes: '' })
    const initial = await core.reconcileIdea({ relativePath: idea.relativePath, reason: 'opened' })
    const rootDocument = initial.documents.find((document) => document.kind === 'root')
    if (!rootDocument) throw new Error('Expected root document')
    const root = join(libraryDir, idea.relativePath, rootDocument.path)
    const replacement = `${root}.replacement`
    await writeFile(
      replacement,
      (await readFile(root, 'utf8')).replace('# Watcher hints', '# Replaced')
    )
    await rename(replacement, root)
    hint?.('atomic-replacement')
    await new Promise((resolve) => setTimeout(resolve, 60))
    const replaced = await core.reconcileIdea({ relativePath: idea.relativePath, reason: 'opened' })
    expect(replaced.documents.find((document) => document.id === rootDocument.id)?.version).toBe(2)
    expect(observationCount).toBeGreaterThanOrEqual(2)

    await writeFile(root, (await readFile(root, 'utf8')).replace('# Replaced', '# Overflow edit'))
    hint?.('overflow')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(observationCount).toBeGreaterThanOrEqual(3)

    const conversation = join(libraryDir, idea.relativePath, 'planning', 'conversation.md')
    await writeFile(
      join(libraryDir, idea.relativePath, 'duplicate.md'),
      await readFile(conversation)
    )
    await expect(
      core.reconcileIdea({ relativePath: idea.relativePath, reason: 'overflow' })
    ).resolves.toMatchObject({ status: 'duplicate-identity' })
  })

  it('disposes old Working Directory registrations when the Library changes', async () => {
    let disposeCount = 0
    const core = createCore({
      observeManagedPaths: () => () => {
        disposeCount += 1
      }
    })
    await core.openLibrary(libraryDir)
    const first = await core.captureIdea({ kind: 'general', title: 'First library', notes: '' })
    await core.reconcileIdea({ relativePath: first.relativePath, reason: 'opened' })

    await core.openLibrary(outsideDir)
    const second = await core.captureIdea({ kind: 'general', title: 'Second library', notes: '' })
    await core.reconcileIdea({ relativePath: second.relativePath, reason: 'opened' })

    expect(disposeCount).toBe(1)
    await expect(core.latestReconciliation(first.relativePath)).resolves.toBeNull()
  })

  it('pauses only the affected Run when disk changes conflict with its AI draft', async () => {
    let hint: ((reason: ReconciliationReason) => void) | undefined
    const core = createCore({
      observeManagedPaths: (_paths, onHint) => {
        hint = onHint
        return undefined
      }
    })
    await core.openLibrary(libraryDir)
    const idea = await core.captureIdea({ kind: 'software', title: 'Conflict', notes: 'baseline' })
    const initial = await core.reconcileIdea({ relativePath: idea.relativePath, reason: 'opened' })
    const rootDocument = initial.documents.find((document) => document.kind === 'root')
    if (!rootDocument) throw new Error('Expected root document')
    const root = join(libraryDir, idea.relativePath, rootDocument.path)
    const baseline = await readFile(root, 'utf8')
    const aiDraft = baseline.replace('baseline', 'AI draft')
    await core.reconcileIdea({
      relativePath: idea.relativePath,
      reason: 'opened',
      activeRun: {
        id: 'run-1',
        documents: [{ id: rootDocument.id, baselineHash: rootDocument.hash, aiDraft }]
      }
    })
    await writeFile(root, baseline.replace('baseline', 'disk version'))
    hint?.('changed')
    await new Promise((resolve) => setTimeout(resolve, 400))
    const conflict = await core.latestReconciliation(idea.relativePath)
    if (!conflict) throw new Error('Expected watcher reconciliation state')

    expect(conflict.status).toBe('conflict')
    expect(conflict.pausedRunId).toBe('run-1')
    expect(conflict.conflicts).toEqual([
      expect.objectContaining({
        documentId: rootDocument.id,
        choices: ['keep-disk', 'keep-ai-draft']
      })
    ])

    const resolved = await core.resolveManagedConflict({
      relativePath: idea.relativePath,
      documentId: rootDocument.id,
      choice: 'keep-ai-draft',
      aiDraft
    })
    expect(resolved.status).toBe('changed')
    expect(await readFile(root, 'utf8')).toContain('AI draft')

    await core.endRunReconciliation(idea.relativePath, 'run-1')
    await writeFile(root, aiDraft.replace('AI draft', 'later disk edit'))
    hint?.('changed')
    await new Promise((resolve) => setTimeout(resolve, 150))
    await expect(core.latestReconciliation(idea.relativePath)).resolves.toMatchObject({
      pausedRunId: null,
      conflicts: []
    })
  })

  it('rejects symlink escapes and reports duplicate stable identities explicitly', async () => {
    const core = createCore()
    await core.openLibrary(libraryDir)
    const first = await core.captureIdea({ kind: 'software', title: 'Symlink', notes: '' })
    await core.reconcileIdea({ relativePath: first.relativePath, reason: 'opened' })
    const outside = join(outsideDir, 'outside.md')
    await writeFile(outside, '# outside')
    const conversation = join(libraryDir, first.relativePath, 'planning', 'conversation.md')
    await rm(conversation)
    await symlink(outside, conversation)
    await expect(
      core.reconcileIdea({ relativePath: first.relativePath, reason: 'changed' })
    ).resolves.toMatchObject({ status: 'unsafe-path' })

    const second = await core.captureIdea({ kind: 'software', title: 'Duplicate', notes: '' })
    const duplicateDir = join(libraryDir, second.relativePath, 'planning', 'copy')
    await mkdir(duplicateDir)
    const source = join(libraryDir, second.relativePath, 'planning', 'conversation.md')
    await writeFile(join(duplicateDir, 'conversation.md'), await readFile(source, 'utf8'))
    await expect(
      core.reconcileIdea({ relativePath: second.relativePath, reason: 'overflow' })
    ).resolves.toMatchObject({ status: 'duplicate-identity' })

    const resolved = await core.resolveDuplicateManagedDocument({
      relativePath: second.relativePath,
      documentId: frontmatterId(await readFile(source, 'utf8')),
      selectedPath: source
    })
    expect(resolved.status).toBe('ready')
    await expect(readFile(join(duplicateDir, 'conversation.md'))).rejects.toThrow()
  })

  it('does not search elsewhere when an Idea location disappears', async () => {
    const core = createCore()
    await core.openLibrary(libraryDir)
    const idea = await core.captureIdea({ kind: 'general', title: 'Moved away', notes: '' })
    await core.reconcileIdea({ relativePath: idea.relativePath, reason: 'opened' })
    await rename(join(libraryDir, idea.relativePath), join(outsideDir, idea.relativePath))

    await expect(
      core.reconcileIdea({ relativePath: idea.relativePath, reason: 'changed' })
    ).resolves.toMatchObject({ status: 'location-missing', recoveryAction: 'locate' })

    const located = await core.locateIdea(idea.relativePath, join(outsideDir, idea.relativePath))
    expect(located.status).toBe('ready')
    await expect(core.openIdea(idea.relativePath)).resolves.toMatchObject({ idea: { id: idea.id } })
  })

  it('keeps an offline placeholder and distinguishes sync-copy ambiguity', async () => {
    const core = createCore()
    await core.openLibrary(libraryDir)
    const offline = await core.captureIdea({ kind: 'general', title: 'Offline', notes: '' })
    await core.reconcileIdea({ relativePath: offline.relativePath, reason: 'opened' })
    await rename(join(libraryDir, offline.relativePath), join(outsideDir, offline.relativePath))
    await expect(
      core.reconcileIdea({ relativePath: offline.relativePath, reason: 'missing-volume' })
    ).resolves.toMatchObject({ status: 'offline', recoveryAction: 'locate' })

    const sync = await core.captureIdea({ kind: 'software', title: 'Sync copy', notes: '' })
    const conversation = join(libraryDir, sync.relativePath, 'planning', 'conversation.md')
    await writeFile(
      join(libraryDir, sync.relativePath, 'planning', 'conversation.sync-conflict.md'),
      await readFile(conversation)
    )
    await expect(
      core.reconcileIdea({ relativePath: sync.relativePath, reason: 'overflow' })
    ).resolves.toMatchObject({ status: 'sync-copy-ambiguous' })
  })

  it('maps production watcher errors to overflow and a missing volume to offline', async () => {
    const hints: ReconciliationReason[] = []
    const watcher = new EventEmitter() as EventEmitter & { close(): void }
    watcher.close = () => undefined
    const dispose = observeExactPaths(
      ['/managed.md'],
      (reason) => hints.push(reason),
      () => watcher
    )
    watcher.emit('error', new Error('queue overflow'))
    expect(hints).toContain('overflow')
    dispose()

    const core = createCore()
    await core.openLibrary(libraryDir)
    const idea = await core.captureIdea({ kind: 'general', title: 'Unmounted', notes: '' })
    await core.reconcileIdea({ relativePath: idea.relativePath, reason: 'opened' })
    await rename(join(libraryDir, idea.relativePath), join(outsideDir, idea.relativePath))
    await new Promise((resolve) => setTimeout(resolve, 2_250))
    await expect(core.latestReconciliation(idea.relativePath)).resolves.toMatchObject({
      status: 'offline'
    })
  })

  it('restores a snapshot as a new current version without deleting later history', async () => {
    const core = createCore()
    await core.openLibrary(libraryDir)
    const idea = await core.captureIdea({ kind: 'general', title: 'History', notes: 'version one' })
    const first = await core.reconcileIdea({ relativePath: idea.relativePath, reason: 'opened' })
    const rootDocument = first.documents.find((document) => document.kind === 'root')
    if (!rootDocument) throw new Error('Expected root document')
    const root = join(libraryDir, idea.relativePath, rootDocument.path)
    await writeFile(root, (await readFile(root, 'utf8')).replace('version one', 'version two'))
    await core.reconcileIdea({ relativePath: idea.relativePath, reason: 'changed' })

    const restored = await core.restoreManagedVersion({
      relativePath: idea.relativePath,
      documentId: rootDocument.id,
      version: 1
    })

    expect(await readFile(root, 'utf8')).toContain('version one')
    expect(restored.documents.find((document) => document.id === rootDocument.id)?.version).toBe(3)
    expect(restored.history.filter((entry) => entry.documentId === rootDocument.id)).toHaveLength(3)
  })
})

describe('Reference Attachments', () => {
  let libraryDir: string
  let referencesDir: string

  beforeEach(async () => {
    libraryDir = await mkdtemp(join(tmpdir(), 'idea-reference-library-'))
    referencesDir = await mkdtemp(join(tmpdir(), 'idea-reference-external-'))
  })

  afterEach(async () => {
    await rm(libraryDir, { recursive: true, force: true })
    await rm(referencesDir, { recursive: true, force: true })
  })

  it('keeps an image external, strips metadata for Run context, and cleans it up', async () => {
    const core = createCore()
    await core.openLibrary(libraryDir)
    const idea = await core.captureIdea({ kind: 'general', title: 'Image context', notes: '' })
    const image = join(referencesDir, 'selected.png')
    const bytes = pngWithTextMetadata('private metadata')
    await writeFile(image, bytes)
    const reference = await core.addReferenceAttachment({
      relativePath: idea.relativePath,
      messageId: 'message-1',
      sourcePath: image
    })
    expect(reference.sourcePath).toBe(image)
    expect(reference.durablePath).toBeNull()

    const context = await core.prepareReferenceContext({
      relativePath: idea.relativePath,
      runId: 'run-1',
      referenceIds: [reference.id]
    })
    const derivative = context.files[0]
    if (!derivative) throw new Error('Expected derivative')
    expect((await readFile(derivative.path)).includes(Buffer.from('private metadata'))).toBe(false)
    await core.endRunReconciliation(idea.relativePath, 'run-1')
    await expect(readFile(derivative.path)).rejects.toThrow()
    await expect(readFile(image)).resolves.toEqual(bytes)

    const interrupted = await core.prepareReferenceContext({
      relativePath: idea.relativePath,
      runId: 'run-interrupted',
      referenceIds: [reference.id]
    })
    const interruptedDerivative = interrupted.files[0]
    if (!interruptedDerivative) throw new Error('Expected interrupted derivative')
    const restartedCore = createCore({ observeManagedPaths: () => undefined })
    await restartedCore.openLibrary(libraryDir)
    await restartedCore.reconcileIdea({ relativePath: idea.relativePath, reason: 'opened' })
    await expect(readFile(interruptedDerivative.path)).rejects.toThrow()

    const corrupt = Buffer.from(bytes)
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 0xff
    const corruptPath = join(referencesDir, 'corrupt.png')
    await writeFile(corruptPath, corrupt)
    await expect(
      core.addReferenceAttachment({
        relativePath: idea.relativePath,
        messageId: 'message-corrupt',
        sourcePath: corruptPath
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    const jpeg = encodeJpeg({ width: 1, height: 1, data: Buffer.from([255, 0, 0, 255]) }, 80).data
    const corruptJpeg = Buffer.concat([jpeg.subarray(0, -10), Buffer.from([0xff, 0xd9])])
    const corruptJpegPath = join(referencesDir, 'corrupt.jpg')
    await writeFile(corruptJpegPath, corruptJpeg)
    await expect(
      core.addReferenceAttachment({
        relativePath: idea.relativePath,
        messageId: 'message-corrupt-jpeg',
        sourcePath: corruptJpegPath
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('promotes only a sanitized copy and requires an explicit missing-reference choice', async () => {
    const core = createCore()
    await core.openLibrary(libraryDir)
    const idea = await core.captureIdea({ kind: 'software', title: 'Durable image', notes: '' })
    const image = join(referencesDir, 'diagram.png')
    await writeFile(image, pngWithTextMetadata('remove me'))
    const reference = await core.addReferenceAttachment({
      relativePath: idea.relativePath,
      messageId: 'message-2',
      sourcePath: image
    })
    const kept = await core.keepReferenceWithIdea({
      relativePath: idea.relativePath,
      referenceId: reference.id
    })
    expect(kept.durablePath).toMatch(/^assets\//)
    const durable = await readFile(join(libraryDir, idea.relativePath, kept.durablePath ?? ''))
    expect(durable.includes(Buffer.from('remove me'))).toBe(false)

    const missingImage = join(referencesDir, 'later-missing.png')
    await writeFile(missingImage, pngWithTextMetadata('temporary'))
    const missingReference = await core.addReferenceAttachment({
      relativePath: idea.relativePath,
      messageId: 'message-3',
      sourcePath: missingImage
    })
    await rm(missingImage)
    const state = await core.prepareReferenceContext({
      relativePath: idea.relativePath,
      runId: 'run-2',
      referenceIds: [reference.id, missingReference.id]
    })
    expect(state.missing).toEqual([
      expect.objectContaining({
        referenceId: missingReference.id,
        choices: ['locate-image', 'continue-without']
      })
    ])
    await core.continueWithoutReference({
      relativePath: idea.relativePath,
      referenceId: missingReference.id
    })
    await expect(
      core.prepareReferenceContext({
        relativePath: idea.relativePath,
        runId: 'run-3',
        referenceIds: [missingReference.id]
      })
    ).resolves.toMatchObject({ missing: [], files: [] })
  })
})

function pngWithTextMetadata(text: string): Buffer {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex')
  const ihdr = pngChunk('IHDR', Buffer.from('00000001000000010806000000', 'hex'))
  const metadata = pngChunk('tEXt', Buffer.from(`Comment\0${text}`))
  const idat = pngChunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0])))
  const iend = pngChunk('IEND', Buffer.alloc(0))
  return Buffer.concat([signature, ihdr, metadata, idat, iend])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, crc])
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function frontmatterId(raw: string): string {
  const match = /^(?:document_id|id):\s*(.+)$/m.exec(raw)
  if (!match?.[1]) throw new Error('Expected frontmatter id')
  return match[1].trim()
}
