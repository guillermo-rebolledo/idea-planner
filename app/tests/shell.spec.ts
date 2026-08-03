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
  /** Stands in for `~/Library/Application Support` for this run. */
  appDataDir: string
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
      APP_TEST_APP_DATA: sandbox.appDataDir,
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
    appDataDir: await mkdtemp(join(tmpdir(), 'app-shell-appdata-')),
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
  await rm(sandbox.appDataDir, { recursive: true, force: true })
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

/** Typing `/` offers what is installed; picking one is for that message only. */
async function chooseSkill(page: Page, name: string): Promise<void> {
  const composer = page.getByLabel('Your message')
  await composer.fill('/')
  await page.getByRole('list', { name: 'Skills' }).getByRole('button', { name }).click()
}

/** A Session is started by sending a message; its title comes from it. */
async function startSession(page: Page, message: string): Promise<void> {
  await page.getByRole('button', { name: 'New Session', exact: true }).click()
  await page.getByRole('form', { name: 'New chat' }).getByLabel('Message').fill(message)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByRole('heading', { name: message })).toBeVisible()
}

test('the app is Argos to the person and to macOS, and keeps its state under its identifier', async () => {
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await page.getByRole('heading', { name: 'Add your first Project' }).waitFor()

    const identity = await app.evaluate(({ app: electronApp, BrowserWindow }) => ({
      // What the About panel is titled with. macOS takes the application
      // menu's own title from the bundle instead, which only a packaged build
      // has (14b).
      name: electronApp.getName(),
      windowTitle: BrowserWindow.getAllWindows()[0]?.getTitle(),
      stateDirectory: electronApp.getPath('userData')
    }))

    expect(identity.name).toBe('Argos')
    expect(identity.windowTitle).toBe('Argos')
    expect(await page.title()).toBe('Argos')
    // Keyed by the identifier, which is fixed, rather than by the name, which
    // is a display string: renaming the product must not lose a history.
    expect(identity.stateDirectory).toBe(join(sandbox.appDataDir, 'com.memojiinc.argos'))
  } finally {
    await app.close()
  }
})

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
      'getCheckoutFacts',
      'getConversation',
      'getReadiness',
      'initializeProject',
      'listBranches',
      'listDamagedSessions',
      'listEditors',
      'listModels',
      'listProjects',
      'listRuns',
      'listSessions',
      'listSkills',
      'listStandingApprovals',
      'onConversationEvent',
      'onThemeChanged',
      'onUndoShortcut',
      'openExternalLink',
      'openInEditor',
      'queryMailbox',
      'refreshReadiness',
      'removeProject',
      'renameSession',
      'resolveApproval',
      'revokeStandingApproval',
      'setLoginShellDiscovery',
      'setSessionArchived',
      'setSessionPinned',
      'setThemePreference',
      'startRun',
      'startSession',
      'stopRun',
      'trustProjectSkills'
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

    // New Session always returns to the launch surface.
    await page.getByRole('button', { name: 'New Session', exact: true }).click()
    await expect(page.getByRole('form', { name: 'New chat' })).toBeVisible()

    // So does the button on a Project header, already bound to that Project.
    await page.getByRole('button', { name: 'New Session in', exact: false }).first().click()
    const bound = page.getByRole('form', { name: 'New chat' })
    await expect(bound.getByText(await realpath(sandbox.projectDir), { exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a person organizes the mailbox: pin, search, archive with undo, rename, compact rail', async () => {
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)
    await startSession(page, 'Offline recipe planner')
    await startSession(page, 'Community tool library')

    const inbox = page.getByRole('navigation', { name: 'Session inbox' })
    const projectName = basename(await realpath(sandbox.projectDir))
    const pinnedGroup = inbox.getByRole('region', { name: 'Pinned' })
    const home = inbox
      .getByRole('region', { name: 'Projects' })
      .getByRole('region', { name: projectName })

    // Project-grouped: both Sessions sit under the Project that owns them.
    await expect(home.getByText('Offline recipe planner')).toBeVisible()
    await expect(home.getByText('Community tool library')).toBeVisible()

    // Pin lifts the Session into Pinned, still under its Project.
    await inbox.getByRole('button', { name: 'Pin “Offline recipe planner”' }).click()
    await expect(pinnedGroup.getByText('Offline recipe planner')).toBeVisible()
    await expect(home.getByText('Offline recipe planner')).toHaveCount(0)

    // Search narrows to matching Sessions; no-results is a visible, recoverable state.
    const search = page.getByRole('searchbox', { name: 'Search Sessions' })
    await search.fill('recipe')
    await expect(inbox.getByText('Community tool library')).toHaveCount(0)
    await expect(pinnedGroup.getByText('Offline recipe planner')).toBeVisible()
    await search.fill('zeppelin')
    await expect(inbox.getByText('No Sessions match', { exact: false })).toBeVisible()
    await inbox.getByRole('button', { name: 'Clear search' }).click()
    await expect(inbox.getByText('Community tool library')).toBeVisible()

    // Archive is instant — no confirmation — and ⌘Z takes it back.
    await inbox.getByRole('button', { name: 'More for “Community tool library”' }).click()
    await page.getByRole('menuitem', { name: 'Archive' }).click()
    await expect(inbox.getByText('Community tool library')).toHaveCount(0)
    expect(await readdir(sandbox.projectDir)).toEqual(['.git'])
    // Only once the menu is fully gone: while it is dismissing it still owns
    // the keyboard.
    await expect(page.getByRole('menu')).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(inbox.getByText('Community tool library')).toBeVisible()

    // The archive lives behind the app menu, dimmed rows offering Restore.
    await inbox.getByRole('button', { name: 'More for “Community tool library”' }).click()
    await page.getByRole('menuitem', { name: 'Archive' }).click()
    await page.getByRole('button', { name: 'App menu' }).click()
    await page.getByRole('menuitem', { name: 'Archived Sessions' }).click()
    await expect(inbox.getByText('Community tool library')).toBeVisible()
    await inbox.getByRole('button', { name: 'Restore' }).click()
    await expect(inbox.getByText('No archived Sessions', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Back to the inbox' }).click()
    await expect(home.getByText('Community tool library')).toBeVisible()

    // Rename puts the person's own words on the row, durably.
    await inbox.getByRole('button', { name: 'More for “Community tool library”' }).click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const rename = inbox.getByRole('textbox', { name: 'Rename “Community tool library”' })
    await rename.fill('Tool shed')
    await rename.press('Enter')
    await expect(home.getByText('Tool shed')).toBeVisible()
    await expect(inbox.getByText('Community tool library')).toHaveCount(0)

    // The inbox collapses to a compact rail that keeps Sessions reachable
    // while the center surface stays in place.
    await page.getByRole('button', { name: 'Collapse inbox to rail' }).click()
    const rail = page.getByRole('navigation', { name: 'Session inbox (compact)' })
    await expect(rail.getByRole('button', { name: 'Offline recipe planner' })).toBeVisible()
    await expect(page.getByRole('main')).toBeVisible()
    await rail.getByRole('button', { name: 'Tool shed' }).click()
    await expect(page.getByRole('heading', { name: 'Tool shed' })).toBeVisible()
  } finally {
    await app.close()
  }
})

/**
 * A Harness that answers the readiness probe (`-p`) and then, for a real Run
 * (`--print`), starts and keeps working — so a Run is genuinely running.
 */
const BUSY_CLAUDE_FAKE = `case "$1" in
  --version) echo "2.1.220 (Claude Code)"; exit 0;;
  -p|--print) echo '{"type":"system","subtype":"init"}'; /bin/sleep 30;;
esac`

test('the sidebar groups by Project, and status is a dot that never moves a row', async () => {
  await installFakeHarness('claude', BUSY_CLAUDE_FAKE)
  // A second Project, because the sidebar spans repositories: every Project
  // is its own group with its Sessions nested underneath.
  await promisify(execFile)('git', ['init', '--quiet'], { cwd: sandbox.plainDir })
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)
    // The second Project is added from the app menu; the sandbox reaches it
    // through a symlink, so git names the root and the app confirms it first.
    await page.getByRole('button', { name: 'App menu' }).click()
    await page.getByRole('menuitem', { name: 'Add Project…' }).click()
    await page
      .getByRole('dialog', { name: 'That folder is inside a Project' })
      .getByRole('button', { name: 'Add this Project' })
      .click()
    const inboxNav = page.getByRole('navigation', { name: 'Session inbox' })
    await expect(inboxNav.getByText(basename(sandbox.plainDir), { exact: true })).toBeVisible()

    await startSession(page, 'Offline recipe planner')
    await page
      .getByRole('button', { name: `New Session in “${basename(sandbox.plainDir)}”` })
      .click()
    await page
      .getByRole('form', { name: 'New chat' })
      .getByLabel('Message')
      .fill('Elsewhere entirely')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByRole('heading', { name: 'Elsewhere entirely' })).toBeVisible()

    const inbox = page.getByRole('navigation', { name: 'Session inbox' })
    const homeGroup = inbox.getByRole('region', {
      name: basename(await realpath(sandbox.projectDir))
    })
    const otherGroup = inbox.getByRole('region', { name: basename(sandbox.plainDir) })

    // Each Session sits under its own Project, and a quiet Session carries no
    // dot: at rest a row is only its title.
    await expect(homeGroup.getByText('Offline recipe planner')).toBeVisible()
    await expect(otherGroup.getByText('Elsewhere entirely')).toBeVisible()
    await expect(homeGroup.getByRole('img', { name: 'Running' })).toHaveCount(0)

    // Developing one puts a running dot on its row — read from its
    // Conversation rather than from anything stored beside it — and the row
    // stays exactly where it was.
    await page.getByLabel('Your message').fill('Change the greeting')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(otherGroup.getByRole('img', { name: 'Running' })).toBeVisible()
    await expect(otherGroup.getByText('Elsewhere entirely')).toBeVisible()
    await expect(homeGroup.getByText('Offline recipe planner')).toBeVisible()

    // The rail keeps the running Session legible with the inbox collapsed.
    await page.getByRole('button', { name: 'Collapse inbox to rail' }).click()
    const rail = page.getByRole('navigation', { name: 'Session inbox (compact)' })
    await expect(rail.getByRole('button', { name: 'Elsewhere entirely, running' })).toBeVisible()
    await expect(rail.getByRole('button', { name: 'Offline recipe planner' })).toBeVisible()
  } finally {
    await app.close()
  }
})

/** A Harness that edits one file and says so, the way Claude Code reports it. */
const EDITING_CLAUDE_FAKE = `case "$1" in
  --version) echo "2.1.220 (Claude Code)"; exit 0;;
  -p) echo '{"type":"system","subtype":"init"}'; /bin/sleep 30;;
  --print)
    echo '{"type":"system","subtype":"init"}'
    echo '{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_0","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_0","name":"Read","input":{"file_path":"greeting.ts"}}]},"session_id":"thread-1"}'
    echo '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"ok"}]},"session_id":"thread-1","tool_use_result":{"filePath":"greeting.ts","oldString":"hello","newString":"goodbye","structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-export const greeting = \\"hello\\"","+export const greeting = \\"goodbye\\""]}]}}'
    echo '{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_2","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"Bash","input":{"command":"echo ok"}}]},"session_id":"thread-1"}'
    echo '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_2","type":"tool_result","content":"ok","is_error":false}]},"session_id":"thread-1","tool_use_result":{"stdout":"ok","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}}'
    echo '{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"Done."}]},"session_id":"thread-1"}'
    /bin/sleep 1
    exit 0;;
esac`

test('a Session says which files it changed, and offers nothing to accept', async () => {
  await installFakeHarness('claude', EDITING_CLAUDE_FAKE)
  // The person was already working here before the agent was. Their own edit
  // must never be reported as the agent's (ADR 0004).
  await writeFile(join(sandbox.projectDir, 'mine.ts'), 'export const mine = true')

  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)
    await startSession(page, 'Change the greeting')

    // The panel is toggled from the title-bar diff numbers, and until they
    // are asked for they stay a quiet +0 −0.
    const chip = page.getByRole('button', { name: /Files this Session changed/ })
    const panel = page.getByRole('complementary', { name: 'Files this Session changed' })
    await expect(chip).toContainText('+0')
    await expect(panel).toHaveCount(0)

    await page.getByLabel('Your message').fill('Go on then')
    await page.getByRole('button', { name: 'Send', exact: true }).click()

    // The title bar adds the Run's change up live, without the panel open.
    await expect(chip).toContainText('+1')
    await expect(chip).toContainText('−1')

    await chip.click()
    const row = panel.getByRole('button', { name: /greeting\.ts/ })
    await expect(row).toBeVisible()
    await expect(row).toContainText('+1')
    await expect(row).toContainText('−1')
    // The person's own dirty file is not the agent's work.
    await expect(panel.getByText('mine.ts')).toHaveCount(0)

    // Opening it shows the diff, and there is nothing to accept or reject:
    // the change is already on disk and git is the only undo.
    await row.click()
    await expect(panel.getByText('+export const greeting = "goodbye"')).toBeVisible()
    await expect(panel.getByRole('button', { name: /accept|reject|revert|undo/i })).toHaveCount(0)

    // The diff numbers toggle: the same chip puts the panel away.
    await chip.click()
    await expect(panel).toHaveCount(0)

    // The Conversation marks the Run with a quiet divider, and the Run's
    // activity collapses to one line when it finishes (mock 2d).
    const history = page.getByRole('list', { name: 'Conversation history' })
    await expect(history.getByText(/^Run · /).last()).toBeVisible()
    const block = history.getByLabel('Run activity').last()
    await expect(block).toContainText('Edited 1 file')

    // The chevron re-expands it to the chronological step list — the read,
    // the edit, the command. Steps only, no captured output.
    await block.getByRole('button', { name: /Edited 1 file/ }).click()
    const steps = history.getByRole('list', { name: 'Run steps' })
    await expect(steps.getByText('Read greeting.ts')).toBeVisible()
    await expect(steps.getByText('echo ok')).toBeVisible()
    await expect(steps.getByText('ok', { exact: true })).toHaveCount(0)

    // The edited file is a way into the Files panel, focused on that file.
    const step = steps.getByRole('button', { name: /greeting\.ts/ })
    await expect(step).toBeVisible()
    await step.click()
    await expect(panel.getByText('+export const greeting = "goodbye"')).toBeVisible()
  } finally {
    await app.close()
  }
})

/**
 * A Harness that changes a file the way a shell command does — no edit tool,
 * no report — and one that reports nothing at all about it.
 */
const QUIET_CLAUDE_FAKE = `case "$1" in
  --version) echo "2.1.220 (Claude Code)"; exit 0;;
  -p) echo '{"type":"system","subtype":"init"}'; /bin/sleep 30;;
  --print)
    echo '{"type":"system","subtype":"init"}'
    printf 'quietly changed\n' >> quiet.ts
    rm -f doomed.ts
    echo '{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"Done."}]},"session_id":"thread-1"}'
    /bin/sleep 1
    exit 0;;
esac`

test('a change nobody reported is still listed, and says nobody reported it', async () => {
  await installFakeHarness('claude', QUIET_CLAUDE_FAKE)
  await writeFile(join(sandbox.projectDir, 'quiet.ts'), 'export const quiet = true\n')
  await writeFile(join(sandbox.projectDir, 'doomed.ts'), 'export const doomed = true\n')
  // Dirty before the Session, and never the agent's work.
  await writeFile(join(sandbox.projectDir, 'mine.ts'), 'export const mine = true\n')

  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)
    await startSession(page, 'Tidy it up')
    await page.getByLabel('Your message').fill('Go on then')
    await page.getByRole('button', { name: 'Send', exact: true }).click()

    const chip = page.getByRole('button', { name: /Files this Session changed/ })
    await expect(chip).toContainText('+1')
    await chip.click()

    const panel = page.getByRole('complementary', { name: 'Files this Session changed' })
    const quietRow = panel.getByRole('button', { name: /quiet\.ts/ })
    await expect(quietRow).toBeVisible()
    await expect(panel.getByText('mine.ts')).toHaveCount(0)

    // Opening it shows the change, and says nothing accounted for it.
    await quietRow.click()
    await expect(panel.getByText('+quietly changed')).toBeVisible()
    await expect(
      panel.getByText('a command the agent ran changed this', { exact: false })
    ).toBeVisible()

    // A file it removed says so, rather than reading as one it edited.
    const doomedRow = panel.getByRole('button', { name: /doomed\.ts/ })
    await expect(doomedRow).toHaveAttribute('title', /deleted, not reported/)
  } finally {
    await app.close()
  }
})

test('the title bar states where a Session works — Local, or an isolated Worktree', async () => {
  const git = promisify(execFile)
  const gitc = (args: string[]): Promise<unknown> =>
    git('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...args], {
      cwd: sandbox.projectDir
    })
  // A commit and a named branch, so the branch chip has something
  // deterministic to state, and a real worktree beside the working copy.
  await writeFile(join(sandbox.projectDir, 'app.ts'), 'export const app = true\n')
  await gitc(['add', '-A'])
  await gitc(['commit', '--quiet', '-m', 'init'])
  await gitc(['checkout', '--quiet', '-b', 'trunk'])
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)
    await startSession(page, 'Local facts')

    // The cluster (2a): branch and checkout kind, stated quietly.
    const chips = page.getByRole('button', { name: /Project card for/ })
    await expect(chips).toContainText('trunk')
    await expect(chips).toContainText('Local')

    // Clicking them opens the Project card (2b) with every fact on it.
    await chips.click()
    const card = page.getByRole('group', { name: 'Project card' })
    await expect(card.getByText('working copy')).toBeVisible()
    await expect(card.getByText('trunk')).toBeVisible()
    // Its Changes row is a way into the Files panel.
    await card.getByRole('button', { name: 'Changes' }).click()
    await expect(
      page.getByRole('complementary', { name: 'Files this Session changed' })
    ).toBeVisible()

    // "Open in" offers what every Mac has, and says what opening means. It is
    // not clicked: the suite must not launch a real application.
    await page.getByRole('button', { name: 'Open the Checkout in an editor' }).click()
    const menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem', { name: 'Terminal' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Finder' })).toBeVisible()
    await expect(menu.getByText('edits are already there', { exact: false })).toBeVisible()
    await page.keyboard.press('Escape')

    // A Session fixed to an isolated Checkout at creation, chosen with the
    // composer's own Checkout chip: Isolated, cut from the chosen base. The
    // app creates the linked worktree itself, in its own state directory.
    await page.getByRole('button', { name: 'New Session', exact: true }).click()
    const composer = page.getByRole('form', { name: 'New chat' })
    await composer.getByLabel('Message').fill('Fix the location crash')
    await composer.getByRole('button', { name: 'Checkout' }).click()
    await page.getByRole('button', { name: 'Isolated' }).click()
    // The base settles onto the branch the working copy is on.
    await expect(page.getByRole('combobox', { name: 'Base branch' })).toHaveValue('trunk')
    await page.keyboard.press('Escape')
    await expect(composer.getByRole('button', { name: 'Checkout' })).toContainText('Worktree')
    await composer.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByRole('heading', { name: 'Fix the location crash' })).toBeVisible()

    // The same cluster now states the worktree's own facts, on the branch cut
    // from the message that started the Session.
    await expect(chips).toContainText('Worktree')
    await expect(chips).toContainText('fix-the-location-crash')
    await chips.click()
    await expect(card.getByText(/worktrees/)).toBeVisible()
    await expect(card.getByText('working copy')).toHaveCount(0)
    // The person's own copy never moved.
    const { stdout } = await git('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: sandbox.projectDir
    })
    expect(stdout.trim()).toBe('trunk')
  } finally {
    await app.close()
  }
})

/** A Codex that answers `model/list`, as the installed one does. */
const MODEL_LISTING_CODEX = `case "$1" in
  --version) echo "codex-cli 0.146.0"; exit 0;;
  login) exit 0;;
  app-server)
    while IFS= read -r line; do
      case "$line" in
        *'"initialize"'*) printf '{"jsonrpc":"2.0","id":1,"result":{}}\n';;
        *'"model/list"'*)
          printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"data":[{"id":"gpt-5.6-sol","displayName":"GPT-5.6-Sol","description":"The default","hidden":false,"isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}],"defaultReasoningEffort":"low"}],"nextCursor":null}}'
          ;;
      esac
    done
    exit 0;;
esac
exit 1`

test('one picker chooses the model, and with it the Harness that runs it', async () => {
  await installFakeHarness('codex', MODEL_LISTING_CODEX)
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)
    await startSession(page, 'Choose the thinking')

    // Both Harnesses are usable, so both are groups — and the Harness is not
    // a control of its own any more. The one control is a combobox, which is
    // the contract the vendored component carries.
    await expect(page.getByRole('combobox', { name: 'Harness' })).toHaveCount(0)
    const picker = page.getByRole('combobox', { name: 'Model', exact: true })
    await picker.click()
    await expect(page.getByText('Claude Code', { exact: true })).toBeVisible()
    await expect(page.getByText('Codex', { exact: true })).toBeVisible()

    // Codex's models are the ones Codex itself listed.
    await page.getByRole('option', { name: /GPT-5.6-Sol/ }).click()
    await expect(picker).toContainText('GPT-5.6-Sol')
    // And choosing it says what came with it, because the Harness changed.
    await expect(page.getByText('runs Skills as instruction text', { exact: false })).toBeVisible()

    // Whose model it is, without reading the group heading again.
    await expect(picker.locator('svg[viewBox="0 0 256 260"]')).toBeVisible()

    // The thinking levels are that model's own, as Codex reported them.
    await picker.click()
    const thinking = page.getByRole('radiogroup', { name: 'Thinking' })
    await expect(thinking.getByRole('radio', { name: 'Low' })).toBeVisible()
    await expect(thinking.getByRole('radio', { name: 'High' })).toBeVisible()
    await expect(thinking.getByRole('radio', { name: 'Med' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    // Permission Mode is a chip and a popover, not a select (1f). Choosing
    // Full access turns the chip amber and its title with it.
    const permission = page.getByRole('button', { name: 'Permission Mode' })
    await expect(permission).toContainText('Ask')
    await permission.click()
    await expect(page.getByText('The agent stops for your consent', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: /Full access/ }).click()
    await expect(permission).toContainText('Full access')

    // Its footer names what this Project has permanently allowed, and opens
    // the one manager. Nothing is granted here, so nothing is listed.
    await permission.click()
    await page.getByRole('button', { name: /Standing Approval/ }).click()
    const manager = page.getByRole('dialog', { name: 'Standing Approvals' })
    await expect(
      manager.getByText('Nothing is permanently allowed', { exact: false })
    ).toBeVisible()
    await manager.getByRole('button', { name: 'Close' }).click()
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
    // Reached through the row's own context menu, as 3a draws it.
    await inbox.getByText('Doomed session').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete…' }).click()

    // The one destructive dialog in the app. The Project is named before
    // anything happens, because what is kept is the part the person cares
    // about — and git, not the app, is the undo for files.
    const confirmation = page.getByRole('alertdialog', { name: 'Delete “Doomed session”?' })
    await expect(confirmation.getByText('use git to undo those', { exact: false })).toBeVisible()
    await expect(
      confirmation.getByText(basename(await realpath(sandbox.projectDir)), { exact: true })
    ).toBeVisible()

    await confirmation.getByRole('button', { name: 'Delete Session' }).click()
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
    // Harnesses live behind the app menu in the sidebar footer.
    await page.getByRole('button', { name: 'App menu' }).click()
    await page.getByRole('menuitem', { name: 'Harnesses' }).click()
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
    // Usable and drivable are different questions and the card answers both.
    // Codex answers yes to the second now that it speaks the app-server
    // protocol; before that it was usable and could still run nothing.
    await expect(
      codexCard.getByText('can run a Session with Codex', { exact: false })
    ).toBeVisible()

    // Skills say what is installed rather than raising an alarm: they cannot
    // block anything, so they are never reported as though they had.
    await expect(claudeCard.getByText('Not installed', { exact: true })).toBeVisible()
    await expect(claudeCard.getByText('Usable with a warning')).toHaveCount(0)

    // Installing them clears the guidance and changes nothing else: Claude was
    // usable throughout, because Skills never gated it.
    await installFakeSkills('.claude/skills')
    await claudeCard.getByRole('button', { name: 'Check Claude Code again' }).click()
    await expect(claudeCard.getByText('npx skills@latest add mattpocock/skills')).toHaveCount(0)
    await expect(claudeCard.getByText('Installed', { exact: true })).toBeVisible()
    await expect(claudeCard.getByText('Usable', { exact: true })).toBeVisible()

    await dialog.getByRole('button', { name: 'Close Harnesses' }).click()
  } finally {
    await app.close()
  }
})

test('a Project’s own Skills are shown, trusted once, and then offered', async () => {
  // Installed the way a person installs them: a directory with a SKILL.md, in
  // the place the Harness itself reads.
  await installFakeSkills('.claude/skills')
  const own = join(sandbox.projectDir, '.claude', 'skills', 'deploy-to-prod')
  await mkdir(own, { recursive: true })
  await writeFile(join(own, 'SKILL.md'), '---\ndescription: Ships it\n---\n')

  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)
    await startSession(page, 'Offline receipts')

    // Skills are asked for with `/` in the message — there is no separate
    // control. The global ones are offered; the Project's own is not, yet.
    const skills = page.getByRole('list', { name: 'Skills' })
    await page.getByLabel('Your message').fill('/')
    await expect(skills.getByRole('button', { name: /grilling/ })).toBeVisible()
    await expect(skills.getByRole('button', { name: /deploy-to-prod/ })).toHaveCount(0)
    await page.getByLabel('Your message').fill('')

    // It is shown before it is trusted, with what it says it does.
    const notice = page.getByRole('alert', { name: 'Project Skills' })
    await expect(notice.getByText('deploy-to-prod', { exact: true })).toBeVisible()
    await expect(notice.getByText('Ships it')).toBeVisible()

    await notice.getByRole('button', { name: 'Trust this Project’s Skills' }).click()
    await page.getByLabel('Your message').fill('/')
    await expect(skills.getByRole('button', { name: /deploy-to-prod/ })).toBeVisible()
    await page.getByLabel('Your message').fill('')

    // Typing `/` offers what is installed, and the choice is for this message.
    await chooseSkill(page, 'grilling')
    await expect(page.getByText('This message asks for the')).toBeVisible()
    // Picking takes the `/` back out; the message itself is what follows.
    await page.getByLabel('Your message').fill('Grill me on this')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    // Gone with the message it was chosen for: the next one asks for nothing.
    await expect(page.getByText('This message asks for the')).toHaveCount(0)

    // Trust is revocable where it was given, and withdrawing it takes the
    // Skill back out of what is offered.
    await page.getByRole('button', { name: 'Stop trusting them' }).click()
    await page.getByLabel('Your message').fill('/')
    await expect(skills.getByRole('button', { name: /grilling/ })).toBeVisible()
    await expect(skills.getByRole('button', { name: /deploy-to-prod/ })).toHaveCount(0)
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
