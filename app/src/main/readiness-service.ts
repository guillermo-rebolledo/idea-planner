import type { ProviderId, ProviderReadiness, ReadinessSnapshot } from '@shared/readiness'
import { providerIdSchema } from '@shared/readiness'
import {
  PROVIDER_SPECS,
  SKILLS_INSTALL_COMMAND,
  discoverPathEntries,
  probeProvider,
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

const PROVIDER_IDS = providerIdSchema.options

/**
 * Owns the cached readiness snapshot in Main. Probing happens on demand and
 * on explicit “Check again”; results are never persisted, so every launch
 * reflects the machine as it is now.
 */
export class ReadinessService {
  private snapshot: ReadinessSnapshot | null = null
  private inFlight: Promise<ReadinessSnapshot> | null = null

  constructor(private readonly options: ReadinessServiceOptions) {}

  async get(): Promise<ReadinessSnapshot> {
    return this.snapshot ?? this.refresh()
  }

  async refresh(provider?: ProviderId): Promise<ReadinessSnapshot> {
    // A full refresh already in flight answers concurrent requests.
    if (!provider && this.inFlight) return this.inFlight
    const work = this.probe(provider)
    if (!provider) {
      this.inFlight = work.finally(() => {
        this.inFlight = null
      })
      return this.inFlight
    }
    return work
  }

  async setExplicitExecutable(provider: ProviderId, path: string): Promise<ReadinessSnapshot> {
    const { settings } = this.options
    settings.update({
      providerExecutables: { ...settings.get().providerExecutables, [provider]: path }
    })
    return this.refresh(provider)
  }

  async clearExplicitExecutable(provider: ProviderId): Promise<ReadinessSnapshot> {
    const { settings } = this.options
    const providerExecutables = Object.fromEntries(
      Object.entries(settings.get().providerExecutables).filter(([key]) => key !== provider)
    )
    settings.update({ providerExecutables })
    return this.refresh(provider)
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

  private async probe(provider?: ProviderId): Promise<ReadinessSnapshot> {
    const discovered = await this.discover()
    const settings = this.options.settings.get()

    const probeOne = (id: ProviderId): Promise<ProviderReadiness> =>
      probeProvider(PROVIDER_SPECS[id], {
        pathEntries: discovered.entries,
        explicitExecutable: settings.providerExecutables[id],
        homeDir: this.options.homeDir,
        probeTimeoutMs: this.options.probeTimeoutMs
      })

    const previous = this.snapshot
    const providers = await Promise.all(
      PROVIDER_IDS.map(async (id) => {
        if (provider && id !== provider) {
          const kept = previous?.providers.find((entry) => entry.provider === id)
          if (kept) return kept
        }
        return probeOne(id)
      })
    )

    this.snapshot = {
      providers,
      pathSources: discovered.sources,
      loginShellConsent: settings.loginShellDiscovery !== null,
      skillsInstallCommand: SKILLS_INSTALL_COMMAND
    }
    return this.snapshot
  }
}
