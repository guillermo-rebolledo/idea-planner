import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { reviewSchema, type Review } from '@shared/review'

const RECORDS = 'reviews'

/**
 * The last Review each Session was given, kept beside the app rather than in
 * any Project: a Review is something the app was told, not something the
 * repository holds. Archive keeps it and Delete removes it, exactly as the
 * Session's other app-owned records are treated.
 */
export class ReviewStore {
  constructor(private readonly privateRoot: string) {}

  async read(sessionId: string): Promise<Review | null> {
    const text = await readFile(this.pathFor(sessionId), 'utf8').catch(() => '')
    if (!text) return null
    try {
      const parsed = reviewSchema.safeParse(JSON.parse(text))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  async write(sessionId: string, review: Review): Promise<void> {
    await mkdir(join(this.privateRoot, RECORDS), { recursive: true, mode: 0o700 })
    const path = this.pathFor(sessionId)
    const staged = `${path}.staged`
    let renamed = false
    try {
      await writeFile(staged, JSON.stringify(reviewSchema.parse(review)), { mode: 0o600 })
      await rename(staged, path)
      renamed = true
    } finally {
      if (!renamed) await rm(staged, { force: true }).catch(() => undefined)
    }
  }

  async forget(sessionId: string): Promise<void> {
    await rm(this.pathFor(sessionId), { force: true })
  }

  async pruneUnknown(known: ReadonlySet<string>): Promise<void> {
    const root = join(this.privateRoot, RECORDS)
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const sessionId = decodeURIComponent(entry.name.slice(0, -'.json'.length))
      if (!known.has(sessionId)) await rm(join(root, entry.name), { force: true })
    }
  }

  private pathFor(sessionId: string): string {
    return join(this.privateRoot, RECORDS, `${encodeURIComponent(sessionId)}.json`)
  }
}
