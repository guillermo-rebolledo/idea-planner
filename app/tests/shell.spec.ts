import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  trashDir: string
  /** PATH used for readiness discovery; empty means no Harness is found. */
  readinessBinDir: string
  /** HOME used for readiness skill discovery. */
  readinessHomeDir: string
}

let sandbox: Sandbox

async function launchShell(): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronBinary,
    args: [mainEntry],
    env: {
      ...process.env,
      APP_TEST_USER_DATA: sandbox.userDataDir,
      APP_TEST_CHOOSE_DIR: sandbox.libraryDir,
      APP_TEST_TRASH_DIR: sandbox.trashDir,
      APP_TEST_READINESS_PATH: sandbox.readinessBinDir,
      APP_TEST_READINESS_HOME: sandbox.readinessHomeDir
    }
  })
}

test.beforeEach(async () => {
  sandbox = {
    userDataDir: await mkdtemp(join(tmpdir(), 'app-shell-userdata-')),
    libraryDir: await mkdtemp(join(tmpdir(), 'app-shell-library-')),
    trashDir: await mkdtemp(join(tmpdir(), 'app-shell-trash-')),
    readinessBinDir: await mkdtemp(join(tmpdir(), 'app-shell-readiness-bin-')),
    readinessHomeDir: await mkdtemp(join(tmpdir(), 'app-shell-readiness-home-'))
  }
})

test.afterEach(async () => {
  await rm(sandbox.userDataDir, { recursive: true, force: true })
  await rm(sandbox.libraryDir, { recursive: true, force: true })
  await rm(sandbox.trashDir, { recursive: true, force: true })
  await rm(sandbox.readinessBinDir, { recursive: true, force: true })
  await rm(sandbox.readinessHomeDir, { recursive: true, force: true })
})

async function installFakeHarness(name: string, script: string): Promise<void> {
  await writeFile(join(sandbox.readinessBinDir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
}

async function installFakeSkills(root: string): Promise<void> {
  for (const skill of ['grill-me', 'grilling', 'wayfinder']) {
    const dir = join(sandbox.readinessHomeDir, root, skill)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${skill}\n---\n`)
  }
}

test('renderer is sandboxed with only the narrow preload surface', async () => {
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await page.getByRole('heading', { name: 'Choose your library' }).waitFor()

    const exposure = await page.evaluate(() => ({
      requireType: typeof (window as never as Record<string, unknown>)['require'],
      processType: typeof (window as never as Record<string, unknown>)['process'],
      moduleType: typeof (window as never as Record<string, unknown>)['module'],
      electronType: typeof (window as never as Record<string, unknown>)['electron'],
      ipcRendererType: typeof (window as never as Record<string, unknown>)['ipcRenderer'],
      shellKeys: Object.keys(window.shell as unknown as Record<string, unknown>).sort()
    }))

    expect(exposure.requireType).toBe('undefined')
    expect(exposure.processType).toBe('undefined')
    expect(exposure.moduleType).toBe('undefined')
    expect(exposure.electronType).toBe('undefined')
    expect(exposure.ipcRendererType).toBe('undefined')
    expect(exposure.shellKeys).toEqual([
      'captureSession',
      'chooseHarnessExecutable',
      'chooseLibraryLocation',
      'clearHarnessExecutable',
      'deleteSessionPermanently',
      'developSession',
      'getBootState',
      'getConversation',
      'getReadiness',
      'listRuns',
      'listSessions',
      'onConversationEvent',
      'onThemeChanged',
      'openExternalLink',
      'openLibrary',
      'openSession',
      'previewDeleteSession',
      'queryMailbox',
      'refreshReadiness',
      'setLoginShellDiscovery',
      'setSessionArchived',
      'setSessionPinned',
      'setThemePreference',
      'startRun',
      'stopRun'
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

test('a person captures a Session and it survives an application restart', async () => {
  const firstRun = await launchShell()
  try {
    const page = await firstRun.firstWindow()

    // First launch: choose the library, with the exact location visible
    // before anything is written.
    await page.getByRole('button', { name: 'Choose or create a folder…' }).click()
    await expect(page.getByText(sandbox.libraryDir)).toBeVisible()
    await page.getByRole('button', { name: 'Use this library' }).click()

    // The optional readiness step never blocks capture-only onboarding.
    await page.getByRole('heading', { name: 'Check Harness readiness' }).waitFor()
    await page.getByRole('button', { name: 'Continue with capture only' }).click()

    // The mailbox opens empty.
    await expect(page.getByText('No Sessions yet', { exact: false })).toBeVisible()

    // Capture a Session with the no-secrets guidance visible.
    await page.getByRole('button', { name: 'New Session' }).click()
    await expect(page.getByText('Don’t include passwords', { exact: false })).toBeVisible()
    await page
      .getByLabel('What’s this Session about?')
      .fill('An offline recipe planner\n\nIt plans weekly meals without any accounts.')

    // The locally generated title suggestion is editable.
    const title = page.getByLabel('Title')
    await expect(title).toHaveValue('An offline recipe planner')
    await title.fill('Offline recipe planner')

    await page.getByRole('button', { name: 'Save for later' }).click()
    await expect(page.getByRole('heading', { name: 'Offline recipe planner' })).toBeVisible()

    // The Session is canonical local Markdown on disk.
    const markdown = await readFile(
      join(sandbox.libraryDir, 'offline-recipe-planner', 'session.md'),
      'utf8'
    )
    expect(markdown).toContain('format: 2')
    expect(markdown).toContain('# Offline recipe planner')
    expect(markdown).toContain('It plans weekly meals without any accounts.')
  } finally {
    await firstRun.close()
  }

  // Restart the application: the saved Session reappears from local content.
  const secondRun = await launchShell()
  try {
    const page = await secondRun.firstWindow()
    const inbox = page.getByRole('navigation', { name: 'Session inbox' })
    await expect(inbox.getByText('Offline recipe planner')).toBeVisible()
    await inbox.getByText('Offline recipe planner').click()
    await expect(page.getByRole('heading', { name: 'Offline recipe planner' })).toBeVisible()
  } finally {
    await secondRun.close()
  }
})

async function chooseLibrary(page: Awaited<ReturnType<ElectronApplication['firstWindow']>>) {
  await page.getByRole('button', { name: 'Choose or create a folder…' }).click()
  await page.getByRole('button', { name: 'Use this library' }).click()
  await page.getByRole('button', { name: 'Continue with capture only' }).click()
}

async function captureSession(
  page: Awaited<ReturnType<ElectronApplication['firstWindow']>>,
  title: string,
  notes: string
) {
  await page.getByRole('button', { name: 'New Session' }).click()
  await page.getByLabel('What’s this Session about?').fill(notes)
  await page.getByLabel('Title').fill(title)
  await page.getByRole('button', { name: 'Save for later' }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

test('a person organizes the mailbox: pin, search, archive, restore, compact rail', async () => {
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await chooseLibrary(page)
    await captureSession(page, 'Offline recipe planner', 'Plans weekly meals without accounts.')
    await captureSession(page, 'Community tool library', 'Neighbors share tools.')

    const inbox = page.getByRole('navigation', { name: 'Session inbox' })
    const pinnedGroup = inbox.getByRole('region', { name: 'Pinned' })
    const recentGroup = inbox.getByRole('region', { name: 'Recent' })

    // Grouped inbox: both land in Recent, with the status groups presented.
    await expect(recentGroup.getByText('Offline recipe planner')).toBeVisible()
    await expect(inbox.getByRole('region', { name: 'Needs attention' })).toBeVisible()
    await expect(inbox.getByRole('region', { name: 'Running' })).toBeVisible()

    // Pin groups the Session first, out of the Recent list.
    await inbox.getByRole('button', { name: 'Pin “Offline recipe planner”' }).click()
    await expect(pinnedGroup.getByText('Offline recipe planner')).toBeVisible()
    await expect(recentGroup.getByText('Offline recipe planner')).toHaveCount(0)

    // Search narrows to matching Sessions; no-results is a visible, recoverable state.
    const search = page.getByRole('searchbox', { name: 'Search Sessions' })
    await search.fill('recipe')
    await expect(inbox.getByText('Community tool library')).toHaveCount(0)
    await expect(pinnedGroup.getByText('Offline recipe planner')).toBeVisible()
    await search.fill('zeppelin')
    await expect(inbox.getByText('No Sessions match', { exact: false })).toBeVisible()
    await inbox.getByRole('button', { name: 'Clear search' }).click()
    await expect(inbox.getByText('Community tool library')).toBeVisible()

    // Archive is reversible and files never move.
    await inbox.getByRole('button', { name: 'Archive “Community tool library”' }).click()
    await expect(inbox.getByText('Community tool library')).toHaveCount(0)
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(inbox.getByText('Community tool library')).toBeVisible()
    expect(
      await readFile(join(sandbox.libraryDir, 'community-tool-library', 'session.md'), 'utf8')
    ).toContain('archived:')
    await inbox.getByRole('button', { name: 'Restore “Community tool library”' }).click()
    await page.getByRole('button', { name: 'Inbox', exact: true }).click()
    await expect(inbox.getByText('Community tool library')).toBeVisible()

    // The inbox collapses to a compact rail that keeps Sessions reachable
    // while the central Focus Deck stays in place.
    await page.getByRole('button', { name: 'Collapse inbox to rail' }).click()
    const rail = page.getByRole('navigation', { name: 'Session inbox (compact)' })
    await expect(rail.getByRole('button', { name: 'Offline recipe planner' })).toBeVisible()
    await expect(page.getByRole('main')).toBeVisible()
    await rail.getByRole('button', { name: 'Community tool library' }).click()
    await expect(page.getByRole('heading', { name: 'Community tool library' })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('permanent delete previews exact app-owned targets and moves them to the Trash', async () => {
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await chooseLibrary(page)
    await captureSession(page, 'Doomed session', 'This one goes away.')

    const inbox = page.getByRole('navigation', { name: 'Session inbox' })
    await inbox.getByRole('button', { name: 'Delete “Doomed session” permanently…' }).click()

    // The preview names the exact app-owned targets before anything happens.
    await expect(
      page.getByRole('heading', { name: 'Delete “Doomed session” permanently?' })
    ).toBeVisible()
    await expect(
      page.getByRole('list', { name: 'Items that move to the Trash' }).getByText('doomed-session')
    ).toBeVisible()

    await page.getByRole('button', { name: 'Move to Trash' }).click()
    await expect(inbox.getByText('Doomed session')).toHaveCount(0)
    await expect(page.getByText('No Sessions yet', { exact: false })).toBeVisible()

    // The folder moved to the (test) Trash instead of being destroyed.
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(sandbox.libraryDir)).not.toContain('doomed-session')
    const trashed = await readdir(sandbox.trashDir)
    expect(trashed.some((entry) => entry.endsWith('doomed-session'))).toBe(true)
  } finally {
    await app.close()
  }
})

const READY_CODEX_FAKE = `case "$1" in
  --version) echo "codex-cli 0.146.0"; exit 0;;
  login) exit 0;;
  sandbox) exit 0;;
esac
exit 1`

const READY_CLAUDE_FAKE = `case "$1" in
  --version) echo "2.1.220 (Claude Code)"; exit 0;;
  -p) echo '{"type":"system","subtype":"init"}'; /bin/sleep 30;;
esac`

test('readiness reports Codex and Claude independently, with safe repair and re-check', async () => {
  await installFakeHarness('codex', READY_CODEX_FAKE)
  await installFakeSkills('.agents/skills')

  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Choose or create a folder…' }).click()
    await page.getByRole('button', { name: 'Use this library' }).click()
    await page.getByRole('heading', { name: 'Check Harness readiness' }).waitFor()

    const codexCard = page.getByRole('region', { name: 'Codex readiness' })
    const claudeCard = page.getByRole('region', { name: 'Claude Code readiness' })

    // Codex is fully ready; the resolved absolute path is visible.
    await expect(codexCard.getByText('Usable', { exact: true })).toBeVisible()
    await expect(
      codexCard.getByText(join(sandbox.readinessBinDir, 'codex'), { exact: true })
    ).toBeVisible()

    // Claude stays visible but not ready, with only the approved remediation.
    await expect(claudeCard.getByText('Not usable — capture still works')).toBeVisible()
    await expect(claudeCard.getByText('npx skills@latest add mattpocock/skills')).toBeVisible()

    // The person repairs Claude in their own terminal; Check again recovers.
    await installFakeHarness('claude', READY_CLAUDE_FAKE)
    await installFakeSkills('.claude/skills')
    await claudeCard.getByRole('button', { name: 'Check Claude Code again' }).click()
    await expect(claudeCard.getByText('Usable', { exact: true })).toBeVisible()

    // With a ready Harness the continue action stops calling itself capture-only.
    await page.getByRole('button', { name: 'Continue', exact: true }).click()

    // The same readiness module is reachable from Settings (Harnesses).
    await page.getByRole('button', { name: 'Harnesses' }).click()
    const dialog = page.getByRole('dialog', { name: 'Harnesses' })
    await expect(
      dialog.getByRole('region', { name: 'Codex readiness' }).getByText('Usable', { exact: true })
    ).toBeVisible()
    await dialog.getByRole('button', { name: 'Close Harnesses' }).click()

    // And it is restated immediately before any Run could start.
    await page.getByRole('button', { name: 'New Session' }).click()
    await expect(page.getByText('Ready Harnesses: Codex, Claude Code.')).toBeVisible()
  } finally {
    await app.close()
  }
})
