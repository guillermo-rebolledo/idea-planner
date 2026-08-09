import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CUSTOM_THEME } from '@shared/theme'
import { SettingsStore } from './settings'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('appearance preferences', () => {
  it('adds custom defaults without changing an existing theme preference', () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ themePreference: 'dark' }))
    const store = new SettingsStore(root)

    expect(store.get().themePreference).toBe('dark')
    expect(store.get().customTheme).toEqual(DEFAULT_CUSTOM_THEME)
  })

  it('persists the active preset and every custom color set atomically', () => {
    const root = temporaryRoot()
    const first = new SettingsStore(root)
    const customTheme = {
      ...DEFAULT_CUSTOM_THEME,
      name: 'Copper Night',
      useForBoth: true,
      shared: { background: '#161310', accent: '#e5a15a' }
    }

    first.update({ themePreference: 'custom', customTheme })

    const second = new SettingsStore(root)
    expect(second.get().themePreference).toBe('custom')
    expect(second.get().customTheme).toEqual(customTheme)
    expect(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))).toMatchObject({
      themePreference: 'custom',
      customTheme
    })
  })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'argos-settings-'))
  roots.push(root)
  return root
}
