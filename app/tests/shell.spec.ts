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
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
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
      'getConversation',
      'getReadiness',
      'initializeProject',
      'listDamagedSessions',
      'listModels',
      'listProjects',
      'listRuns',
      'listSessions',
      'listSkills',
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

/**
 * A Harness that answers the readiness probe (`-p`) and then, for a real Run
 * (`--print`), starts and keeps working — so a Run is genuinely running.
 */
const BUSY_CLAUDE_FAKE = `case "$1" in
  --version) echo "2.1.220 (Claude Code)"; exit 0;;
  -p|--print) echo '{"type":"system","subtype":"init"}'; /bin/sleep 30;;
esac`

test('the inbox groups by what a Session is doing and filters by Project', async () => {
  await installFakeHarness('claude', BUSY_CLAUDE_FAKE)
  // A second Project, because the point of the flat list is that it crosses
  // repositories and Project is only a filter over it.
  await promisify(execFile)('git', ['init', '--quiet'], { cwd: sandbox.plainDir })
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)
    const projects = page.getByRole('region', { name: 'Projects' })
    await projects.getByRole('button', { name: 'Add Project' }).click()
    await projects.getByRole('alert').getByRole('button', { name: 'Add this Project' }).click()
    await expect(projects.getByText(basename(sandbox.plainDir), { exact: true })).toBeVisible()

    await startSession(page, 'Offline recipe planner')
    await page.getByRole('button', { name: `New chat in “${basename(sandbox.plainDir)}”` }).click()
    await page
      .getByRole('form', { name: 'New chat' })
      .getByLabel('Message')
      .fill('Elsewhere entirely')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByRole('heading', { name: 'Elsewhere entirely' })).toBeVisible()

    const inbox = page.getByRole('navigation', { name: 'Session inbox' })
    const runningGroup = inbox.getByRole('region', { name: 'Running' })
    const recentGroup = inbox.getByRole('region', { name: 'Recent' })

    // A Session nobody has developed yet is Recent, not Needs attention: a
    // quiet Session in that group would make the group worth nothing.
    await expect(recentGroup.getByText('Offline recipe planner')).toBeVisible()
    await expect(
      inbox.getByRole('region', { name: 'Needs attention' }).getByRole('listitem')
    ).toHaveCount(0)

    // Developing one moves it to Running, from its Conversation rather than
    // from anything stored beside it.
    await page.getByLabel('Your message').fill('Change the greeting')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(runningGroup.getByText('Elsewhere entirely')).toBeVisible()
    await expect(recentGroup.getByText('Offline recipe planner')).toBeVisible()

    // Clicking a Project narrows the flat list; it never navigates into it.
    await projects
      .getByRole('button', { name: `Show only Sessions in “${basename(sandbox.plainDir)}”` })
      .click()
    await expect(inbox.getByText('Offline recipe planner')).toHaveCount(0)
    await expect(runningGroup.getByText('Elsewhere entirely')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Elsewhere entirely' })).toBeVisible()
    await inbox.getByRole('button', { name: 'Show all Projects' }).click()
    await expect(inbox.getByText('Offline recipe planner')).toBeVisible()

    // The rail keeps the running Session legible with the inbox collapsed, and
    // is narrowed by nothing: a filter it cannot show is a filter it drops.
    await projects
      .getByRole('button', { name: `Show only Sessions in “${basename(sandbox.plainDir)}”` })
      .click()
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
    echo '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"ok"}]},"session_id":"thread-1","tool_use_result":{"filePath":"greeting.ts","oldString":"hello","newString":"goodbye","structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-export const greeting = \\"hello\\"","+export const greeting = \\"goodbye\\""]}]}}'
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

    const panel = page.getByRole('region', { name: 'Files this Session changed' })
    // Nothing has been developed yet, so there is nothing to summarise.
    await expect(panel).toHaveCount(0)

    await page.getByLabel('Your message').fill('Go on then')
    await page.getByRole('button', { name: 'Send', exact: true }).click()

    await expect(panel.getByText('greeting.ts')).toBeVisible()
    await expect(panel.getByText('+1')).toBeVisible()
    await expect(panel.getByText('−1')).toBeVisible()
    // The person's own dirty file is not the agent's work.
    await expect(panel.getByText('mine.ts')).toHaveCount(0)

    // Opening it shows the diff, and there is nothing to accept or reject:
    // the change is already on disk and git is the only undo.
    await panel.getByRole('button', { name: 'greeting.ts', exact: false }).click()
    await expect(panel.getByText('+export const greeting = "goodbye"')).toBeVisible()
    await expect(panel.getByRole('button', { name: /accept|reject|revert|undo/i })).toHaveCount(0)
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

    const panel = page.getByRole('region', { name: 'Files this Session changed' })
    await expect(panel.getByText('quiet.ts')).toBeVisible()
    await expect(panel.getByText('changed, not reported')).toBeVisible()
    await expect(panel.getByText('mine.ts')).toHaveCount(0)

    await panel.getByRole('button', { name: 'quiet.ts', exact: false }).click()
    await expect(panel.getByText('+quietly changed')).toBeVisible()

    // A file it removed says so, rather than reading as one it edited.
    await expect(panel.getByText('doomed.ts')).toBeVisible()
    await expect(panel.getByText('deleted, not reported')).toBeVisible()
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

    const skills = page.getByRole('combobox', { name: 'Skill' })
    // The global ones are offered; the repository's own is not, yet.
    await expect(skills).toContainText('grilling')
    await expect(skills).not.toContainText('deploy-to-prod')

    // It is shown before it is trusted, with what it says it does.
    const notice = page.getByRole('alert', { name: 'Project Skills' })
    await expect(notice.getByText('deploy-to-prod', { exact: true })).toBeVisible()
    await expect(notice.getByText('Ships it')).toBeVisible()

    await notice.getByRole('button', { name: 'Trust this Project’s Skills' }).click()
    await expect(skills).toContainText('deploy-to-prod')

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
    await expect(skills).not.toContainText('deploy-to-prod')
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
