// This test runs in Node and is never bundled into the Renderer, so the
// sandbox boundary the shared contract keeps does not apply to it: reading the
// stylesheet the app is built from is the whole point.
/* eslint-disable @typescript-eslint/no-restricted-imports */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
/* eslint-enable @typescript-eslint/no-restricted-imports */
import { describe, expect, it } from 'vitest'
import { WINDOW_BACKGROUND } from './theme'

/**
 * The identity, checked rather than admired.
 *
 * Every role is read out of the stylesheet the app is actually built from, so
 * this cannot pass against a palette nobody ships. Contrast is computed, not
 * eyeballed: "it looks fine on my display" is exactly the assumption the
 * ticket asked to stop making.
 */

const stylesheet = readFileSync(join(__dirname, '../renderer/src/styles.css'), 'utf8')

/**
 * The roles every theme shares, and then each theme's own block. A theme is
 * read the way the browser reads it: its own values over the shared ones.
 */
const shared = rolesIn('\n:root {')
const stated = {
  light: rolesIn(":root,\n[data-theme='light'] {"),
  dark: rolesIn("[data-theme='dark'] {")
}
const themes = {
  light: { ...shared, ...stated.light },
  dark: { ...shared, ...stated.dark }
}

/**
 * Text has to reach 4.5:1; something you look at rather than read — an icon,
 * a border carrying meaning — has to reach 3:1 (WCAG 2.2, 1.4.3 and 1.4.11).
 */
const TEXT = 4.5
const GRAPHIC = 3
/**
 * Not a WCAG bar. Borders here are meant to read as structure rather than as
 * decoration, so this is the least a line can differ by and still be a line —
 * pitched at what the design intends, not at what would be conspicuous.
 */
const EDGE = 1.2

const PAIRS: { role: string; on: string; least: number; why: string }[] = [
  { role: 'foreground', on: 'background', least: TEXT, why: 'body text on the page' },
  { role: 'foreground', on: 'surface', least: TEXT, why: 'body text on a panel' },
  { role: 'foreground', on: 'surface-raised', least: TEXT, why: 'body text on a popover' },
  { role: 'muted-foreground', on: 'background', least: TEXT, why: 'secondary text on the page' },
  { role: 'muted-foreground', on: 'surface', least: TEXT, why: 'secondary text on a panel' },
  { role: 'muted-foreground', on: 'muted', least: TEXT, why: 'secondary text on a fill' },
  {
    role: 'muted-foreground',
    on: 'surface-raised',
    least: TEXT,
    why: 'secondary text on a popover'
  },
  { role: 'foreground', on: 'muted', least: TEXT, why: 'body text on a fill' },
  { role: 'accent-foreground', on: 'accent', least: TEXT, why: 'text on the hover fill' },
  { role: 'primary-foreground', on: 'primary', least: TEXT, why: 'a primary button' },
  { role: 'destructive-foreground', on: 'destructive', least: TEXT, why: 'a destructive button' },
  { role: 'primary', on: 'background', least: TEXT, why: 'the brand as text' },
  { role: 'primary', on: 'surface', least: TEXT, why: 'the brand as text on a panel' },
  { role: 'destructive', on: 'background', least: TEXT, why: 'a failure said on the page' },
  { role: 'destructive', on: 'surface', least: TEXT, why: 'a failure said on a panel' },
  { role: 'positive', on: 'background', least: TEXT, why: 'success on the page' },
  { role: 'positive', on: 'surface', least: TEXT, why: 'success on a panel' },
  { role: 'notice-foreground', on: 'notice', least: TEXT, why: 'the notice banner' },
  { role: 'notice-foreground', on: 'background', least: TEXT, why: 'a notice said on the page' },

  // The two families the product has spent.
  {
    role: 'diff-added-foreground',
    on: 'surface',
    least: TEXT,
    why: 'an added line in a diff'
  },
  {
    role: 'diff-added-foreground',
    on: 'diff-added-surface',
    least: TEXT,
    why: 'an added line on its own fill'
  },
  {
    role: 'diff-removed-foreground',
    on: 'surface',
    least: TEXT,
    why: 'a removed line in a diff'
  },
  {
    role: 'diff-removed-foreground',
    on: 'diff-removed-surface',
    least: TEXT,
    why: 'a removed line on its own fill'
  },
  {
    role: 'diff-added-foreground',
    on: 'background',
    least: TEXT,
    why: 'what a file gained, on the page'
  },
  {
    role: 'diff-removed-foreground',
    on: 'background',
    least: TEXT,
    why: 'what a file lost, on the page'
  },
  { role: 'status-running', on: 'background', least: TEXT, why: 'a running Session' },
  { role: 'status-running', on: 'surface', least: TEXT, why: 'a running Session on a panel' },
  { role: 'status-blocked', on: 'background', least: TEXT, why: 'the most important signal' },
  { role: 'status-blocked', on: 'surface', least: TEXT, why: 'blocked, on a panel' },
  {
    role: 'status-blocked',
    on: 'status-blocked-surface',
    least: TEXT,
    why: 'blocked, on its own badge'
  },
  { role: 'status-idle', on: 'background', least: TEXT, why: 'an idle Session' },
  { role: 'status-idle', on: 'surface', least: TEXT, why: 'an idle Session on a panel' },
  { role: 'status-failed', on: 'background', least: TEXT, why: 'a failed Session' },
  { role: 'status-failed', on: 'surface', least: TEXT, why: 'a failed Session on a panel' },

  // Looked at rather than read.
  { role: 'ring', on: 'background', least: GRAPHIC, why: 'the focus ring on the page' },
  { role: 'ring', on: 'surface', least: GRAPHIC, why: 'the focus ring on a panel' },

  // A border between two fills is not a control boundary, so WCAG asks
  // nothing of it; what it must not be is invisible, because on the page the
  // blocked badge's own fill is deliberately quiet.
  {
    role: 'status-blocked-border',
    on: 'status-blocked-surface',
    least: EDGE,
    why: 'the edge of the blocked badge'
  },
  { role: 'border', on: 'background', least: EDGE, why: 'structure on the page' },
  { role: 'border', on: 'surface', least: EDGE, why: 'structure on a panel' },
  { role: 'border', on: 'surface-raised', least: EDGE, why: 'structure on a popover' }
]

describe('the identity', () => {
  it('states the same roles in every theme, so a theme is a block of values', () => {
    expect(Object.keys(stated.dark).sort()).toEqual(Object.keys(stated.light).sort())
    // And there is something to compare: an empty parse would pass the above.
    expect(Object.keys(themes.light).length).toBeGreaterThan(20)
    expect(Object.keys(shared).length).toBeGreaterThan(10)
  })

  for (const [name, roles] of Object.entries(themes)) {
    describe(`the ${name} theme`, () => {
      for (const pair of PAIRS) {
        it(`reads ${pair.why}: ${pair.role} on ${pair.on}`, () => {
          const ratio = contrast(resolve(roles, pair.role), resolve(roles, pair.on))
          expect(
            ratio,
            `${pair.role} on ${pair.on} is ${ratio.toFixed(2)}:1, under ${String(pair.least)}:1`
          ).toBeGreaterThanOrEqual(pair.least)
        })
      }
    })
  }

  it('paints the window with the page colour, so a launch never flashes', () => {
    for (const [name, roles] of Object.entries(themes)) {
      expect(hex(resolve(roles, 'background'))).toBe(WINDOW_BACKGROUND[name as 'light' | 'dark'])
    }
  })
})

/** Every `--role: value` inside one theme block. */
function rolesIn(opening: string): Record<string, string> {
  const start = stylesheet.indexOf(opening)
  if (start < 0) throw new Error(`No theme block opens with ${opening}`)
  const end = stylesheet.indexOf('\n}', start)
  const block = stylesheet.slice(start + opening.length, end)
  const roles: Record<string, string> = {}
  for (const [, role, value] of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    if (role !== undefined && value !== undefined) roles[role] = value.trim()
  }
  return roles
}

/** A role is allowed to name a family; a family is a colour. */
function resolve(roles: Record<string, string>, role: string): string {
  const value = roles[role]
  if (value === undefined) throw new Error(`No role named ${role}`)
  const alias = /^var\(--([a-z0-9-]+)\)$/.exec(value)
  return alias?.[1] === undefined ? value : resolve(roles, alias[1])
}

/** WCAG 2.2 contrast, from the sRGB the display will actually show. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

function luminance(color: string): number {
  const [r, g, b] = linearRgb(color)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** `oklch(L C H)` to linear sRGB, clamped to what a display can show. */
function linearRgb(color: string): [number, number, number] {
  const parsed = /^oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\)$/.exec(color)
  if (!parsed) throw new Error(`Not a plain oklch colour: ${color}`)
  const lightness = Number(parsed[1])
  const chroma = Number(parsed[2])
  const hue = (Number(parsed[3]) * Math.PI) / 180
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3

  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  ]
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** The same colour as the hex an Electron window takes. */
function hex(color: string): string {
  const channels = linearRgb(color).map((value) => {
    const encoded = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
    return Math.round(encoded * 255)
      .toString(16)
      .padStart(2, '0')
  })
  return `#${channels.join('')}`
}
