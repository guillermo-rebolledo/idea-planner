import type { HarnessId, HarnessReadiness, ReadinessSnapshot } from '@shared/readiness'
import { harnessIdSchema } from '@shared/readiness'
import {
  HARNESS_SPECS,
  SKILLS_INSTALL_COMMAND,
  discoverPathEntries,
  probeHarness,
  type DiscoveredPath
} from './readiness'
import type { SettingsStore } from './settings'

export interface ReadinessServiceOptions {
  settings: SettingsStore
  homeDir: string
  /** Test seam: replaces discovery entirely with this PATH value. */
  testPathOverride?: string
  probeTimeoutMs?: number
}

const HARNESS_IDS = harnessIdSchema.options

/**
 * Owns the cached readiness snapshot in Main. Probing happens on demand and
 * on explicit “Check again”; results are never persisted, so every launch
 * reflects the machine as it is now.
 */
export class ReadinessService {
  private snapshot: ReadinessSnapshot | null = null
  private inFlightFull: Promise<ReadinessSnapshot> | null = null
  /** All probing is serialized so overlapping refreshes cannot clobber. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: ReadinessServiceOptions) {}

  async get(): Promise<ReadinessSnapshot> {
    return this.snapshot ?? this.refresh()
  }

  async refresh(harness?: HarnessId): Promise<ReadinessSnapshot> {
    if (harness) return this.enqueue(() => this.probe(harness))
    // A full refresh already in flight answers concurrent requests.
    this.inFlightFull ??= this.enqueue(() => this.probe()).finally(() => {
      this.inFlightFull = null
    })
    return this.inFlightFull
  }

  private enqueue(work: () => Promise<ReadinessSnapshot>): Promise<ReadinessSnapshot> {
    const result = this.queue.then(work, work)
    this.queue = result.catch(() => undefined)
    return result
  }

  async setExplicitExecutable(harness: HarnessId, path: string): Promise<ReadinessSnapshot> {
    const { settings } = this.options
    settings.update({
      harnessExecutables: { ...settings.get().harnessExecutables, [harness]: path }
    })
    return this.refresh(harness)
  }

  async clearExplicitExecutable(harness: HarnessId): Promise<ReadinessSnapshot> {
    const { settings } = this.options
    const harnessExecutables = Object.fromEntries(
      Object.entries(settings.get().harnessExecutables).filter(([key]) => key !== harness)
    )
    settings.update({ harnessExecutables })
    return this.refresh(harness)
  }

  async setLoginShellDiscovery(consent: boolean): Promise<ReadinessSnapshot> {
    this.options.settings.update({
      loginShellDiscovery: consent ? { grantedAt: new Date().toISOString() } : null
    })
    // Consent changes what discovery may consult, so re-probe everything.
    return this.refresh()
  }

  private async discover(): Promise<DiscoveredPath> {
    if (this.options.testPathOverride !== undefined) {
      return {
        entries: this.options.testPathOverride.split(':').filter((entry) => entry.length > 0),
        sources: ['inherited']
      }
    }
    return discoverPathEntries({
      inheritedPath: process.env['PATH'],
      loginShellConsent: this.options.settings.get().loginShellDiscovery !== null
    })
  }

  private async probe(harness?: HarnessId): Promise<ReadinessSnapshot> {
    const discovered = await this.discover()
    const settings = this.options.settings.get()

    const probeOne = (id: HarnessId): Promise<HarnessReadiness> =>
      probeHarness(HARNESS_SPECS[id], {
        pathEntries: discovered.entries,
        explicitExecutable: settings.harnessExecutables[id],
        homeDir: this.options.homeDir,
        probeTimeoutMs: this.options.probeTimeoutMs
      })

    const previous = this.snapshot
    const harnesses = await Promise.all(
      HARNESS_IDS.map(async (id) => {
        if (harness && id !== harness) {
          const kept = previous?.harnesses.find((entry) => entry.harness === id)
          if (kept) return kept
        }
        return probeOne(id)
      })
    )

    this.snapshot = {
      harnesses,
      pathSources: discovered.sources,
      loginShellConsent: settings.loginShellDiscovery !== null,
      skillsInstallCommand: SKILLS_INSTALL_COMMAND
    }
    return this.snapshot
  }
}
