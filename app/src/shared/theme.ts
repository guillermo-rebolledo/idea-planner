import { z } from 'zod'

/** The window exists before the Renderer, so Main needs the audited preset page colors. */
export const WINDOW_BACKGROUND = {
  light: '#f4f4f6',
  dark: '#0e0f11'
} as const

export type ResolvedTheme = keyof typeof WINDOW_BACKGROUND
export type ThemePreference = 'system' | 'light' | 'dark' | 'graphite' | 'orchid' | 'custom'

export interface ThemeColors {
  background: string
  accent: string
}

export interface CustomTheme {
  name: string
  useForBoth: boolean
  sharedInitialized: boolean
  shared: ThemeColors
  light: ThemeColors
  dark: ThemeColors
}

export interface AppearanceSettings {
  preference: ThemePreference
  custom: CustomTheme
}

export interface ThemePalette {
  background: string
  surface: string
  surfaceRaised: string
  muted: string
  border: string
  foreground: string
  mutedForeground: string
  accent: string
  accentForeground: string
  primary: string
  primaryHover: string
  primaryForeground: string
  ring: string
}

export interface ResolvedAppearance {
  resolved: ResolvedTheme
  palette: ThemePalette | null
  definition: ThemeColors | null
}

export const DEFAULT_CUSTOM_THEME: CustomTheme = {
  name: 'My Theme',
  useForBoth: false,
  sharedInitialized: false,
  shared: { background: '#ffffff', accent: '#3869b2' },
  light: { background: '#ffffff', accent: '#3869b2' },
  dark: { background: '#000000', accent: '#7aa2d8' }
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  preference: 'system',
  custom: DEFAULT_CUSTOM_THEME
}

const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((value) => value.toLowerCase())

export const themeColorsSchema = z.object({
  background: hexColorSchema,
  accent: hexColorSchema
})

export const customThemeSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    useForBoth: z.boolean(),
    sharedInitialized: z.boolean().default(false),
    shared: themeColorsSchema,
    light: themeColorsSchema,
    dark: themeColorsSchema
  })
  .default(DEFAULT_CUSTOM_THEME)

export const themePreferenceSchema = z
  .enum(['system', 'light', 'dark', 'graphite', 'orchid', 'custom'])
  .default('system')

export const resolvedThemeSchema = z.enum(['light', 'dark'])

export const appearanceSettingsSchema = z.object({
  preference: themePreferenceSchema,
  custom: customThemeSchema
})

export const themePaletteSchema = z.object({
  background: hexColorSchema,
  surface: hexColorSchema,
  surfaceRaised: hexColorSchema,
  muted: hexColorSchema,
  border: hexColorSchema,
  foreground: hexColorSchema,
  mutedForeground: hexColorSchema,
  accent: hexColorSchema,
  accentForeground: hexColorSchema,
  primary: hexColorSchema,
  primaryHover: hexColorSchema,
  primaryForeground: hexColorSchema,
  ring: hexColorSchema
})

export const PRESET_COLORS = {
  light: { background: WINDOW_BACKGROUND.light, accent: '#3869b2' },
  dark: { background: WINDOW_BACKGROUND.dark, accent: '#7aa2d8' },
  graphite: { background: '#171717', accent: '#d2a76f' },
  orchid: { background: '#f4f0f7', accent: '#7850a6' }
} as const satisfies Record<'light' | 'dark' | 'graphite' | 'orchid', ThemeColors>

export const APPEARANCE_PRESETS: readonly {
  id: Exclude<ThemePreference, 'custom'>
  name: string
  description: string
  definition: ThemeColors | null
}[] = [
  { id: 'system', name: 'System', description: 'Follows macOS', definition: null },
  { id: 'light', name: 'Light', description: 'Quiet and bright', definition: null },
  { id: 'dark', name: 'Dark', description: 'The original', definition: null },
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Neutral and dense',
    definition: PRESET_COLORS.graphite
  },
  {
    id: 'orchid',
    name: 'Orchid',
    description: 'Soft violet ink',
    definition: PRESET_COLORS.orchid
  }
]

/** Resolves the active preset or the custom colors for the current macOS appearance. */
export function resolveAppearance(
  appearance: AppearanceSettings,
  systemResolved: ResolvedTheme
): ResolvedAppearance {
  if (appearance.preference === 'system') {
    return { resolved: systemResolved, palette: null, definition: null }
  }
  if (appearance.preference === 'light' || appearance.preference === 'dark') {
    return { resolved: appearance.preference, palette: null, definition: null }
  }

  const definition =
    appearance.preference === 'custom'
      ? appearance.custom.useForBoth
        ? appearance.custom.shared
        : appearance.custom[systemResolved]
      : APPEARANCE_PRESETS.find((preset) => preset.id === appearance.preference)?.definition

  if (!definition) return { resolved: systemResolved, palette: null, definition: null }
  return {
    resolved: appearanceForBackground(definition.background),
    palette: derivePalette(definition),
    definition
  }
}

/** Native appearance still follows macOS for a two-mode custom theme. */
export function nativeThemeSourceFor(preference: ThemePreference): 'system' | 'light' | 'dark' {
  if (preference === 'light' || preference === 'orchid') return 'light'
  if (preference === 'dark' || preference === 'graphite') return 'dark'
  return 'system'
}

/** Initializes the shared pair from the visible mode once; later toggles preserve user colors. */
export function setCustomThemeSharing(
  custom: CustomTheme,
  enabled: boolean,
  editorMode: ResolvedTheme
): CustomTheme {
  if (!enabled) return { ...custom, useForBoth: false }
  if (custom.sharedInitialized) return { ...custom, useForBoth: true }
  return {
    ...custom,
    useForBoth: true,
    sharedInitialized: true,
    shared: custom[editorMode]
  }
}

/** The actual canvas decides semantic polarity; a slot label never overrides contrast. */
export function appearanceForBackground(background: string): ResolvedTheme {
  return luminance(background) < 0.35 ? 'dark' : 'light'
}

/**
 * Derives only neutral and brand roles. Product colors (diffs, failures, blocked work) remain the
 * audited Light/Dark families in CSS and therefore cannot be spent by customization.
 */
export function derivePalette(definition: ThemeColors): ThemePalette {
  const background = definition.background.toLowerCase()
  const dark = appearanceForBackground(background) === 'dark'
  const surface = mix(background, '#ffffff', dark ? 7 : 38)
  const surfaceRaised = mix(background, '#ffffff', dark ? 11 : 68)
  const muted = mix(background, dark ? '#ffffff' : '#000000', dark ? 9 : 4)
  const border = contrastColor(
    mix(background, dark ? '#ffffff' : '#000000', dark ? 18 : 11),
    [background, surface],
    1.2,
    dark ? '#ffffff' : '#000000'
  )
  const foreground = bestInk(background)
  const mutedForeground = contrastColor(
    mix(foreground, background, 35),
    [background, surface],
    4.5,
    foreground
  )
  const primary = contrastColor(
    definition.accent.toLowerCase(),
    [background, surface],
    4.5,
    dark ? '#ffffff' : '#000000'
  )
  const primaryForeground = bestInk(primary)
  const primaryHover = contrastColor(
    mix(primary, primaryForeground === '#ffffff' ? '#000000' : '#ffffff', 12),
    [primaryForeground],
    4.5,
    primaryForeground === '#ffffff' ? '#000000' : '#ffffff'
  )
  const ring = contrastColor(
    definition.accent.toLowerCase(),
    [background, surface],
    3,
    dark ? '#ffffff' : '#000000'
  )
  const accent = mix(background, primary, dark ? 17 : 10)

  return {
    background,
    surface,
    surfaceRaised,
    muted,
    border,
    foreground,
    mutedForeground,
    accent,
    accentForeground: foreground,
    primary,
    primaryHover,
    primaryForeground,
    ring
  }
}

function contrastColor(
  seed: string,
  backgrounds: string[],
  minimum: number,
  toward: string
): string {
  for (const target of [toward, toward === '#ffffff' ? '#000000' : '#ffffff']) {
    for (let amount = 0; amount <= 100; amount += 1) {
      const candidate = mix(seed, target, amount)
      if (backgrounds.every((background) => contrast(candidate, background) >= minimum)) {
        return candidate
      }
    }
  }
  return toward
}

function bestInk(background: string): '#ffffff' | '#111318' | '#000000' {
  const quietInk =
    contrast(background, '#ffffff') >= contrast(background, '#111318') ? '#ffffff' : '#111318'
  return contrast(background, quietInk) >= 4.5 ? quietInk : '#000000'
}

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a) as [number, number]
  return (values[0] + 0.05) / (values[1] + 0.05)
}

function luminance(value: string): number {
  const channels = rgb(value).map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function mix(first: string, second: string, percentSecond: number): string {
  const a = rgb(first)
  const b = rgb(second)
  const weight = percentSecond / 100
  return hex(
    Math.round(a[0] * (1 - weight) + b[0] * weight),
    Math.round(a[1] * (1 - weight) + b[1] * weight),
    Math.round(a[2] * (1 - weight) + b[2] * weight)
  )
}

function rgb(value: string): [number, number, number] {
  const normalized = value.replace('#', '')
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number
  ]
}

function hex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}
