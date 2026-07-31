import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { themePreferenceSchema, type ThemePreference } from '@shared/contract'

const settingsSchema = z.object({
  libraryPath: z.string().min(1).optional(),
  themePreference: themePreferenceSchema.default('system'),
  /** Days without activity after which a pinned Idea shows as Dormant. */
  dormantAfterDays: z.number().int().positive().default(14)
})

export interface Settings {
  libraryPath?: string
  themePreference: ThemePreference
  dormantAfterDays: number
}

/**
 * Tiny app-level settings file in userData. Never part of an Idea Library:
 * losing it can never lose an Idea.
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
      // Missing or corrupt settings fall back to defaults; Ideas live elsewhere.
    }
    return { themePreference: 'system', dormantAfterDays: 14 }
  }
}
