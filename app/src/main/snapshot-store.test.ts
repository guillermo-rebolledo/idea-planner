import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionSnapshotStore } from './snapshot-store'
import { testGit as git } from './git-test-support'

let checkout: string
let privateRoot: string
let store: SessionSnapshotStore

beforeEach(async () => {
  checkout = await mkdtemp(join(tmpdir(), 'snapshot-store-checkout-'))
  privateRoot = await mkdtemp(join(tmpdir(), 'snapshot-store-private-'))
  store = new SessionSnapshotStore(privateRoot)
  await git('git', ['init', '--quiet', '-b', 'main'], { cwd: checkout })
  await writeFile(join(checkout, 'tracked.ts'), 'base\n')
  await git('git', ['add', '-A'], { cwd: checkout })
  await git(
    'git',
    ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'init'],
    { cwd: checkout }
  )
})

afterEach(async () => {
  await Promise.all([
    rm(checkout, { recursive: true, force: true }),
    rm(privateRoot, { recursive: true, force: true })
  ])
})

describe('a Session’s snapshot store', () => {
  it('keeps both halves of a Run under one record', async () => {
    await store.capture({ sessionId: 's', runId: 'r', checkout, phase: 'before' })
    await writeFile(join(checkout, 'tracked.ts'), 'agent\n')
    await store.capture({ sessionId: 's', runId: 'r', checkout, phase: 'after' })

    const record = await store.read('s', 'r')
    expect(record).toMatchObject({ sessionId: 's', runId: 'r', checkout })
    expect(record?.before).toEqual(expect.any(String))
    expect(record?.after).toEqual(expect.any(String))
    expect(record?.before).not.toBe(record?.after)
  })

  it('compares the original Session baseline with the publishable Checkout now', async () => {
    await store.capture({ sessionId: 's', runId: 'r', checkout, phase: 'before' })
    await writeFile(join(checkout, 'tracked.ts'), 'temporary\n')
    await store.capture({ sessionId: 's', runId: 'r', checkout, phase: 'after' })
    await writeFile(join(checkout, 'tracked.ts'), 'base\n')
    await writeFile(join(checkout, 'published.ts'), 'ship this\n')

    await expect(store.compareCurrent('s', checkout)).resolves.toMatchObject({
      changes: [{ path: 'published.ts', changeKind: 'added' }],
      unlisted: 0
    })
  })

  it('reviews a Local commit only from a clean baseline and unchanged index', async () => {
    await store.capture({ sessionId: 's', runId: 'r', checkout, phase: 'before' })
    await writeFile(join(checkout, 'published.ts'), 'ship this\n')

    const safety = await store.localPublishSafety('s', checkout)

    expect(safety.status).toBe('safe')
    if (safety.status !== 'safe') throw new Error(safety.detail)
    expect(typeof safety.expectedTree).toBe('string')
    expect(safety.comparison).toMatchObject({
      changes: [{ path: 'published.ts', changeKind: 'added' }],
      unlisted: 0
    })
  })

  it('refuses a Local commit when the Session began with uncommitted work', async () => {
    await writeFile(join(checkout, 'mine.ts'), 'already here\n')
    await store.capture({ sessionId: 's', runId: 'r', checkout, phase: 'before' })
    await writeFile(join(checkout, 'published.ts'), 'ship this\n')

    const safety = await store.localPublishSafety('s', checkout)
    expect(safety.status).toBe('unavailable')
    if (safety.status !== 'unavailable') throw new Error('Local publishing was unexpectedly safe')
    expect(safety.detail).toContain('already modified')
  })

  it('refuses a Local commit while the person has staged changes', async () => {
    await store.capture({ sessionId: 's', runId: 'r', checkout, phase: 'before' })
    await writeFile(join(checkout, 'published.ts'), 'ship this\n')
    await git('git', ['add', 'published.ts'], { cwd: checkout })

    const safety = await store.localPublishSafety('s', checkout)
    expect(safety.status).toBe('unavailable')
    if (safety.status !== 'unavailable') throw new Error('Local publishing was unexpectedly safe')
    expect(safety.detail).toContain('Unstage')
  })

  // A shell that came from a git hook exports `GIT_DIR` and `GIT_INDEX_FILE`,
  // and an app launched from one inherits them. Both answers behind this
  // decision are about the person's Checkout, so neither may be given by
  // whatever repository the environment happens to point at.
  it('asks about the Checkout even when the environment points somewhere else', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'snapshot-store-elsewhere-'))
    try {
      await git('git', ['init', '--quiet', '-b', 'main'], { cwd: elsewhere })
      await writeFile(join(elsewhere, 'theirs.ts'), 'staged over there\n')
      await git('git', ['add', '-A'], { cwd: elsewhere })
      await store.capture({ sessionId: 's', runId: 'r', checkout, phase: 'before' })
      await writeFile(join(checkout, 'published.ts'), 'ship this\n')

      process.env['GIT_DIR'] = join(elsewhere, '.git')
      process.env['GIT_INDEX_FILE'] = join(elsewhere, '.git', 'index')
      const safety = await store.localPublishSafety('s', checkout)

      expect(safety.status).toBe('safe')
      if (safety.status !== 'safe') throw new Error(safety.detail)
      expect(safety.comparison).toMatchObject({
        changes: [{ path: 'published.ts', changeKind: 'added' }]
      })
    } finally {
      delete process.env['GIT_DIR']
      delete process.env['GIT_INDEX_FILE']
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('stores one copy of content two Runs left identical', async () => {
    await store.capture({ sessionId: 's', runId: 'one', checkout, phase: 'before' })
    await store.capture({ sessionId: 's', runId: 'two', checkout, phase: 'before' })

    const one = await store.read('s', 'one')
    const two = await store.read('s', 'two')
    // Content-addressed by construction: the same tree is the same object id.
    expect(one?.before).toBe(two?.before)
  })

  it('says nothing rather than something wrong when a record cannot be read', async () => {
    await expect(store.read('s', 'never-ran')).resolves.toBeNull()
    await store.capture({ sessionId: 's', runId: 'r', checkout, phase: 'before' })
    await writeFile(
      join(privateRoot, 'session-snapshots', 's', 'runs', 'r.json'),
      'not json at all'
    )
    await expect(store.read('s', 'r')).resolves.toBeNull()
  })

  it('records a skipped capture as no tree, so undo is honestly unavailable', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'snapshot-store-plain-'))

    await expect(
      store.capture({ sessionId: 's', runId: 'r', checkout: plain, phase: 'before' })
    ).resolves.toEqual({ status: 'skipped', reason: 'not-a-repository' })

    expect(await store.read('s', 'r')).toMatchObject({ before: null, after: null })
    await rm(plain, { recursive: true, force: true })
  })

  it('keeps one Session’s store when another is forgotten', async () => {
    await store.capture({ sessionId: 'kept', runId: 'r', checkout, phase: 'before' })
    await store.capture({ sessionId: 'deleted', runId: 'r', checkout, phase: 'before' })

    await store.forget('deleted')

    expect(await store.read('kept', 'r')).not.toBeNull()
    expect(await store.read('deleted', 'r')).toBeNull()
    await expect(access(store.directoryFor('deleted'))).rejects.toThrow()
  })

  it('forgets a Session that never had a store without complaining', async () => {
    await expect(store.forget('never-existed')).resolves.toBeUndefined()
  })

  it('prunes only stores no Session claims', async () => {
    await store.capture({ sessionId: 'alive', runId: 'r', checkout, phase: 'before' })
    await store.capture({ sessionId: 'orphan', runId: 'r', checkout, phase: 'before' })

    await store.pruneUnknown(new Set(['alive']))

    expect(await store.read('alive', 'r')).not.toBeNull()
    expect(await store.read('orphan', 'r')).toBeNull()
  })

  it('survives a Session id that is not a safe directory name', async () => {
    const awkward = 'a/../b session'
    await store.capture({ sessionId: awkward, runId: 'r/../x', checkout, phase: 'before' })

    expect(await store.read(awkward, 'r/../x')).toMatchObject({ sessionId: awkward })
    await store.pruneUnknown(new Set([awkward]))
    expect(await store.read(awkward, 'r/../x')).not.toBeNull()
  })

  it('clears working files a crash left behind mid-capture', async () => {
    await store.capture({ sessionId: 's', runId: 'r', checkout, phase: 'before' })
    const scratch = join(store.directoryFor('s'), 'scratch')
    await writeFile(join(scratch, 'index-left-over'), 'stale')

    await store.clearScratch('s')

    await expect(readdir(scratch)).rejects.toThrow()
    // The objects and the record it captured are untouched by the sweep.
    expect((await store.read('s', 'r'))?.before).toEqual(expect.any(String))
  })
})
