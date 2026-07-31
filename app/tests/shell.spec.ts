import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

/**
 * Packaged-shell acceptance tests: the built app is launched for real and
 * observed through the window, covering the complete capture behavior and
 * renderer isolation.
 */

// The `electron` package resolves to the binary path in plain Node, which is
// what Playwright needs to launch — a CJS-only export with no ESM equivalent.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronBinary = require('electron') as unknown as string
const mainEntry = join(__dirname, '../out/main/index.js')

interface Sandbox {
  userDataDir: string
  libraryDir: string
}

let sandbox: Sandbox

async function launchShell(): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronBinary,
    args: [mainEntry],
    env: {
      ...process.env,
      IDEA_SHELL_TEST_USER_DATA: sandbox.userDataDir,
      IDEA_SHELL_TEST_CHOOSE_DIR: sandbox.libraryDir
    }
  })
}

test.beforeEach(async () => {
  sandbox = {
    userDataDir: await mkdtemp(join(tmpdir(), 'idea-shell-userdata-')),
    libraryDir: await mkdtemp(join(tmpdir(), 'idea-shell-library-'))
  }
})

test.afterEach(async () => {
  await rm(sandbox.userDataDir, { recursive: true, force: true })
  await rm(sandbox.libraryDir, { recursive: true, force: true })
})

test('renderer is sandboxed with only the narrow preload surface', async () => {
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await page.getByRole('heading', { name: 'Choose your Idea Library' }).waitFor()

    const exposure = await page.evaluate(() => ({
      requireType: typeof (window as never as Record<string, unknown>)['require'],
      processType: typeof (window as never as Record<string, unknown>)['process'],
      moduleType: typeof (window as never as Record<string, unknown>)['module'],
      electronType: typeof (window as never as Record<string, unknown>)['electron'],
      ipcRendererType: typeof (window as never as Record<string, unknown>)['ipcRenderer'],
      shellKeys: Object.keys(window.ideaShell as unknown as Record<string, unknown>).sort()
    }))

    expect(exposure.requireType).toBe('undefined')
    expect(exposure.processType).toBe('undefined')
    expect(exposure.moduleType).toBe('undefined')
    expect(exposure.electronType).toBe('undefined')
    expect(exposure.ipcRendererType).toBe('undefined')
    expect(exposure.shellKeys).toEqual([
      'captureIdea',
      'chooseLibraryLocation',
      'getBootState',
      'listIdeas',
      'onThemeChanged',
      'openLibrary',
      'setThemePreference'
    ])

    // The preload functions cross the bridge by value: none of them can be
    // used to reach Electron internals, and arbitrary network is blocked.
    const networkBlocked = await page.evaluate(async () => {
      try {
        await fetch('https://example.com/', { mode: 'no-cors' })
        return false
      } catch {
        return true
      }
    })
    expect(networkBlocked).toBe(true)
  } finally {
    await app.close()
  }
})

test('a person captures an Idea and it survives an application restart', async () => {
  const firstRun = await launchShell()
  try {
    const page = await firstRun.firstWindow()

    // First launch: choose the Idea Library, with the exact location visible
    // before anything is written.
    await page.getByRole('button', { name: 'Choose or create a folder…' }).click()
    await expect(page.getByText(sandbox.libraryDir)).toBeVisible()
    await page.getByRole('button', { name: 'Use this Idea Library' }).click()

    // The mailbox opens empty.
    await expect(page.getByText('No Ideas yet', { exact: false })).toBeVisible()

    // Capture a Software Idea with the no-secrets guidance visible.
    await page.getByRole('button', { name: 'New Idea' }).click()
    await expect(page.getByText('Don’t include passwords', { exact: false })).toBeVisible()
    await page
      .getByLabel('What’s the idea?')
      .fill('An offline recipe planner\n\nIt plans weekly meals without any accounts.')

    // The locally generated title suggestion is editable.
    const title = page.getByLabel('Title')
    await expect(title).toHaveValue('An offline recipe planner')
    await title.fill('Offline recipe planner')

    await page.getByRole('button', { name: 'Save for later' }).click()
    await expect(page.getByRole('heading', { name: 'Offline recipe planner' })).toBeVisible()

    // The Idea is canonical local Markdown on disk.
    const markdown = await readFile(
      join(sandbox.libraryDir, 'offline-recipe-planner', 'idea.md'),
      'utf8'
    )
    expect(markdown).toContain('kind: software')
    expect(markdown).toContain('# Offline recipe planner')
    expect(markdown).toContain('It plans weekly meals without any accounts.')
  } finally {
    await firstRun.close()
  }

  // Restart the application: the saved Idea reappears from local content.
  const secondRun = await launchShell()
  try {
    const page = await secondRun.firstWindow()
    const inbox = page.getByRole('navigation', { name: 'Idea inbox' })
    await expect(inbox.getByText('Offline recipe planner')).toBeVisible()
  } finally {
    await secondRun.close()
  }
})
