export type Scheme = 'light' | 'dark'
export type ThemeId = 'system' | 'light' | 'dark' | 'graphite' | 'orchid' | 'custom'

export type ThemeColors = {
  background: string
  accent: string
}

export type ThemeDraft = {
  name: string
  scheme: Scheme
  background: string
  accent: string
  colors: Record<Scheme, ThemeColors>
  useForBoth: boolean
}

export type ThemePreset = {
  id: Exclude<ThemeId, 'custom'>
  name: string
  description: string
  scheme: Scheme
  background: string
  accent: string
}

export type ThemeState = {
  selected: ThemeId
  draft: ThemeDraft
  saved: ThemeDraft
}

export type ThemeActions = {
  select: (id: ThemeId) => void
  updateDraft: (patch: Partial<ThemeDraft>) => void
  save: () => void
  cancel: () => void
  reset: () => void
}

export type VariantProps = ThemeState & ThemeActions

export const DEFAULT_DRAFT: ThemeDraft = {
  name: 'My Theme',
  scheme: 'light',
  background: '#ffffff',
  accent: '#3869b2',
  colors: {
    light: { background: '#ffffff', accent: '#3869b2' },
    dark: { background: '#000000', accent: '#7aa2d8' }
  },
  useForBoth: false
}

export const PRESETS: ThemePreset[] = [
  {
    id: 'system',
    name: 'System',
    description: 'Follows macOS',
    scheme: 'light',
    background: '#f4f4f6',
    accent: '#3869b2'
  },
  {
    id: 'light',
    name: 'Light',
    description: 'Quiet and bright',
    scheme: 'light',
    background: '#f4f4f6',
    accent: '#3869b2'
  },
  {
    id: 'dark',
    name: 'Dark',
    description: 'The original',
    scheme: 'dark',
    background: '#0e0f11',
    accent: '#7aa2d8'
  },
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Neutral and dense',
    scheme: 'dark',
    background: '#171717',
    accent: '#d2a76f'
  },
  {
    id: 'orchid',
    name: 'Orchid',
    description: 'Soft violet ink',
    scheme: 'light',
    background: '#f4f0f7',
    accent: '#7850a6'
  }
]

export function activeDefinition(state: ThemeState): ThemeDraft {
  if (state.selected === 'custom') return state.draft
  const preset = PRESETS.find((candidate) => candidate.id === state.selected) ?? PRESETS[0]
  if (preset === undefined) return DEFAULT_DRAFT
  return {
    ...DEFAULT_DRAFT,
    name: preset.name,
    scheme: preset.scheme,
    background: preset.background,
    accent: preset.accent,
    colors: {
      ...DEFAULT_DRAFT.colors,
      [preset.scheme]: { background: preset.background, accent: preset.accent }
    }
  }
}

export function isDirty(state: Pick<ThemeState, 'draft' | 'saved'>): boolean {
  return JSON.stringify(state.draft) !== JSON.stringify(state.saved)
}

export function paletteFor(definition: ThemeDraft): Record<string, string> {
  const dark = appearanceForBackground(definition.background) === 'dark'
  const background = definition.background
  const accent = definition.accent
  const foreground = bestInk(background)
  const surface = mix(background, dark ? '#ffffff' : '#ffffff', dark ? 7 : 58)
  const raised = mix(background, dark ? '#ffffff' : '#ffffff', dark ? 11 : 82)
  const muted = mix(background, dark ? '#ffffff' : '#000000', dark ? 9 : 4)
  const border = mix(background, dark ? '#ffffff' : '#000000', dark ? 18 : 11)
  const quietAccent = mix(background, accent, dark ? 17 : 10)

  return {
    '--background': background,
    '--surface': surface,
    '--surface-raised': raised,
    '--muted': muted,
    '--border': border,
    '--foreground': foreground,
    '--muted-foreground': mix(foreground, background, 35),
    '--accent': quietAccent,
    '--accent-foreground': foreground,
    '--blue': accent,
    '--primary': accent,
    '--primary-hover': mix(accent, dark ? '#ffffff' : '#000000', 14),
    '--primary-foreground': bestInk(accent),
    '--ring': mix(accent, dark ? '#ffffff' : '#000000', dark ? 18 : 8)
  }
}

export function appearanceForBackground(background: string): Scheme {
  return luminance(background) < 0.35 ? 'dark' : 'light'
}

function bestInk(background: string): string {
  return contrast(background, '#ffffff') >= contrast(background, '#111318') ? '#ffffff' : '#111318'
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

function contrast(first: string, second: string): number {
  const [a, b] = [luminance(first), luminance(second)].sort((x, y) => y - x) as [number, number]
  return (a + 0.05) / (b + 0.05)
}

function luminance(value: string): number {
  const channels = rgb(value).map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
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
