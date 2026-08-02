import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cause, Effect, Exit } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeJsonAtomic } from './atomic'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'atomic-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** Unwraps the typed failure the way the Core interface does for its callers. */
async function run<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}

describe('writing a durable record', () => {
  it('writes the record and leaves nothing beside it', async () => {
    const path = join(directory, 'record.json')

    await run(writeJsonAtomic(path, { id: 'one' }))

    await expect(readFile(path, 'utf8')).resolves.toBe('{\n  "id": "one"\n}\n')
    // A staged file left behind is litter that outlives the write.
    expect(await readdir(directory)).toEqual(['record.json'])
  })

  it('replaces a record without ever leaving a partial one in its place', async () => {
    const path = join(directory, 'record.json')
    await run(writeJsonAtomic(path, { id: 'one' }))

    await run(writeJsonAtomic(path, { id: 'two', extra: 'x'.repeat(100_000) }))

    const raw = await readFile(path, 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ id: 'two' })
    expect(await readdir(directory)).toEqual(['record.json'])
  })

  it('creates the directories a record needs', async () => {
    const path = join(directory, 'deep', 'deeper', 'record.json')

    await run(writeJsonAtomic(path, { id: 'nested' }))

    await expect(readFile(path, 'utf8')).resolves.toContain('nested')
  })

  it('cleans up after itself when the write cannot land', async () => {
    // A directory where the record should go: writing fails, and the staged
    // file must not survive the attempt.
    const path = join(directory, 'record.json')
    await writeFile(join(directory, 'record.json.staged'), 'stale')
    const { mkdir } = await import('node:fs/promises')
    await rm(join(directory, 'record.json.staged'))
    await mkdir(path)

    await expect(run(writeJsonAtomic(path, { id: 'doomed' }))).rejects.toMatchObject({
      code: 'IO_ERROR'
    })

    expect(await readdir(directory)).toEqual(['record.json'])
  })
})
