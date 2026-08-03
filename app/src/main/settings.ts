import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  editorIdSchema,
  themePreferenceSchema,
  type EditorId,
  type ThemePreference
} from '@shared/contract'

const settingsSchema = z.object({
  themePreference: themePreferenceSchema.default('system'),
  /** Days without activity after which a pinned Session shows as Dormant. */
  dormantAfterDays: z.number().int().positive().default(14),
  /** Explicitly selected Harness executables; absence means PATH resolution. */
  harnessExecutables: z.record(z.string().min(1)).default({}),
  /** One-time informed consent for bounded login-shell PATH discovery. */
  loginShellDiscovery: z.object({ grantedAt: z.string() }).nullable().default(null),
  /** What "Open in" opened last, which is what the chip opens next. */
  lastEditor: editorIdSchema.nullable().default(null)
})

export interface Settings {
  themePreference: ThemePreference
  dormantAfterDays: number
  harnessExecutables: Record<string, string>
  loginShellDiscovery: { grantedAt: string } | null
  lastEditor: EditorId | null
}

/**
 * Tiny app-level settings file in userData. It holds preferences only:
 * losing it can never lose a Session.
 */
export class SettingsStore {
  private readonly filePath: string
  private current: Settings

  constructor(userDataDir: string) {
    this.filePath = join(userDataDir, 'settings.json')
    this.current = this.read()
  }

  get(): Settings {
    return this.current
  }

  update(patch: Partial<Settings>): Settings {
    this.current = { ...this.current, ...patch }
    mkdirSync(dirname(this.filePath), { recursive: true })
    const staged = `${this.filePath}.staged`
    writeFileSync(staged, `${JSON.stringify(this.current, null, 2)}\n`, 'utf8')
    renameSync(staged, this.filePath)
    return this.current
  }

  private read(): Settings {
    try {
      const parsed = settingsSchema.safeParse(JSON.parse(readFileSync(this.filePath, 'utf8')))
      if (parsed.success) return parsed.data
    } catch {
      // Missing or corrupt settings fall back to defaults; Sessions live elsewhere.
    }
    return {
      themePreference: 'system',
      dormantAfterDays: 14,
      harnessExecutables: {},
      loginShellDiscovery: null,
      lastEditor: null
    }
  }
}
