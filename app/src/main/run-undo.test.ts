import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Checkout, SessionSummary } from '@shared/contract'
import type { UndoOutcome } from '@shared/conversation'
import { RunUndoService } from './run-undo'
import { SessionSnapshotStore } from './snapshot-store'
import { conflictingRepository, testGit as git } from './git-test-support'

/**
 * Undo as the person meets it: prepare, read, confirm — with the world free to
 * move underneath at every step.
 */

let root: string
let privateRoot: string
let store: SessionSnapshotStore
let recorded: {
  sessionId: string
  operationId: string
  sourceRunId: string
  outcomes: UndoOutcome[]
  unlisted: number
}[]

const SESSION = 'session-1'
const RUN = 'run-1'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'run-undo-'))
  privateRoot = await mkdtemp(join(tmpdir(), 'run-undo-private-'))
  store = new SessionSnapshotStore(privateRoot)
  recorded = []
  await git('git', ['init', '--quiet', '-b', 'main'], { cwd: root })
  await writeFile(join(root, 'tracked.ts'), 'base\n')
  await git('git', ['add', '-A'], { cwd: root })
  await git(
    'git',
    ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'init'],
    { cwd: root }
  )
})

afterEach(async () => {
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(privateRoot, { recursive: true, force: true })
  ])
})

function session(checkout: Checkout = { kind: 'local' }): SessionSummary {
  return {
    id: SESSION,
    projectRoot: root,
    checkout: checkout.kind === 'worktree' ? { kind: 'worktree', path: root } : checkout,
    worktreeBootstrap: null,
    title: 'Undo me',
    createdAt: '2026-08-07T12:00:00.000Z',
    updatedAt: '2026-08-07T12:00:00.000Z',
    pinned: false,
    archivedAt: null
  }
}

function service(checkout: Checkout = { kind: 'local' }): RunUndoService {
  return new RunUndoService({
    store,
    session: () => Promise.resolve(session(checkout)),
    recordAppAction: (input) => {
      recorded.push(input)
      return Promise.resolve()
    }
  })
}

/** One Run that changed `tracked.ts`, bracketed by both snapshots. */
async function ranAndChanged(): Promise<void> {
  await store.capture({ sessionId: SESSION, runId: RUN, checkout: root, phase: 'before' })
  await writeFile(join(root, 'tracked.ts'), 'agent\n')
  await store.capture({ sessionId: SESSION, runId: RUN, checkout: root, phase: 'after' })
}

describe('preparing an undo', () => {
  it('reports undo unavailable for a Run with no retained snapshots', async () => {
    await expect(
      service().prepare({ sessionId: SESSION, runId: 'run-from-before' })
    ).resolves.toEqual({ status: 'unavailable', reason: 'no-snapshot' })
  })

  it('reports undo unavailable for a Run whose after snapshot was never taken', async () => {
    await store.capture({ sessionId: SESSION, runId: RUN, checkout: root, phase: 'before' })

    await expect(service().prepare({ sessionId: SESSION, runId: RUN })).resolves.toEqual({
      status: 'unavailable',
      reason: 'no-snapshot'
    })
  })

  it('reports nothing to undo for a Run that changed nothing', async () => {
    await store.capture({ sessionId: SESSION, runId: RUN, checkout: root, phase: 'before' })
    await store.capture({ sessionId: SESSION, runId: RUN, checkout: root, phase: 'after' })

    await expect(service().prepare({ sessionId: SESSION, runId: RUN })).resolves.toEqual({
      status: 'unavailable',
      reason: 'nothing-to-undo'
    })
  })

  it('always asks the primary checkout to review, even when every path is safe', async () => {
    await ranAndChanged()

    const prepared = await service({ kind: 'local' }).prepare({ sessionId: SESSION, runId: RUN })

    expect(prepared).toMatchObject({ status: 'ready', mode: 'review', runId: RUN })
    if (prepared.status !== 'ready') throw new Error('expected a plan')
    expect(prepared.paths).toEqual([
      { path: 'tracked.ts', changeKind: 'changed', classification: 'safe' }
    ])
    expect(prepared.patch).toContain('tracked.ts')
  })

  it('offers an isolated checkout a direct restore when every path is safe', async () => {
    await ranAndChanged()

    await expect(
      service({ kind: 'worktree', path: root }).prepare({ sessionId: SESSION, runId: RUN })
    ).resolves.toMatchObject({ status: 'ready', mode: 'direct' })
  })

  it('downgrades an isolated checkout to review when any one path has diverged', async () => {
    await store.capture({ sessionId: SESSION, runId: RUN, checkout: root, phase: 'before' })
    await writeFile(join(root, 'tracked.ts'), 'agent\n')
    await writeFile(join(root, 'also.ts'), 'agent\n')
    await store.capture({ sessionId: SESSION, runId: RUN, checkout: root, phase: 'after' })
    await writeFile(join(root, 'tracked.ts'), 'and then me\n')

    const prepared = await service({ kind: 'worktree', path: root }).prepare({
      sessionId: SESSION,
      runId: RUN
    })

    expect(prepared).toMatchObject({ status: 'ready', mode: 'review' })
    if (prepared.status !== 'ready') throw new Error('expected a plan')
    expect(prepared.paths).toEqual(
      expect.arrayContaining([
        { path: 'tracked.ts', changeKind: 'changed', classification: 'diverged' },
        { path: 'also.ts', changeKind: 'added', classification: 'safe' }
      ])
    )
  })

  it('names the Checkout State rather than planning during a Git operation', async () => {
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })
    await conflictingRepository(root, 'tracked.ts')
    await store.capture({ sessionId: SESSION, runId: RUN, checkout: root, phase: 'before' })
    await writeFile(join(root, 'other.ts'), 'agent\n')
    await store.capture({ sessionId: SESSION, runId: RUN, checkout: root, phase: 'after' })
    // The merge is already underway by the time the person asks (MEM-93).
    await git('git', ['merge', 'side'], { cwd: root }).catch(() => undefined)

    await expect(service().prepare({ sessionId: SESSION, runId: RUN })).resolves.toEqual({
      status: 'blocked',
      state: 'merge'
    })
  })
})

describe('applying an undo', () => {
  it('puts every safe path back and records exactly what it did', async () => {
    await ranAndChanged()
    const undo = service()
    const prepared = await undo.prepare({ sessionId: SESSION, runId: RUN })
    if (prepared.status !== 'ready') throw new Error('expected a plan')

    await expect(
      undo.apply({ sessionId: SESSION, operationId: prepared.operationId })
    ).resolves.toEqual({
      status: 'restored',
      runId: RUN,
      outcomes: [{ path: 'tracked.ts', outcome: 'restored' }]
    })

    await expect(readFile(join(root, 'tracked.ts'), 'utf8')).resolves.toBe('base\n')
    expect(recorded).toEqual([
      {
        sessionId: SESSION,
        operationId: prepared.operationId,
        sourceRunId: RUN,
        outcomes: [{ path: 'tracked.ts', outcome: 'restored' }],
        unlisted: 0
      }
    ])
  })

  it('applies the safe paths in one confirmation and leaves diverged ones alone', async () => {
    await store.capture({ sessionId: SESSION, runId: RUN, checkout: root, phase: 'before' })
    await writeFile(join(root, 'tracked.ts'), 'agent\n')
    await writeFile(join(root, 'also.ts'), 'agent\n')
    await store.capture({ sessionId: SESSION, runId: RUN, checkout: root, phase: 'after' })
    await writeFile(join(root, 'tracked.ts'), 'and then me\n')

    const undo = service()
    const prepared = await undo.prepare({ sessionId: SESSION, runId: RUN })
    if (prepared.status !== 'ready') throw new Error('expected a plan')
    const applied = await undo.apply({ sessionId: SESSION, operationId: prepared.operationId })

    expect(applied).toMatchObject({ status: 'partial', runId: RUN })
    if (applied.status !== 'partial') throw new Error('expected a partial restore')
    expect(applied.outcomes).toEqual(
      expect.arrayContaining([
        { path: 'tracked.ts', outcome: 'skipped-diverged' },
        { path: 'also.ts', outcome: 'restored' }
      ])
    )
    await expect(readFile(join(root, 'tracked.ts'), 'utf8')).resolves.toBe('and then me\n')
    expect(recorded).toHaveLength(1)
  })

  it('refuses without touching a file when the tree moved between review and apply', async () => {
    await ranAndChanged()
    const undo = service()
    const prepared = await undo.prepare({ sessionId: SESSION, runId: RUN })
    if (prepared.status !== 'ready') throw new Error('expected a plan')

    await writeFile(join(root, 'tracked.ts'), 'saved from my editor\n')

    await expect(
      undo.apply({ sessionId: SESSION, operationId: prepared.operationId })
    ).resolves.toEqual({ status: 'stale' })
    await expect(readFile(join(root, 'tracked.ts'), 'utf8')).resolves.toBe('saved from my editor\n')
    expect(recorded).toEqual([])
  })

  it('refuses a second confirmation of the same review', async () => {
    await ranAndChanged()
    const undo = service()
    const prepared = await undo.prepare({ sessionId: SESSION, runId: RUN })
    if (prepared.status !== 'ready') throw new Error('expected a plan')
    await undo.apply({ sessionId: SESSION, operationId: prepared.operationId })

    await expect(
      undo.apply({ sessionId: SESSION, operationId: prepared.operationId })
    ).resolves.toEqual({ status: 'stale' })
    expect(recorded).toHaveLength(1)
  })

  it('refuses a review belonging to another Session', async () => {
    await ranAndChanged()
    const undo = service()
    const prepared = await undo.prepare({ sessionId: SESSION, runId: RUN })
    if (prepared.status !== 'ready') throw new Error('expected a plan')

    await expect(
      undo.apply({ sessionId: 'someone-else', operationId: prepared.operationId })
    ).resolves.toEqual({ status: 'stale' })
  })

  it('blocks with the exact Checkout State and keeps the review for afterwards', async () => {
    // A repository whose two branches conflict, so a merge left half-done is a
    // real Checkout State rather than a marker file staged by hand.
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })
    await conflictingRepository(root, 'tracked.ts')
    await store.capture({ sessionId: SESSION, runId: RUN, checkout: root, phase: 'before' })
    await writeFile(join(root, 'other.ts'), 'agent\n')
    await store.capture({ sessionId: SESSION, runId: RUN, checkout: root, phase: 'after' })
    const undo = service()
    const prepared = await undo.prepare({ sessionId: SESSION, runId: RUN })
    if (prepared.status !== 'ready') throw new Error('expected a plan')

    // The merge begins after the review and before the confirmation.
    await git('git', ['merge', 'side'], { cwd: root }).catch(() => undefined)
    const applied = await undo.apply({ sessionId: SESSION, operationId: prepared.operationId })

    expect(applied).toEqual({ status: 'blocked', state: 'merge' })
    expect(recorded).toEqual([])
    await expect(readFile(join(root, 'other.ts'), 'utf8')).resolves.toBe('agent\n')
  })

  it('reports the restoration even when its record could not be written', async () => {
    await ranAndChanged()
    const undo = new RunUndoService({
      store,
      session: () => Promise.resolve(session()),
      recordAppAction: vi.fn(() => Promise.reject(new Error('Core unavailable')))
    })
    const prepared = await undo.prepare({ sessionId: SESSION, runId: RUN })
    if (prepared.status !== 'ready') throw new Error('expected a plan')

    await expect(
      undo.apply({ sessionId: SESSION, operationId: prepared.operationId })
    ).resolves.toMatchObject({ status: 'restored' })
    await expect(readFile(join(root, 'tracked.ts'), 'utf8')).resolves.toBe('base\n')
  })
})
