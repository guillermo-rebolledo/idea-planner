import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pullRequestSchema, type PullRequest } from '@shared/pull-request'

const RECORDS = 'pull-requests'

/** App-owned association between a Session and the PR it explicitly created. */
export class PullRequestStore {
  constructor(private readonly privateRoot: string) {}

  async read(sessionId: string): Promise<PullRequest | null> {
    const text = await readFile(this.pathFor(sessionId), 'utf8').catch(() => '')
    if (!text) return null
    try {
      const parsed = pullRequestSchema.safeParse(JSON.parse(text))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  async write(sessionId: string, pullRequest: PullRequest): Promise<void> {
    const root = join(this.privateRoot, RECORDS)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const path = this.pathFor(sessionId)
    const staged = `${path}.staged`
    let renamed = false
    try {
      await writeFile(staged, JSON.stringify(pullRequestSchema.parse(pullRequest)), { mode: 0o600 })
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
