import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APPEARANCE_SETTINGS,
  appearanceSettingsSchema,
  derivePalette,
  resolveAppearance,
  setCustomThemeSharing
} from './theme'

describe('appearance settings', () => {
  it('starts custom Light and Dark once with readable neutral backgrounds', () => {
    expect(appearanceSettingsSchema.parse({})).toEqual(DEFAULT_APPEARANCE_SETTINGS)
    expect(DEFAULT_APPEARANCE_SETTINGS.custom.light.background).toBe('#ffffff')
    expect(DEFAULT_APPEARANCE_SETTINGS.custom.dark.background).toBe('#000000')
  })

  it('keeps independent mode colors and chooses the current system mode', () => {
    const appearance = appearanceSettingsSchema.parse({
      preference: 'custom',
      custom: {
        ...DEFAULT_APPEARANCE_SETTINGS.custom,
        light: { background: '#fff8e8', accent: '#6b4fd3' },
        dark: { background: '#101820', accent: '#8eb8ff' }
      }
    })

    expect(resolveAppearance(appearance, 'light').definition).toEqual({
      background: '#fff8e8',
      accent: '#6b4fd3'
    })
    expect(resolveAppearance(appearance, 'dark').definition).toEqual({
      background: '#101820',
      accent: '#8eb8ff'
    })
  })

  it('uses shared colors without destroying either mode pair', () => {
    const custom = {
      ...DEFAULT_APPEARANCE_SETTINGS.custom,
      useForBoth: true,
      shared: { background: '#282828', accent: '#f4a261' }
    }
    const appearance = appearanceSettingsSchema.parse({ preference: 'custom', custom })

    expect(resolveAppearance(appearance, 'light').definition).toEqual(custom.shared)
    expect(resolveAppearance(appearance, 'dark').definition).toEqual(custom.shared)
    expect(appearance.custom.light).toEqual(DEFAULT_APPEARANCE_SETTINGS.custom.light)
    expect(appearance.custom.dark).toEqual(DEFAULT_APPEARANCE_SETTINGS.custom.dark)
  })

  it('initializes shared colors once and never overwrites the user choice later', () => {
    const initialized = setCustomThemeSharing(DEFAULT_APPEARANCE_SETTINGS.custom, true, 'dark')
    expect(initialized.shared).toEqual(DEFAULT_APPEARANCE_SETTINGS.custom.dark)
    expect(initialized.light).toEqual(DEFAULT_APPEARANCE_SETTINGS.custom.light)
    expect(initialized.dark).toEqual(DEFAULT_APPEARANCE_SETTINGS.custom.dark)

    const chosen = { ...initialized, shared: { background: '#232323', accent: '#ffbb66' } }
    const disabled = setCustomThemeSharing(chosen, false, 'light')
    expect(setCustomThemeSharing(disabled, true, 'light').shared).toEqual(chosen.shared)
  })

  it('resolves Graphite and Orchid into readable preset palettes', () => {
    const graphite = resolveAppearance(
      { ...DEFAULT_APPEARANCE_SETTINGS, preference: 'graphite' },
      'light'
    )
    const orchid = resolveAppearance(
      { ...DEFAULT_APPEARANCE_SETTINGS, preference: 'orchid' },
      'dark'
    )

    if (!graphite.palette || !orchid.palette) throw new Error('Preset palette was not resolved')
    expect(graphite.resolved).toBe('dark')
    expect(graphite.palette.background).toBe('#171717')
    expect(
      contrast(graphite.palette.foreground, graphite.palette.background)
    ).toBeGreaterThanOrEqual(4.5)
    expect(orchid.resolved).toBe('light')
    expect(orchid.palette.primary).toBe('#7850a6')
    expect(contrast(orchid.palette.foreground, orchid.palette.background)).toBeGreaterThanOrEqual(
      4.5
    )
  })

  it('derives visual polarity from the background rather than the editor slot', () => {
    const appearance = appearanceSettingsSchema.parse({
      preference: 'custom',
      custom: {
        ...DEFAULT_APPEARANCE_SETTINGS.custom,
        useForBoth: true,
        shared: { background: '#000000', accent: '#3869b2' }
      }
    })

    const resolved = resolveAppearance(appearance, 'light')
    expect(resolved.resolved).toBe('dark')
    expect(resolved.palette?.background).toBe('#000000')
    expect(resolved.palette?.surface).not.toBe('#000000')
    expect(resolved.palette?.foreground).toBe('#ffffff')
  })
})

describe('a derived custom palette', () => {
  for (const definition of [
    { background: '#000000', accent: '#000000' },
    { background: '#ffffff', accent: '#ffffff' },
    { background: '#777777', accent: '#777777' },
    { background: '#101814', accent: '#71c598' },
    { background: '#fff8e8', accent: '#6b4fd3' }
  ]) {
    it(`keeps semantic roles readable for ${definition.background} and ${definition.accent}`, () => {
      const palette = derivePalette(definition)
      expect(contrast(palette.foreground, palette.background)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.foreground, palette.surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.mutedForeground, palette.background)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.mutedForeground, palette.surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.primary, palette.background)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.primary, palette.surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.primaryForeground, palette.primary)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.primaryForeground, palette.primaryHover)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.ring, palette.background)).toBeGreaterThanOrEqual(3)
      expect(contrast(palette.ring, palette.surface)).toBeGreaterThanOrEqual(3)
      expect(contrast(palette.border, palette.background)).toBeGreaterThanOrEqual(1.2)
      expect(contrast(palette.border, palette.surface)).toBeGreaterThanOrEqual(1.2)
      for (const [role, semantic] of Object.entries({
        positive: palette.positive,
        destructive: palette.destructive,
        noticeForeground: palette.noticeForeground,
        diffAddedForeground: palette.diffAddedForeground,
        diffRemovedForeground: palette.diffRemovedForeground,
        statusRunning: palette.statusRunning,
        statusBlocked: palette.statusBlocked,
        statusIdle: palette.statusIdle,
        statusFailed: palette.statusFailed
      })) {
        expect(
          contrast(semantic, palette.background),
          `${role} on background`
        ).toBeGreaterThanOrEqual(4.5)
        expect(contrast(semantic, palette.surface), `${role} on surface`).toBeGreaterThanOrEqual(
          4.5
        )
      }
      expect(
        contrast(palette.diffAddedForeground, palette.diffAddedSurface)
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrast(palette.diffRemovedForeground, palette.diffRemovedSurface)
      ).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.statusBlocked, palette.statusBlockedSurface)).toBeGreaterThanOrEqual(
        4.5
      )
      expect(contrast(palette.noticeForeground, palette.notice)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.noticeBorder, palette.notice)).toBeGreaterThanOrEqual(3)
      expect(
        contrast(palette.statusBlockedBorder, palette.statusBlockedSurface)
      ).toBeGreaterThanOrEqual(3)
    })
  }
})

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a) as [number, number]
  return (values[0] + 0.05) / (values[1] + 0.05)
}

function luminance(value: string): number {
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(value.slice(1 + offset, 3 + offset), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}
