import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { testGit as git } from '../src/main/git-test-support'

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

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(stylesheet)
  expect(match, `missing CSS block for ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

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

/**
 * Its own application support and its own Harness, like every other suite
 * here: a test must never read or write the state of the app installed on
 * this machine, and one that did would pass or fail on what it found there.
 */
interface Sandbox {
  appDataDir: string
  readinessBinDir: string
  readinessHomeDir: string
  /** A folder under git, so a test can reach the app past onboarding. */
  projectDir: string
}

let sandbox: Sandbox

test.beforeEach(async () => {
  sandbox = {
    appDataDir: await mkdtemp(join(tmpdir(), 'app-design-appdata-')),
    readinessBinDir: await mkdtemp(join(tmpdir(), 'app-design-bin-')),
    readinessHomeDir: await mkdtemp(join(tmpdir(), 'app-design-home-')),
    projectDir: await mkdtemp(join(tmpdir(), 'app-design-project-'))
  }
  await git('git', ['init', '--quiet'], { cwd: sandbox.projectDir })
  // The app refuses to open without a Harness that can run a Session, and
  // every test here is about what is on screen past that gate.
  await writeFile(
    join(sandbox.readinessBinDir, 'claude'),
    `#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.220 (Claude Code)"; exit 0;;\n  -p) echo '{"type":"system","subtype":"init"}'; /bin/sleep 30;;\nesac\n`,
    { mode: 0o755 }
  )
})

test.afterEach(async () => {
  await rm(sandbox.appDataDir, { recursive: true, force: true })
  await rm(sandbox.readinessBinDir, { recursive: true, force: true })
  await rm(sandbox.readinessHomeDir, { recursive: true, force: true })
  await rm(sandbox.projectDir, { recursive: true, force: true })
})

test('shared surfaces own restrained compositor-only arrival motion', () => {
  expect(cssBlock('.modal-backdrop')).toContain(
    'animation: modal-backdrop-enter 200ms var(--ease-out) both'
  )
  expect(cssBlock('.modal-panel')).toContain(
    'animation: modal-panel-enter 200ms var(--ease-out) both'
  )
  expect(cssBlock('.modal-panel')).toContain('transform-origin: center')
  expect(cssBlock('@keyframes modal-panel-enter')).toContain(
    'transform: translateY(4px) scale(0.97)'
  )
  expect(cssBlock('@keyframes modal-panel-enter')).not.toContain('scale(0)')

  const filesPanel = cssBlock('.files-panel-enter')
  expect(filesPanel).toContain('animation: files-panel-enter 220ms var(--ease-drawer) both')
  expect(filesPanel).not.toMatch(/(?:^|[;\\s])(?:min-)?width\\s*:/)
  expect(cssBlock('@keyframes files-panel-enter')).toContain('transform: translateX(100%)')

  expect(cssBlock('.outcome-notice')).toContain(
    'animation: outcome-notice-enter 180ms var(--ease-out) both'
  )
  expect(cssBlock(".outcome-notice[data-exiting='true']")).toContain(
    'animation: outcome-notice-exit 160ms var(--ease-out) both'
  )
  expect(cssBlock('@keyframes outcome-notice-enter')).toContain('transform: translateY(100%)')
  expect(cssBlock('@keyframes outcome-notice-exit')).toContain('transform: translateY(100%)')
})

async function launchShell(): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronBinary,
    args: [mainEntry],
    env: {
      ...process.env,
      APP_TEST_APP_DATA: sandbox.appDataDir,
      // Nothing here needs a painted window, and a suite that takes the
      // desktop over is a suite nobody runs while they are working. Same
      // background launch every other acceptance suite uses.
      APP_TEST_BACKGROUND: '1',
      APP_TEST_READINESS_PATH: sandbox.readinessBinDir,
      APP_TEST_READINESS_HOME: sandbox.readinessHomeDir,
      APP_TEST_CHOOSE_PROJECT_DIRS: sandbox.projectDir
    }
  })
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

/** A value read twice the same, so a transition in flight is never the answer. */
async function settled(read: () => Promise<string>): Promise<string> {
  let last = await read()
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 60))
    const next = await read()
    if (next === last) return next
    last = next
  }
  return last
}

/** Past onboarding, on the launch screen, with a Project to work in. */
async function openTheApp(page: Awaited<ReturnType<ElectronApplication['firstWindow']>>) {
  const dialog = page.getByRole('dialog', { name: 'Add Project' })
  await dialog.getByRole('button', { name: 'Choose project folder…' }).click()
  // The sandbox reaches the folder through a symlink, so git names a root the
  // person did not pick and the app confirms it first.
  const confirmation = dialog.getByRole('alert')
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: 'Add this Project' }).click()
  const composer = page.getByRole('form', { name: 'New chat' })
  await composer.waitFor()
  return composer
}

test('no rule is drawn in the text colour, which is how a menu grows a white line', async () => {
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    const composer = await openTheApp(page)
    // The deepest stack of rules in the app: a popup with sections.
    await composer.getByRole('combobox', { name: 'Model' }).click()
    await page.getByRole('listbox').waitFor()

    for (const theme of ['light', 'dark']) {
      await page.evaluate((name) => {
        document.documentElement.dataset['theme'] = name
      }, theme)

      // A border with no colour of its own falls back to `currentcolor`, so it
      // is drawn in the text colour — a hairline that shouts, and in the dark
      // theme a white line across the bottom of a menu. Every rule states the
      // role it is drawn in, or it is not a rule, it is an accident.
      const shouting = await page.evaluate(() => {
        const sides = ['Top', 'Right', 'Bottom', 'Left'] as const
        return Array.from(document.querySelectorAll('[cmdk-root] *'))
          .filter((element) => {
            const style = getComputedStyle(element)
            return sides.some(
              (side) =>
                Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) >
                  0 && style.getPropertyValue(`border-${side.toLowerCase()}-color`) === style.color
            )
          })
          .map((element) => element.getAttribute('data-slot') ?? element.className)
      })

      expect(shouting, `a rule is drawn in the text colour in ${theme}`).toEqual([])
    }
  } finally {
    await app.close()
  }
})

test('the mark of a chosen option sits in the middle of its row, in every menu', async () => {
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    const composer = await openTheApp(page)

    for (const [role, name] of [
      ['button', 'Checkout'],
      ['button', 'Permission Mode'],
      ['combobox', 'Model']
    ] as const) {
      await composer.getByRole(role, { name }).click()
      const marks = page.locator('[data-slot="chosen-mark"]')
      await marks.first().waitFor()

      // Two lines of copy per option, so a mark hung off the first line reads
      // as floating above its own row — and differently in each menu, which is
      // how three popovers stop looking like one product.
      const offsets = await marks.evaluateAll((elements) =>
        elements.map((element) => {
          const row = element.closest('button, [cmdk-item]')
          if (!row) return null
          const markBox = element.getBoundingClientRect()
          const rowBox = row.getBoundingClientRect()
          return Math.round(markBox.top + markBox.height / 2 - (rowBox.top + rowBox.height / 2))
        })
      )

      expect(offsets.length, `${name} marks nothing as chosen`).toBeGreaterThan(0)
      for (const offset of offsets) {
        expect(offset, `the mark in ${name} is ${String(offset)}px off its row`).toBe(0)
      }
      await page.keyboard.press('Escape')
    }
  } finally {
    await app.close()
  }
})

test('a filled control answers the pointer, in the same currency as a quiet one', async () => {
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    const composer = await openTheApp(page)

    // The app's one filled control at rest: Send, on the launch screen.
    await composer.getByLabel('Message').fill('Something to send')
    const button = composer.getByRole('button', { name: 'Send' })
    await expect(button).toBeEnabled()

    const background = (): Promise<string> =>
      button.evaluate((element) => getComputedStyle(element).backgroundColor)

    // Pinned, because the app settles onto the system theme a moment after it
    // opens — and a reading taken across that would show a change the pointer
    // had nothing to do with.
    for (const theme of ['light', 'dark']) {
      await page.evaluate((name) => {
        document.documentElement.dataset['theme'] = name
      }, theme)
      await page.mouse.move(0, 0)
      // Settled, not in flight: these fills are transitioned, so a reading
      // taken while one is still moving is a reading of the way there.
      const resting = await settled(background)
      await button.hover()
      // A colour, not an opacity: `transition-colors` animates the first and
      // silently ignores the second, so a fill that hovered by fading was a
      // fill that jumped. Both themes owe an answer.
      expect(await settled(background), `no answer to the pointer in ${theme}`).not.toBe(resting)
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
