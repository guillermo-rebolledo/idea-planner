import { z } from 'zod'
import { isNewerVersion, type UpdateAvailability } from '@shared/update'

/**
 * Whether a newer Argos has been published, and where to go and get it.
 *
 * The whole of this module is a read. It learns a version and a URL; it never
 * downloads, replaces, or relaunches anything (ADR 0009). What it finds is
 * offered, and taking it is the person's own action in their own browser.
 *
 * Nothing waits on it. The check runs after the app is already up, off every
 * path a person can be standing on, and a check that fails leaves the app
 * exactly as quiet as one that found nothing.
 */

/** The fields of a published release this app reads. GitHub sends far more. */
const releaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string()
})

const ONE_DAY_MS = 24 * 60 * 60 * 1000

export interface UpdateServiceOptions {
  /** What is running, from the bundle — never a second copy of the version. */
  installedVersion: string
  /** The published-release feed, derived from the identity (`identity.ts`). */
  feedUrl: string
  /** The only prefix a release URL may have before it reaches a browser. */
  releasePagePrefix: string
  /** Told once, when a version worth mentioning is first found. */
  onAvailable?: (availability: UpdateAvailability) => void
  /** Test seam: answers the feed without a network. */
  fetchImpl?: typeof globalThis.fetch
  /** A check that has not answered by now is a check nobody is waiting for. */
  timeoutMs?: number
  /** How often a window left open for days asks again. */
  intervalMs?: number
}

export class UpdateService {
  private known: UpdateAvailability
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight: Promise<UpdateAvailability> | null = null

  constructor(private readonly options: UpdateServiceOptions) {
    this.known = { installed: options.installedVersion, available: null }
  }

  /** What is known right now. Cached, immediate, and never a network call. */
  latest(): UpdateAvailability {
    return this.known
  }

  /**
   * The release to open, or null when there is nothing to take. Main holds
   * this so the Renderer can ask for the update without naming a URL, the
   * same way it publishes a Pull Request it never addresses (ADR 0007).
   */
  releaseUrl(): string | null {
    return this.known.available?.url ?? null
  }

  /** Asks now, then keeps asking, without ever holding anything up. */
  start(): void {
    if (this.timer) return
    void this.check()
    this.timer = setInterval(() => void this.check(), this.options.intervalMs ?? ONE_DAY_MS)
    // A timer for a courtesy must never be the reason a process stays alive.
    this.timer.unref()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * One look at the feed. It resolves, always: an unreachable network, a
   * refusal, a timeout, or a body that is not what this app publishes all
   * leave what was already known untouched and say nothing.
   */
  async check(): Promise<UpdateAvailability> {
    this.inFlight ??= this.read().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async read(): Promise<UpdateAvailability> {
    const found = await this.readFeed()
    // Only an answer that was actually understood replaces what is known. A
    // failed check is not evidence that the update it found last time is gone.
    if (found === undefined) return this.known
    const changed = found?.version !== this.known.available?.version
    this.known = { installed: this.options.installedVersion, available: found }
    if (changed && found) this.options.onAvailable?.(this.known)
    return this.known
  }

  /** The parsed feed, or undefined when the check itself did not land. */
  private async readFeed(): Promise<UpdateAvailability['available'] | undefined> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch
    try {
      const response = await fetchImpl(this.options.feedUrl, {
        headers: { accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000)
      })
      if (!response.ok) return undefined
      const release = releaseSchema.safeParse(await response.json())
      if (!release.success) return undefined

      const version = release.data.tag_name.trim().replace(/^v/u, '')
      if (!isNewerVersion(release.data.tag_name, this.options.installedVersion)) return null
      // The version is newer, but the address came over the network. It is
      // taken only if it is a release of this app, published where this app is
      // published; anything else is a URL nobody in this repository chose.
      if (!release.data.html_url.startsWith(this.options.releasePagePrefix)) return null
      return { version, url: release.data.html_url }
    } catch {
      return undefined
    }
  }
}
