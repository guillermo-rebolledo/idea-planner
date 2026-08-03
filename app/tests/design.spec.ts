import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

/**
 * The visual identity, in the running app.
 *
 * `src/shared/theme.test.ts` checks the values; this checks that the app is
 * actually wired to them — that the type is the type, that focus is visible,
 * and that a theme really is nothing but a block of values.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronBinary = require('electron') as unknown as string
const mainEntry = join(__dirname, '../out/main/index.js')
const stylesheet = readFileSync(join(__dirname, '../src/renderer/src/styles.css'), 'utf8')

/**
 * Every role a theme states — the blocks up to `@theme inline`, which is the
 * app's type, radius and motion scale rather than any one theme's.
 */
const ROLES = [
  ...new Set(
    [
      ...stylesheet.slice(0, stylesheet.indexOf('@theme inline')).matchAll(/^ {2}--([a-z0-9-]+):/gm)
    ].flatMap(([, role]) => role ?? [])
  )
]

async function launchShell(): Promise<ElectronApplication> {
  return electron.launch({ executablePath: electronBinary, args: [mainEntry] })
}

test('the app is set in Geist, and code in Geist Mono', async () => {
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await page.getByRole('heading', { name: 'Add your first Project' }).waitFor()

    const type = await page.evaluate(async () => {
      // Both faces are asked for by name: a self-hosted file answers, and a
      // missing or network-only one does not.
      await Promise.all([
        document.fonts.load('13px Geist'),
        document.fonts.load('13px "Geist Mono"')
      ])
      const fonts: string[] = []
      document.fonts.forEach((face) => fonts.push(face.family))
      const probe = document.createElement('span')
      probe.className = 'font-mono'
      probe.textContent = 'diff'
      document.body.append(probe)
      const mono = getComputedStyle(probe).fontFamily
      probe.remove()
      return {
        body: getComputedStyle(document.body).fontFamily,
        mono,
        // Self-hosted and offline: the faces are there without a network.
        loaded: fonts.sort(),
        sansUsable: document.fonts.check('13px Geist'),
        monoUsable: document.fonts.check('13px "Geist Mono"')
      }
    })

    expect(type.body).toContain('Geist')
    expect(type.mono).toContain('Geist Mono')
    expect(type.loaded).toEqual(['Geist', 'Geist Mono'])
    expect(type.sansUsable).toBe(true)
    expect(type.monoUsable).toBe(true)
  } finally {
    await app.close()
  }
})

test('keyboard focus is visible, and stays visible in either theme', async () => {
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await page.getByRole('heading', { name: 'Add your first Project' }).waitFor()

    for (const theme of ['light', 'dark']) {
      await page.evaluate((name) => {
        document.documentElement.dataset['theme'] = name
      }, theme)
      await page.keyboard.press('Tab')

      const focused = await page.evaluate(() => {
        const active = document.activeElement
        if (!active || active === document.body) return null
        // Focus is shown either by the outline every element falls back to, or
        // by a ring — on the control itself, or on the field around it.
        const shown = (element: Element): boolean => {
          const style = getComputedStyle(element)
          const outlined =
            style.outlineStyle !== 'none' &&
            Number.parseFloat(style.outlineWidth) > 0 &&
            !style.outlineColor.includes('rgba(0, 0, 0, 0)')
          return outlined || style.boxShadow !== 'none'
        }
        return {
          tag: active.tagName,
          shown: shown(active) || (!!active.parentElement && shown(active.parentElement))
        }
      })

      expect(focused, `nothing took focus in ${theme}`).not.toBeNull()
      expect(focused?.shown, `focus is invisible on ${focused?.tag ?? '?'} in ${theme}`).toBe(true)
    }
  } finally {
    await app.close()
  }
})

test('a third theme is a block of values and nothing else', async () => {
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await page.getByRole('heading', { name: 'Add your first Project' }).waitFor()

    const painted = await page.evaluate((names: string[]) => {
      // A different, unmistakable colour per role.
      const invented = Object.fromEntries(
        names.map((role, index) => [role, `rgb(${String(index)}, ${String(index * 2)}, 128)`])
      )
      const sheet = document.createElement('style')
      sheet.textContent = `[data-theme='thirdrail'] {\n${names
        .map((role) => `--${role}: ${invented[role] ?? ''};`)
        .join('\n')}\n}`
      document.head.append(sheet)
      document.documentElement.dataset['theme'] = 'thirdrail'

      const muted = document.querySelector('.text-muted-foreground')
      return {
        invented,
        page: getComputedStyle(document.body).backgroundColor,
        text: getComputedStyle(document.body).color,
        muted: muted ? getComputedStyle(muted).color : null
      }
    }, ROLES)

    // The whole app repainted from values it had never seen, with no
    // component edited and no class renamed.
    expect(painted.page).toBe(painted.invented['background'])
    expect(painted.text).toBe(painted.invented['foreground'])
    expect(painted.muted).toBe(painted.invented['muted-foreground'])
  } finally {
    await app.close()
  }
})
