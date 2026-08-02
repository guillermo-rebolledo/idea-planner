import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

/**
 * Packaged-shell acceptance tests: the built app is launched for real and
 * observed through the window, covering the complete Session behavior and
 * renderer isolation.
 */

// The `electron` package resolves to the binary path in plain Node, which is
// what Playwright needs to launch — a CJS-only export with no ESM equivalent.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronBinary = require('electron') as unknown as string
const mainEntry = join(__dirname, '../out/main/index.js')

type Page = Awaited<ReturnType<ElectronApplication['firstWindow']>>

interface Sandbox {
  userDataDir: string
  /** PATH used for readiness discovery; empty means no Harness is found. */
  readinessBinDir: string
  /** HOME used for readiness skill discovery. */
  readinessHomeDir: string
  /** A folder under git, offered to the Project picker first. */
  projectDir: string
  /** A folder that is not under git, offered to the Project picker next. */
  plainDir: string
}

let sandbox: Sandbox

async function launchShell(): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronBinary,
    args: [mainEntry],
    env: {
      ...process.env,
      APP_TEST_USER_DATA: sandbox.userDataDir,
      APP_TEST_READINESS_PATH: sandbox.readinessBinDir,
      APP_TEST_READINESS_HOME: sandbox.readinessHomeDir,
      // Successive answers from the Project picker, in order.
      APP_TEST_CHOOSE_PROJECT_DIRS: [
        sandbox.projectDir,
        sandbox.plainDir,
        join(sandbox.projectDir, 'src', 'deep')
      ].join(delimiter)
    }
  })
}

test.beforeEach(async () => {
  sandbox = {
    userDataDir: await mkdtemp(join(tmpdir(), 'app-shell-userdata-')),
    readinessBinDir: await mkdtemp(join(tmpdir(), 'app-shell-readiness-bin-')),
    readinessHomeDir: await mkdtemp(join(tmpdir(), 'app-shell-readiness-home-')),
    projectDir: await mkdtemp(join(tmpdir(), 'app-shell-project-')),
    plainDir: await mkdtemp(join(tmpdir(), 'app-shell-plain-'))
  }
  // Every test needs somewhere to work, and only git can make a folder a
  // Project (ADR 0005).
  await promisify(execFile)('git', ['init', '--quiet'], { cwd: sandbox.projectDir })
  // And a Harness that can run a Session, because the app refuses to open
  // without one. The launch gate has its own test; every other test is about
  // what happens past it.
  await installFakeHarness('claude', READY_CLAUDE_FAKE)
})

test.afterEach(async () => {
  await rm(sandbox.userDataDir, { recursive: true, force: true })
  await rm(sandbox.readinessBinDir, { recursive: true, force: true })
  await rm(sandbox.readinessHomeDir, { recursive: true, force: true })
  await rm(sandbox.projectDir, { recursive: true, force: true })
  await rm(sandbox.plainDir, { recursive: true, force: true })
})

async function installFakeHarness(name: string, script: string): Promise<void> {
  await writeFile(join(sandbox.readinessBinDir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
}

async function installFakeSkills(root: string): Promise<void> {
  for (const skill of ['grilling', 'wayfinder']) {
    const dir = join(sandbox.readinessHomeDir, root, skill)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${skill}\n---\n`)
  }
}

/**
 * Onboarding: the sandbox reaches the Project through a symlink, so git names
 * a root the person did not pick and the app confirms it first.
 */
async function completeOnboarding(page: Page): Promise<void> {
  const projects = page.getByRole('region', { name: 'Projects' })
  await projects.getByRole('button', { name: 'Add Project' }).click()
  await projects.getByRole('alert').getByRole('button', { name: 'Add this Project' }).click()
  await expect(projects.getByText(basename(sandbox.projectDir), { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
}

/** A Session is started by sending a message; its title comes from it. */
async function startSession(page: Page, message: string): Promise<void> {
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await page.getByRole('form', { name: 'New chat' }).getByLabel('Message').fill(message)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByRole('heading', { name: message })).toBeVisible()
}

test('renderer is sandboxed with only the narrow preload surface', async () => {
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await page.getByRole('heading', { name: 'Add your first Project' }).waitFor()

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
      'chooseHarnessExecutable',
      'chooseProject',
      'clearHarnessExecutable',
      'confirmProject',
      'deleteSession',
      'developSession',
      'getBootState',
      'getConversation',
      'getReadiness',
      'initializeProject',
      'listDamagedSessions',
      'listProjects',
      'listRuns',
      'listSessions',
      'listStandingApprovals',
      'onConversationEvent',
      'onThemeChanged',
      'openExternalLink',
      'queryMailbox',
      'refreshReadiness',
      'removeProject',
      'resolveApproval',
      'revokeStandingApproval',
      'setLoginShellDiscovery',
      'setSessionArchived',
      'setSessionPinned',
      'setThemePreference',
      'startRun',
      'startSession',
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

test('a person starts a Session and it survives an application restart', async () => {
  const firstRun = await launchShell()
  try {
    const page = await firstRun.firstWindow()
    await completeOnboarding(page)

    // The mailbox opens empty.
    await expect(page.getByText('No Sessions yet', { exact: false })).toBeVisible()

    await startSession(page, 'Offline recipe planner')

    // The Session is app-owned state: the Project keeps only what git tracks.
    expect(await readdir(sandbox.projectDir)).toEqual(['.git'])
  } finally {
    await firstRun.close()
  }

  // Restart the application: the Session reappears from the app-owned store,
  // and onboarding is over because the Project is still there.
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

test('home is a new chat, and a Project row opens one already bound to it', async () => {
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)

    // Home is the composer, naming the Project that would be edited.
    const composer = page.getByRole('form', { name: 'New chat' })
    await expect(composer).toBeVisible()
    await expect(
      composer.getByText(await realpath(sandbox.projectDir), { exact: true })
    ).toBeVisible()

    // A Session exists only once the message is sent.
    await composer.getByLabel('Message').fill('Tidy the imports')
    const inbox = page.getByRole('navigation', { name: 'Session inbox' })
    await expect(inbox.getByText('Tidy the imports')).toHaveCount(0)
    await composer.getByRole('button', { name: 'Send' }).click()
    await expect(inbox.getByText('Tidy the imports')).toBeVisible()

    // New chat always returns to the launch surface.
    await page.getByRole('button', { name: 'New chat', exact: true }).click()
    await expect(page.getByRole('form', { name: 'New chat' })).toBeVisible()

    // So does the button on a Project row, already bound to that Project.
    await page.getByRole('button', { name: 'New chat in', exact: false }).first().click()
    const bound = page.getByRole('form', { name: 'New chat' })
    await expect(bound.getByText(await realpath(sandbox.projectDir), { exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a person organizes the mailbox: pin, search, archive, restore, compact rail', async () => {
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)
    await startSession(page, 'Offline recipe planner')
    await startSession(page, 'Community tool library')

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

    // Archive is reversible and the Project is never touched.
    await inbox.getByRole('button', { name: 'Archive “Community tool library”' }).click()
    await expect(inbox.getByText('Community tool library')).toHaveCount(0)
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(inbox.getByText('Community tool library')).toBeVisible()
    expect(await readdir(sandbox.projectDir)).toEqual(['.git'])
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

test('deleting a Session forgets it and leaves the Project alone', async () => {
  await writeFile(join(sandbox.projectDir, 'source.ts'), 'export const kept = true')

  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)
    await startSession(page, 'Doomed session')

    const inbox = page.getByRole('navigation', { name: 'Session inbox' })
    await inbox.getByRole('button', { name: 'Delete “Doomed session” permanently…' }).click()

    // The Project is named before anything happens, because what is kept is
    // the part the person actually cares about.
    const confirmation = page.getByRole('region', { name: 'Delete “Doomed session”?' })
    await expect(confirmation.getByRole('heading')).toBeVisible()
    await expect(
      confirmation.getByText(await realpath(sandbox.projectDir), { exact: true })
    ).toBeVisible()

    await page.getByRole('button', { name: 'Delete Session' }).click()
    await expect(inbox.getByText('Doomed session')).toHaveCount(0)
    await expect(page.getByText('No Sessions yet', { exact: false })).toBeVisible()

    // The work is untouched: it lives in the Project, under git.
    expect((await readdir(sandbox.projectDir)).sort()).toEqual(['.git', 'source.ts'])
  } finally {
    await app.close()
  }
})

test('a person adds a Project and a plain folder is refused with an offer to set up git', async () => {
  await writeFile(join(sandbox.plainDir, 'notes.md'), 'not under git yet')

  const app = await launchShell()
  try {
    const page = await app.firstWindow()

    const projects = page.getByRole('region', { name: 'Projects' })
    await expect(projects.getByText('No Projects yet', { exact: false })).toBeVisible()

    // A folder under git becomes a Project. The sandbox reaches it through a
    // symlink, so git names a root the person did not pick, and the app says so
    // before storing anything.
    await projects.getByRole('button', { name: 'Add Project' }).click()
    const symlinked = projects.getByRole('alert')
    await expect(
      symlinked.getByText(await realpath(sandbox.projectDir), { exact: true })
    ).toBeVisible()
    await symlinked.getByRole('button', { name: 'Add this Project' }).click()
    await expect(projects.getByText(basename(sandbox.projectDir), { exact: true })).toBeVisible()

    // A folder that is not under git is refused, naming the exact path, and
    // nothing is written until the offer is accepted.
    await projects.getByRole('button', { name: 'Add Project' }).click()
    const refusal = projects.getByRole('alert')
    await expect(refusal.getByText(sandbox.plainDir)).toBeVisible()
    await expect(refusal.getByText('git init')).toBeVisible()
    expect(await readdir(sandbox.plainDir)).not.toContain('.git')

    // Accepting it runs the one Git mutation the app performs, and the folder
    // becomes a Project.
    await refusal.getByRole('button', { name: 'Set up git here' }).click()
    await expect(projects.getByText(basename(sandbox.plainDir), { exact: true })).toBeVisible()
    expect(await readdir(sandbox.plainDir)).toContain('.git')

    // Pointing inside a Project adds the Project, but says so first: git
    // resolves a root the person did not pick, and adding it silently would
    // surprise them.
    await mkdir(join(sandbox.projectDir, 'src', 'deep'), { recursive: true })
    await projects.getByRole('button', { name: 'Add Project' }).click()
    const confirmation = projects.getByRole('alert')
    await expect(
      confirmation.getByText(join(sandbox.projectDir, 'src', 'deep'), { exact: true })
    ).toBeVisible()
    // Named exactly, because the root git resolves is the identity being added.
    await expect(
      confirmation.getByText(await realpath(sandbox.projectDir), { exact: true })
    ).toBeVisible()
    await expect(projects.getByText(basename(sandbox.projectDir), { exact: true })).toHaveCount(1)
    await confirmation.getByRole('button', { name: 'Add this Project' }).click()
    // The same Project, so it is still listed once.
    await expect(projects.getByText(basename(sandbox.projectDir), { exact: true })).toHaveCount(1)

    // Removing a Project forgets it and leaves the directory alone.
    await projects
      .getByRole('button', { name: `Remove “${basename(sandbox.plainDir)}” from the app` })
      .click()
    await expect(projects.getByText(basename(sandbox.plainDir), { exact: true })).toHaveCount(0)
    expect(await readdir(sandbox.plainDir)).toContain('notes.md')
  } finally {
    await app.close()
  }
})

const READY_CODEX_FAKE = `case "$1" in
  --version) echo "codex-cli 0.146.0"; exit 0;;
  login) exit 0;;
esac
exit 1`

const READY_CLAUDE_FAKE = `case "$1" in
  --version) echo "2.1.220 (Claude Code)"; exit 0;;
  -p) echo '{"type":"system","subtype":"init"}'; /bin/sleep 30;;
esac`

test('readiness reports Codex and Claude independently, with safe repair and re-check', async () => {
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)
    await page.getByRole('button', { name: 'Harnesses' }).click()
    const dialog = page.getByRole('dialog', { name: 'Harnesses' })
    const codexCard = dialog.getByRole('region', { name: 'Codex readiness' })
    const claudeCard = dialog.getByRole('region', { name: 'Claude Code readiness' })

    // Claude is usable; the resolved absolute path is visible.
    await expect(claudeCard.getByText('Usable', { exact: true })).toBeVisible()
    await expect(
      claudeCard.getByText(join(sandbox.readinessBinDir, 'claude'), { exact: true })
    ).toBeVisible()
    // Its Skills are missing, and that holds nothing up.
    await expect(claudeCard.getByText('npx skills@latest add mattpocock/skills')).toBeVisible()

    // Codex stays visible, not usable, and repaired independently.
    await expect(codexCard.getByText('Not usable yet')).toBeVisible()
    await installFakeHarness('codex', READY_CODEX_FAKE)
    await codexCard.getByRole('button', { name: 'Check Codex again' }).click()
    await expect(codexCard.getByText('Usable', { exact: true })).toBeVisible()
    // Usable and drivable are different questions, and the card answers both:
    // "Usable" alone above a Harness no Session can use would be a lie.
    await expect(
      codexCard.getByText('cannot run a Session with Codex yet', { exact: false })
    ).toBeVisible()

    // Installing the Skills clears the guidance and changes nothing else:
    // Claude was usable throughout, because Skills never gated it.
    await installFakeSkills('.claude/skills')
    await claudeCard.getByRole('button', { name: 'Check Claude Code again' }).click()
    await expect(claudeCard.getByText('npx skills@latest add mattpocock/skills')).toHaveCount(0)
    await expect(claudeCard.getByText('Usable', { exact: true })).toBeVisible()

    await dialog.getByRole('button', { name: 'Close Harnesses' }).click()
  } finally {
    await app.close()
  }
})

test('with no usable Harness the app says so and opens as soon as one is repaired', async () => {
  // The one test that starts from a machine the app cannot work on.
  await rm(join(sandbox.readinessBinDir, 'claude'), { force: true })

  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await page.getByRole('heading', { name: 'This app needs a coding agent to work' }).waitFor()

    // Not a bare refusal: it says which Harness is missing what.
    const missing = page.getByRole('list', { name: 'What is missing' })
    await expect(missing.getByRole('listitem')).toHaveCount(2)
    // Each names its own first problem rather than a shared refusal.
    await expect(missing.getByText('claude command was not found', { exact: false })).toBeVisible()
    await expect(missing.getByText('codex command was not found', { exact: false })).toBeVisible()
    // And onboarding is not reachable behind it.
    await expect(page.getByRole('heading', { name: 'Add your first Project' })).toHaveCount(0)

    // Repaired in the person's own terminal, then re-checked — no restart.
    await installFakeHarness('claude', READY_CLAUDE_FAKE)
    await page.getByRole('button', { name: 'Check again', exact: true }).click()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()

    await page.getByRole('heading', { name: 'Add your first Project' }).waitFor()
  } finally {
    await app.close()
  }
})
