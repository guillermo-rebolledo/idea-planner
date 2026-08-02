import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Effect } from 'effect'
import { CoreError } from '@shared/contract'

/**
 * Writes a JSON file so that it either lands whole or not at all.
 *
 * Every durable record in the app-owned store depends on this: a record exists
 * if and only if it parses, so a half-written one must never be left where a
 * reader can find it. Staged beside the target and renamed, because rename is
 * the only step the filesystem gives us that cannot be observed half-done.
 */
export function writeJsonAtomic(path: string, value: unknown): Effect.Effect<void, CoreError> {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true })
      const staged = `${path}.staged`
      let renamed = false
      try {
        await writeFile(staged, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
        await rename(staged, path)
        renamed = true
      } finally {
        // A staged file that never became the record is litter, whether the
        // write or the rename was what failed.
        if (!renamed) await rm(staged, { force: true })
      }
    },
    catch: () => new CoreError('IO_ERROR', `Could not save ${path}`)
  })
}
