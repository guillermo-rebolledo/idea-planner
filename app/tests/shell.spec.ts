import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { testGit as git } from '../src/main/git-test-support'

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

async function launchShell(options: { quitWarning?: boolean } = {}): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronBinary,
    args: [mainEntry],
    env: {
      ...process.env,
      APP_TEST_APP_DATA: sandbox.appDataDir,
      APP_TEST_BACKGROUND: '1',
      APP_TEST_READINESS_PATH: sandbox.readinessBinDir,
      APP_TEST_READINESS_HOME: sandbox.readinessHomeDir,
      ...(options.quitWarning ? { APP_TEST_QUIT_WARNING: '1' } : {}),
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
  await git('git', ['init', '--quiet'], { cwd: sandbox.projectDir })
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
  await page.getByRole('button', { name: 'Choose a folder…' }).click()
  await page.getByRole('alert').getByRole('button', { name: 'Add this Project' }).click()
  const addedCard = page.getByRole('status').filter({ hasText: basename(sandbox.projectDir) })
  await addedCard.getByRole('button', { name: 'Continue', exact: true }).click()
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
  const composer = page.getByRole('form', { name: 'New chat' })
  // A visible model means this helper will start a Run, not only persist the
  // Session while readiness and the asynchronous model catalog are racing on
  // first launch. Synchronise the test at the same focus refresh the UI uses.
  await page.evaluate(async () => {
    await window.shell.refreshReadiness()
    window.dispatchEvent(new Event('focus'))
  })
  await expect(composer.getByRole('combobox', { name: 'Model' })).toBeVisible()
  await composer.getByLabel('Message').fill(message)
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
      windowVisible: BrowserWindow.getAllWindows()[0]?.isVisible(),
      windowFocused: BrowserWindow.getAllWindows()[0]?.isFocused(),
      stateDirectory: electronApp.getPath('userData')
    }))

    expect(identity.name).toBe('Argos')
    expect(identity.windowTitle).toBe('Argos')
    expect(identity.windowVisible).toBe(false)
    expect(identity.windowFocused).toBe(false)
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
      'cancelQueuedSubmission',
      'chooseHarnessExecutable',
      'chooseProject',
      'clearHarnessExecutable',
      'confirmProject',
      'deleteSession',
      'developSession',
      'editQueuedSubmission',
      'enqueueQueuedSubmission',
      'getBootState',
      'getCheckoutFacts',
      'getConversation',
      'getQuitWarningPreference',
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
      'moveQueuedSubmission',
      'offerProject',
      'onConversationEvent',
      'onOpenSessionRequest',
      'onQuitRequested',
      'onThemeChanged',
      'onToggleSidebarShortcut',
      'onUndoShortcut',
      'openExternalLink',
      'openInEditor',
      'pathForFile',
      'pauseConversationQueue',
      'queryMailbox',
      'refreshReadiness',
      'removeProject',
      'renameSession',
      'resolveApproval',
      'respondToQuitRequest',
      'resumeConversationQueue',
      'resumeWorktreeBootstrap',
      'revokeStandingApproval',
      'sendQueuedSubmissionNow',
      'setLoginShellDiscovery',
      'setQuitWarningPreference',
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

test('Queued Submissions are durable and keyboard-editable', async () => {
  // This test needs a genuinely active Run. The default readiness fake exits
  // quickly so unrelated shell tests do not have to stop it explicitly.
  await installFakeHarness('claude', LONG_RUNNING_CLAUDE_FAKE)
  const firstRun = await launchShell()
  try {
    const page = await firstRun.firstWindow()
    await completeOnboarding(page)
    await startSession(page, 'Keep working while I queue messages')
    const composer = page.getByLabel('Your message')
    await composer.fill('First queued message')
    await page.getByRole('button', { name: 'Add to queue' }).click()
    const queue = page.getByRole('region', { name: 'Queued Submissions' })
    await expect(queue.getByText('First queued message')).toBeVisible()
    await page.evaluate(async () => {
      const [session] = await window.shell.listSessions()
      if (!session) throw new Error('Session missing')
      await window.shell.enqueueQueuedSubmission({
        sessionId: session.id,
        submissionId: 'shell-queued-second',
        text: 'Second queued message',
        source: 'composer',
        harness: 'claude',
        model: 'default',
        effort: null,
        permissionMode: 'ask',
        reviewAttachments: []
      })
    })
    await page.reload()
    await page
      .getByRole('navigation', { name: 'Session inbox' })
      .getByText('Keep working while I queue messages')
      .click()

    const refreshedQueue = page.getByRole('region', { name: 'Queued Submissions' })
    await expect(refreshedQueue.getByText('Second queued message')).toBeVisible()
    await refreshedQueue.getByRole('button', { name: 'Move Second queued message earlier' }).focus()
    await page.keyboard.press('Enter')
    await expect(refreshedQueue.getByRole('status')).toContainText('Moved earlier')
    await refreshedQueue.getByRole('button', { name: 'Edit Second queued message' }).click()
    await refreshedQueue.getByLabel('Edit queued message').fill('Edited queued message')
    await refreshedQueue.getByRole('button', { name: 'Save queued message' }).click()
    await expect(refreshedQueue.getByText('Edited queued message')).toBeVisible()
  } finally {
    await firstRun.close()
  }

  const restarted = await launchShell()
  try {
    const page = await restarted.firstWindow()
    await page
      .getByRole('navigation', { name: 'Session inbox' })
      .getByText('Keep working while I queue messages')
      .click()
    const restartedQueue = await page.evaluate(async () => {
      const [session] = await window.shell.listSessions()
      if (!session) throw new Error('Session missing after restart')
      return (await window.shell.getConversation(session.id)).queue
    })
    expect(restartedQueue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'Edited queued message',
          status: 'pending',
          controls: expect.objectContaining({ edit: true, cancel: true })
        })
      ])
    )
    expect(restartedQueue.outcome).toMatchObject({ type: 'paused' })
    const queue = page.getByRole('region', { name: 'Queued Submissions' })
    await expect(queue.getByText('Edited queued message')).toBeVisible()
    await expect(queue.getByRole('button', { name: 'Resume queue' })).toBeVisible()
    await page.getByLabel('Your message').fill('A message added while paused')
    await expect(page.getByRole('button', { name: 'Add to queue' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0)
  } finally {
    await restarted.close()
  }
})

test('home is a new chat, and a Project row opens one already bound to it', async () => {
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)

    // Home is the composer, and the Project it would edit is named in the
    // question itself — with the exact root on the control that changes it.
    const composer = page.getByRole('form', { name: 'New chat' })
    await expect(composer).toBeVisible()
    const project = composer.getByRole('button', { name: 'Project' })
    await expect(project).toContainText(basename(await realpath(sandbox.projectDir)))
    await expect(project).toHaveAttribute('title', await realpath(sandbox.projectDir))

    // A Session exists only once the message is sent.
    await composer.getByLabel('Message').fill('Tidy the imports')
    const inbox = page.getByRole('navigation', { name: 'Session inbox' })
    await expect(inbox.getByText('Tidy the imports')).toHaveCount(0)
    await composer.getByRole('button', { name: 'Send' }).click()
    await expect(inbox.getByText('Tidy the imports')).toBeVisible()

    // And sending starts the work, not just the record: the message that
    // created the Session is answered by its first Run.
    await expect(
      page.getByRole('log', { name: 'Conversation history' }).getByText(/^Run · /)
    ).toBeVisible()

    // New Session always returns to the launch surface. The only suggestion
    // chips are the Project's own recent Sessions — no generic filler the
    // app pretends to have thought of.
    await page.getByRole('button', { name: 'New Session', exact: true }).click()
    const fresh = page.getByRole('form', { name: 'New chat' })
    await expect(fresh).toBeVisible()
    const recents = fresh.getByRole('list', { name: 'Recent Sessions' })
    await expect(recents.getByRole('button')).toHaveCount(1)

    // The work already under way is offered by name, so continuing it is as
    // easy as starting a second Session about the same thing.
    await recents.getByRole('button', { name: 'Continue “Tidy the imports”' }).click()
    await expect(page.getByRole('heading', { name: 'Tidy the imports' })).toBeVisible()

    // So does the button on a Project header, already bound to that Project.
    await page.getByRole('button', { name: 'New Session in', exact: false }).first().click()
    const bound = page.getByRole('form', { name: 'New chat' })
    await expect(bound.getByRole('button', { name: 'Project' })).toHaveAttribute(
      'title',
      await realpath(sandbox.projectDir)
    )
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

    // The global shortcut toggles in either direction even while the composer
    // owns focus, without stealing the draft or invoking the browser's Save.
    const focusedField = page.getByRole('searchbox', { name: 'Search Sessions' })
    await focusedField.focus()
    await page.keyboard.press('ControlOrMeta+s')
    const rail = page.getByRole('navigation', { name: 'Session inbox (compact)' })
    await expect(rail).toBeVisible()
    await page.keyboard.press('ControlOrMeta+s')
    await expect(page.getByRole('navigation', { name: 'Session inbox' })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+s')

    // The inbox collapses to one Project navigator rather than one ambiguous
    // icon per Session. Projects and their Sessions open as cascading lists,
    // while the center surface stays in place.
    await expect(rail.getByRole('button', { name: 'Offline recipe planner' })).toHaveCount(0)
    await expect(page.getByRole('main')).toBeVisible()
    await rail.getByRole('button', { name: 'Browse Projects and Sessions' }).click()
    const projects = page.getByRole('dialog', { name: 'Projects' })
    await projects.getByRole('button', { name: `${projectName}, 2 Sessions` }).click()
    const sessions = page.getByRole('dialog', { name: `${projectName} Sessions` })
    await sessions.getByRole('button', { name: 'Tool shed' }).click()
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

test('quitting with active agents warns, safely exits, and remembers the reversible choice', async () => {
  await installFakeHarness('claude', BUSY_CLAUDE_FAKE)
  const firstRun = await launchShell({ quitWarning: true })
  try {
    const page = await firstRun.firstWindow()
    await completeOnboarding(page)
    await startSession(page, 'Keep this agent busy while quitting')
    await expect(page.getByRole('img', { name: 'Run in progress' })).toBeVisible()

    await firstRun.evaluate(({ app: electronApp }) => electronApp.quit())
    const warning = page.getByRole('dialog', { name: 'An agent is still working' })
    await expect(warning).toContainText('safely stops every active Run and its processes')
    await warning.getByRole('button', { name: 'Keep Working' }).click()
    await expect(warning).toHaveCount(0)

    await firstRun.evaluate(({ app: electronApp }) => electronApp.quit())
    await expect(warning).toBeVisible()
    const exited = new Promise<void>((resolve) => firstRun.process().once('exit', () => resolve()))
    const alwaysQuit = warning
      .getByRole('button', { name: 'Always Quit Without Asking' })
      .click()
      .catch(() => undefined)
    await exited
    await alwaysQuit
  } finally {
    await firstRun.close().catch(() => undefined)
  }

  const secondRun = await launchShell({ quitWarning: true })
  try {
    const page = await secondRun.firstWindow()
    await page.getByRole('button', { name: 'App menu' }).click()
    await page.getByRole('menuitem', { name: 'Settings…' }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    const preference = settings.getByRole('checkbox', {
      name: 'Warn before quitting with active agents'
    })
    await expect(preference).not.toBeChecked()
    await preference.check()
    await settings.getByRole('button', { name: 'Done' }).click()

    await startSession(page, 'Warn me again before quitting')
    await expect(page.getByRole('img', { name: 'Run in progress' })).toBeVisible()
    await secondRun.evaluate(({ app: electronApp }) => electronApp.quit())
    const warning = page.getByRole('dialog', { name: 'An agent is still working' })
    await expect(warning).toBeVisible()
    const exited = new Promise<void>((resolve) => secondRun.process().once('exit', () => resolve()))
    const quit = warning
      .getByRole('button', { name: 'Quit Anyway' })
      .click()
      .catch(() => undefined)
    await exited
    await quit
  } finally {
    await secondRun.close().catch(() => undefined)
  }
})

test('Ctrl+C safely exits without asking to keep the app open', async () => {
  await installFakeHarness('claude', BUSY_CLAUDE_FAKE)
  const app = await launchShell({ quitWarning: true })
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)
    await startSession(page, 'Stop this agent from the terminal')
    await expect(page.getByRole('img', { name: 'Run in progress' })).toBeVisible()

    const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()))
    const interrupt = app.evaluate(() => process.emit('SIGINT')).catch(() => undefined)
    await exited
    await interrupt
  } finally {
    await app.close().catch(() => undefined)
  }
})

/**
 * A Harness that keeps talking: enough prose to overflow the transcript, sent
 * a line at a time, so a reader can be somewhere else while it arrives.
 */
const CHATTY_CLAUDE_FAKE = `case "$1" in
  --version) echo "2.1.220 (Claude Code)"; exit 0;;
  -p) echo '{"type":"system","subtype":"init"}'; /bin/sleep 30;;
  --print)
    echo '{"type":"system","subtype":"init","session_id":"thread-1","model":"claude-opus-5"}'
    i=0
    while [ $i -lt 24 ]; do
      echo '{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_'$i'","type":"message","role":"assistant","content":[{"type":"text","text":"Paragraph '$i' of the answer, long enough to take a line of its own in the transcript."}]},"session_id":"thread-1"}'
      i=$((i+1))
      /bin/sleep 0.2
    done
    /bin/sleep 2
    exit 0;;
esac`

/**
 * One Harness message that crosses both checkpoint boundaries: first a
 * partial value, then its complete durable handoff. The pauses leave enough
 * room for the renderer's durable refresh lane to observe each checkpoint.
 */
const CHECKPOINTING_CLAUDE_FAKE = `case "$1" in
  --version) echo "2.1.220 (Claude Code)"; exit 0;;
  -p) echo '{"type":"system","subtype":"init"}'; /bin/sleep 30;;
  --print)
    echo '{"type":"system","subtype":"init","session_id":"thread-1","model":"claude-opus-5"}'
    echo '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_checkpoint"}}}'
    echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Checkpointed once"}}}'
    /bin/sleep 0.4
    echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":" and handed off"}}}'
    /bin/sleep 0.4
    echo '{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_checkpoint","type":"message","role":"assistant","content":[{"type":"text","text":"Checkpointed once and handed off"}]},"session_id":"thread-1"}'
    /bin/sleep 0.4
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"thread-1","result":"Checkpointed once and handed off","usage":{"input_tokens":12,"output_tokens":5}}'
    exit 0;;
esac`

/**
 * A long durable Run followed by one growing Harness message. The response
 * then stays active long enough for the Run clock to advance independently.
 */
const LONG_STREAMING_CLAUDE_FAKE = `case "$1" in
  --version) echo "2.1.220 (Claude Code)"; exit 0;;
  -p) echo '{"type":"system","subtype":"init"}'; /bin/sleep 30;;
  --print)
    echo '{"type":"system","subtype":"init","session_id":"thread-1","model":"claude-opus-5"}'
    i=0
    while [ $i -lt 120 ]; do
      if [ $i -eq 0 ]; then
        printf '%s\n' '{"type":"assistant","message":{"model":"claude-opus-5","id":"history_0","type":"message","role":"assistant","content":[{"type":"text","text":"## Durable history 0\\n\\n    const stable = true\\n\\n| State | Value |\\n| --- | --- |\\n| durable | unchanged |\\n\\n[documentation](https://example.com)"}]},"session_id":"thread-1"}'
      else
        echo '{"type":"assistant","message":{"model":"claude-opus-5","id":"history_'$i'","type":"message","role":"assistant","content":[{"type":"text","text":"Durable history '$i'"}]},"session_id":"thread-1"}'
      fi
      i=$((i+1))
    done
    /bin/sleep 2
    echo '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_live"}}}'
    i=0
    while [ $i -lt 60 ]; do
      echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":" chunk-'$i'"}}}'
      i=$((i+1))
      /bin/sleep 0.005
    done
    /bin/sleep 2
    echo '{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_live","type":"message","role":"assistant","content":[{"type":"text","text":"complete latest response"}]},"session_id":"thread-1"}'
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"thread-1","result":"complete latest response","usage":{"input_tokens":12,"output_tokens":60}}'
    exit 0;;
esac`

test('one streamed Harness message stays one DOM message through durable checkpoints', async () => {
  await installFakeHarness('claude', CHECKPOINTING_CLAUDE_FAKE)
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)

    await page.evaluate(() => {
      const partial = 'Checkpointed once'
      const complete = 'Checkpointed once and handed off'
      const probe = {
        maximumCopies: 0,
        sawPartial: false,
        sawComplete: false,
        disappeared: false,
        replaced: false,
        message: null as HTMLParagraphElement | null
      }
      const inspect = (): void => {
        const copies = Array.from(document.querySelectorAll('p')).filter(
          (element): element is HTMLParagraphElement =>
            element.textContent === partial || element.textContent === complete
        )
        probe.maximumCopies = Math.max(probe.maximumCopies, copies.length)
        probe.sawPartial ||= copies.some((element) => element.textContent === partial)
        probe.sawComplete ||= copies.some((element) => element.textContent === complete)
        if (probe.message !== null && copies.length === 0) probe.disappeared = true
        if (copies[0] !== undefined) {
          if (probe.message === null) probe.message = copies[0]
          else if (probe.message !== copies[0]) probe.replaced = true
        }
      }
      new MutationObserver(inspect).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true
      })
      Object.assign(window, { streamMessageProbe: probe })
    })

    await startSession(page, 'Checkpoint this answer')
    const history = page.getByRole('log', { name: 'Conversation history' })
    await expect(
      history.getByText('Checkpointed once and handed off', { exact: true })
    ).toBeVisible()
    await expect(history.getByRole('region', { name: 'Run outcome' })).toHaveCount(0)
    await expect(history.getByRole('region', { name: /edited file/ })).toHaveCount(0)

    const observed = await page.evaluate(() => {
      const probe = (window as unknown as { streamMessageProbe: Record<string, unknown> })
        .streamMessageProbe
      return {
        maximumCopies: probe['maximumCopies'],
        sawPartial: probe['sawPartial'],
        sawComplete: probe['sawComplete'],
        disappeared: probe['disappeared'],
        replaced: probe['replaced']
      }
    })
    expect(observed).toEqual({
      maximumCopies: 1,
      sawPartial: true,
      sawComplete: true,
      disappeared: false,
      replaced: false
    })
  } finally {
    await app.close()
  }
})

test('a long Conversation bounds render work while a reply streams', async () => {
  await installFakeHarness('claude', LONG_STREAMING_CLAUDE_FAKE)
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents
      if (contents === undefined) throw new Error('renderer window was not available')
      contents.debugger.attach('1.3')
      await contents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        media: 'screen',
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
      })
    })
    await completeOnboarding(page)
    await startSession(page, 'Measure a long streamed reply')

    const history = page.getByRole('log', { name: 'Conversation history' })
    await expect(history.getByText('Durable history 119', { exact: true })).toBeVisible()
    await expect(history.locator('pre').filter({ hasText: 'const stable = true' })).toBeVisible()
    await expect(history.getByRole('table')).toContainText('durable')
    const renderedLink = history.getByText('documentation', { exact: true })
    await expect(renderedLink).toHaveAttribute('title', 'https://example.com')
    expect(await renderedLink.evaluate((element) => element.tagName)).toBe('SPAN')
    await page.evaluate(() => {
      const probe = {
        frame: 0,
        durableRenders: 0,
        liveRendersByFrame: new Map<number, number>()
      }
      const tick = (): void => {
        probe.frame += 1
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      ;(
        window as typeof window & {
          __argosTestConversationRenderProbe?: (text: string) => void
        }
      ).__argosTestConversationRenderProbe = (text) => {
        if (text.startsWith('Durable history')) probe.durableRenders += 1
        if (text.includes('chunk-')) {
          probe.liveRendersByFrame.set(
            probe.frame,
            (probe.liveRendersByFrame.get(probe.frame) ?? 0) + 1
          )
        }
      }
      Object.assign(window, { longConversationRenderProbe: probe })

      const durableText = Array.from(document.querySelectorAll('p')).find(
        (element) => element.textContent === 'Durable history 0'
      )
      if (durableText === undefined) throw new Error('durable markdown was not rendered')
      const range = document.createRange()
      range.selectNodeContents(durableText)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })

    await expect(history.getByText(/chunk-59/, { exact: false })).toBeVisible()
    const reducedMotion = await page
      .getByRole('img', { name: 'Run in progress' })
      .evaluate(async (element) => {
        if (!(element instanceof HTMLCanvasElement)) throw new Error('The orb is not a canvas')
        const firstFrame = element.toDataURL()
        await new Promise((resolve) => window.setTimeout(resolve, 100))
        return {
          matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
          painted: element
            .getContext('2d')
            ?.getImageData(0, 0, element.width, element.height)
            .data.some((channel) => channel !== 0),
          static: firstFrame === element.toDataURL()
        }
      })
    expect(reducedMotion).toEqual({ matches: true, painted: true, static: true })
    await expect.poll(() => page.getByText(/^Running · /).textContent()).toMatch(/\d+s$/)
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Durable history 0')

    const renderWork = await page.evaluate(() => {
      const probe = (
        window as typeof window & {
          longConversationRenderProbe: {
            durableRenders: number
            liveRendersByFrame: Map<number, number>
          }
        }
      ).longConversationRenderProbe
      return {
        durableRenders: probe.durableRenders,
        maximumLiveRendersPerFrame: Math.max(0, ...probe.liveRendersByFrame.values())
      }
    })
    expect(renderWork).toEqual({ durableRenders: 0, maximumLiveRendersPerFrame: 1 })
    await expect(history.getByText('complete latest response', { exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a streamed reply never moves a reader who scrolled away, and offers the way back', async () => {
  await installFakeHarness('claude', CHATTY_CLAUDE_FAKE)
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)
    await startSession(page, 'Say a lot')

    const transcript = page.getByRole('log', { name: 'Conversation history' })
    await expect(transcript.getByText(/Paragraph 0 of the answer/)).toBeVisible()

    // Only once the reply has outgrown the viewport is there anywhere to
    // scroll away to. Until then the reader is at the live edge by definition.
    const viewport = page.getByRole('region', { name: 'Conversation' })
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollHeight - element.clientHeight))
      .toBeGreaterThan(200)

    // The reader goes back to read something, while the reply keeps arriving.
    // A wheel, not a scripted scrollTop: releasing the live edge is something
    // the reader does, and the scroller is right to ignore anything else.
    const top = (): Promise<number> => viewport.evaluate((element) => element.scrollTop)
    const height = (): Promise<number> => viewport.evaluate((element) => element.scrollHeight)
    await viewport.hover()
    await page.mouse.wheel(0, -1_000)
    await expect.poll(top).toBeLessThan(200)
    const held = await top()
    const heightThen = await height()

    // Waiting on the reply, not on the clock: the transcript grows by a
    // screenful and the reader stays exactly where they were.
    await expect.poll(height).toBeGreaterThan(heightThen + 200)
    expect(await top(), 'the transcript moved while the reader was reading').toBe(held)

    // And there is a way back to the live edge, which resumes following.
    const jump = page.getByRole('button', { name: 'Jump to the latest message' })
    await expect(jump).toBeVisible()
    await jump.click()
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(held)
  } finally {
    await app.close()
  }
})

test('the sidebar groups by Project, and status is a dot that never moves a row', async () => {
  await installFakeHarness('claude', BUSY_CLAUDE_FAKE)
  // A second Project, because the sidebar spans repositories: every Project
  // is its own group with its Sessions nested underneath.
  await git('git', ['init', '--quiet'], { cwd: sandbox.plainDir })
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

    // Each Session sits under its own Project, with its Sessions nested.
    await expect(homeGroup.getByText('Offline recipe planner')).toBeVisible()
    await expect(otherGroup.getByText('Elsewhere entirely')).toBeVisible()

    // Sending starts the first Run, so a Session carries a running dot from
    // the moment it exists — read from its Conversation rather than from
    // anything stored beside it — and the row stays exactly where it was.
    await expect(otherGroup.getByRole('img', { name: 'Running' })).toBeVisible()
    await expect(homeGroup.getByRole('img', { name: 'Running' })).toBeVisible()
    await expect(otherGroup.getByText('Elsewhere entirely')).toBeVisible()
    await expect(homeGroup.getByText('Offline recipe planner')).toBeVisible()

    // The cascading navigator keeps each running Session legible under its
    // Project with the inbox collapsed.
    await page.getByRole('button', { name: 'Collapse inbox to rail' }).click()
    const rail = page.getByRole('navigation', { name: 'Session inbox (compact)' })
    await rail.getByRole('button', { name: 'Browse Projects and Sessions' }).click()
    const projects = page.getByRole('dialog', { name: 'Projects' })
    const homeName = basename(await realpath(sandbox.projectDir))
    await projects.getByRole('button', { name: `${homeName}, 1 Session` }).click()
    await expect(
      page
        .getByRole('dialog', { name: `${homeName} Sessions` })
        .getByRole('button', { name: 'Offline recipe planner, running' })
    ).toBeVisible()
    const otherName = basename(sandbox.plainDir)
    await projects.getByRole('button', { name: `${otherName}, 1 Session` }).click()
    await expect(
      page
        .getByRole('dialog', { name: `${otherName} Sessions` })
        .getByRole('button', { name: 'Elsewhere entirely, running' })
    ).toBeVisible()
  } finally {
    await app.close()
  }
})

/** A Harness that edits one file and says so, the way Claude Code reports it. */
const EDITING_CLAUDE_FAKE = `case "$1" in
  --version) echo "2.1.220 (Claude Code)"; exit 0;;
  -p) echo '{"type":"system","subtype":"init"}'; /bin/sleep 30;;
  --print)
    echo '{"type":"system","subtype":"init","session_id":"thread-1","model":"claude-opus-5"}'
    echo '{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_0","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_0","name":"Read","input":{"file_path":"greeting.ts"}}]},"session_id":"thread-1"}'
    echo '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"ok"}]},"session_id":"thread-1","tool_use_result":{"filePath":"greeting.ts","oldString":"hello","newString":"goodbye","structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-export const greeting = \\"hello\\"","+export const greeting = \\"goodbye\\""]}]}}'
    echo '{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_2","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"Bash","input":{"command":"echo ok"}}]},"session_id":"thread-1"}'
    echo '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_2","type":"tool_result","content":"ok","is_error":false}]},"session_id":"thread-1","tool_use_result":{"stdout":"ok","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}}'
    echo '{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"Done."}]},"session_id":"thread-1"}'
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"thread-1","result":"Done.","usage":{"input_tokens":12,"output_tokens":2}}'
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

    // Sending started the Run, and the title bar adds up what it changed
    // live. The panel itself stays away until the numbers are clicked.
    const chip = page.getByRole('button', { name: /Files this Session changed/ })
    const panel = page.getByRole('complementary', { name: 'Files this Session changed' })
    await expect(panel).toHaveCount(0)
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

    // The Conversation marks the Run with a quiet divider. A successful Run
    // only adds an outcome surface when it changed files.
    const history = page.getByRole('log', { name: 'Conversation history' })
    await expect(history.getByText(/^Run · /).last()).toBeVisible()
    await expect(history.getByRole('region', { name: 'Run outcome' })).toHaveCount(0)
    const edits = history.getByRole('region', { name: '1 edited file' })
    const editedFile = edits.getByRole('button', { name: /Edited greeting\.ts/ })
    await expect(editedFile).toContainText('+1')
    await expect(editedFile).toContainText('−1')

    // Hovering the changed file previews its recorded diff without opening
    // the full panel.
    await editedFile.hover()
    await expect(page.getByText('+export const greeting = "goodbye"').last()).toBeVisible()
    await expect(panel).toHaveCount(0)

    // Review remains the explicit way into the complete Files panel.
    await edits.getByRole('button', { name: 'Review' }).click()
    await expect(panel.getByText('+export const greeting = "goodbye"')).toBeVisible()

    // And with that Run finished, the Session is quiet again: at rest a row
    // in the inbox is only its title.
    await expect(
      page.getByRole('navigation', { name: 'Session inbox' }).getByRole('img', { name: 'Running' })
    ).toHaveCount(0)
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
  const gitc = (args: string[]): Promise<unknown> =>
    git('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...args], {
      cwd: sandbox.projectDir
    })
  // A commit and a named branch, so the branch chip has something
  // deterministic to state, and a real worktree beside the working copy.
  await writeFile(join(sandbox.projectDir, 'app.ts'), 'export const app = true\n')
  await writeFile(join(sandbox.projectDir, '.gitignore'), '.env*\n')
  await gitc(['add', '-A'])
  await gitc(['commit', '--quiet', '-m', 'init'])
  await gitc(['checkout', '--quiet', '-b', 'trunk'])
  await writeFile(join(sandbox.projectDir, '.env.local'), 'checkout-only\n')
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
    await page.getByRole('radio', { name: 'Isolated' }).click()
    // The base settles onto the branch the working copy is on.
    await expect(
      page
        .getByRole('list', { name: 'Base branch' })
        .getByRole('button', { name: 'trunk', exact: true })
    ).toHaveAttribute('aria-pressed', 'true')
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
    const { stdout: worktrees } = await git('git', ['worktree', 'list', '--porcelain'], {
      cwd: sandbox.projectDir
    })
    const isolatedPath = worktrees
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
      .find((path) => path !== sandbox.projectDir)
    expect(isolatedPath).toBeDefined()
    await expect(readFile(join(isolatedPath ?? '', '.env.local'), 'utf8')).resolves.toBe(
      'checkout-only\n'
    )
    const sessionRecords = (await readdir(sandbox.appDataDir, { recursive: true })).filter(
      (path) => basename(path) === 'session.json'
    )
    const records = await Promise.all(
      sessionRecords.map((path) => readFile(join(sandbox.appDataDir, path), 'utf8'))
    )
    const stored = records.find((record) => record.includes('fix-the-location-crash'))
    expect(stored).toBeTruthy()
    const storedSession = JSON.parse(stored ?? '{}') as {
      worktreeBootstrap?: { copied?: string[] }
    }
    expect(storedSession.worktreeBootstrap?.copied).toEqual(['.env.local'])
    expect(stored).not.toContain('checkout-only')
    // The person's own copy never moved.
    const { stdout } = await git('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: sandbox.projectDir
    })
    expect(stdout.trim()).toBe('trunk')
  } finally {
    await app.close()
  }
})

test('a partial Checkout bootstrap keeps the Worktree and offers accessible recovery', async () => {
  const gitc = (args: string[]): Promise<unknown> =>
    git('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...args], {
      cwd: sandbox.projectDir
    })
  await writeFile(join(sandbox.projectDir, '.gitignore'), '.env*\n')
  await writeFile(join(sandbox.projectDir, 'app.ts'), 'export const app = true\n')
  await gitc(['add', '-A'])
  await gitc(['commit', '--quiet', '-m', 'init'])
  await writeFile(join(sandbox.projectDir, '.env.local'), 'copied\n')
  await writeFile(join(sandbox.projectDir, '.env.private'), 'private\n')
  await chmod(join(sandbox.projectDir, '.env.private'), 0o000)

  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)
    await page.getByRole('button', { name: 'New Session', exact: true }).click()
    const composer = page.getByRole('form', { name: 'New chat' })
    await composer.getByLabel('Message').fill('Keep the partial Checkout')
    await composer.getByRole('button', { name: 'Checkout' }).click()
    await page.getByRole('radio', { name: 'Isolated' }).click()
    await page.keyboard.press('Escape')
    await composer.getByRole('button', { name: 'Send' }).click()

    const recovery = composer.getByRole('region', {
      name: 'Some local files could not be copied'
    })
    await expect(recovery.getByText('.env.local')).toBeVisible()
    await expect(recovery.getByText(/\.env\.private.*permission denied/)).toBeVisible()
    await expect(recovery.getByRole('button', { name: 'Retry copying' })).toBeVisible()
    await recovery.getByRole('button', { name: 'Continue without files' }).click()
    await expect(page.getByRole('heading', { name: 'Keep the partial Checkout' })).toBeVisible()

    const { stdout } = await git('git', ['worktree', 'list', '--porcelain'], {
      cwd: sandbox.projectDir
    })
    expect(stdout.match(/^worktree /gm)).toHaveLength(2)
  } finally {
    await app.close()
    await chmod(join(sandbox.projectDir, '.env.private'), 0o600)
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
          printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"data":[{"id":"gpt-5.5","displayName":"GPT-5.5","description":"The default","hidden":false,"isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"medium"}],"defaultReasoningEffort":"medium"},{"id":"gpt-5.6-sol","displayName":"GPT-5.6-Sol","description":"The selected model","hidden":false,"isDefault":false,"supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}],"defaultReasoningEffort":"low"}],"nextCursor":null}}'
          ;;
      esac
    done
    exit 0;;
esac
exit 1`

/** A Codex app-server that completes two successive Runs in one Conversation. */
const TWO_TURN_CODEX = `case "$1" in
  --version) echo "codex-cli 0.146.0"; exit 0;;
  login) exit 0;;
  app-server)
    while IFS= read -r line; do
      case "$line" in
        *'"initialize"'*) printf '{"jsonrpc":"2.0","id":1,"result":{}}\n';;
        *'"model/list"'*)
          printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"data":[{"id":"gpt-5.6-sol","displayName":"GPT-5.6-Sol","description":"The default","hidden":false,"isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"low"}],"defaultReasoningEffort":"low"}],"nextCursor":null}}'
          ;;
        *'"thread/start"'*)
          printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"thread-1"}}}'
          ;;
        *'"thread/resume"'*)
          sleep 1
          printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"thread-1"}}}'
          ;;
        *'"turn/start"'*)
          printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"turn":{"id":"turn-1"}}}'
          case "$line" in
            *'Second request'*) answer='Second answer';;
            *) answer='First answer';;
          esac
          sleep 0.2
          printf '{"jsonrpc":"2.0","method":"item/completed","params":{"item":{"type":"agentMessage","id":"message","text":"%s"}}}\n' "$answer"
          printf '%s\n' '{"jsonrpc":"2.0","method":"turn/completed","params":{}}'
          ;;
      esac
    done
    exit 0;;
esac
exit 1`

test('Codex completes a second message without losing Core', async () => {
  await installFakeHarness('codex', TWO_TURN_CODEX)
  await installFakeHarness('claude', 'exit 1')
  const app = await launchShell()
  let stderr = ''
  app.process().stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)
    await startSession(page, 'First request')

    const history = page.getByRole('log', { name: 'Conversation history' })
    await expect(history.getByText('First answer', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'First request', exact: true })).toBeVisible()
    await page.getByLabel('Your message').fill('Second request')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(history.getByText('Second request', { exact: true })).toBeVisible({ timeout: 250 })
    await expect(page.getByLabel('Your message')).toHaveValue('', { timeout: 250 })
    await expect(history.getByRole('status', { name: 'Sending message' })).toBeVisible()
    await page.getByLabel('Your message').fill('Third thought')

    await expect(history.getByText(/Second answer|Run needs attention/).last()).toBeVisible()
    expect(stderr, `Main stderr:\n${stderr}`).not.toContain('Core stopped unexpectedly')
    await expect(history.getByText('Second answer', { exact: true })).toBeVisible()
    await expect(history.getByText('Second request', { exact: true })).toHaveCount(1)
    await expect(history.getByRole('status', { name: 'Sending message' })).toHaveCount(0)
    await expect(page.getByLabel('Your message')).toHaveValue('Third thought')
    await expect(history.getByText('Run needs attention')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('one picker chooses the model, and with it the Harness that runs it', async () => {
  await installFakeHarness('codex', MODEL_LISTING_CODEX)
  const app = await launchShell()
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)

    // On the launch screen, before anything is sent: sending starts the first
    // Run, so this is where a Run is configured. The Conversation carries the
    // same chips for every message after it.
    await expect(page.getByRole('form', { name: 'New chat' })).toBeVisible()

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

    // Whose model it is, without reading the group heading again.
    await expect(picker.locator('svg[viewBox="0 0 256 260"]')).toBeVisible()

    // The thinking levels are that model's own, as Codex reported them.
    await picker.click()
    // And the popover says what came with the choice, because the Harness
    // changed — the surface below the composer stays empty, as the mock has it.
    await expect(page.getByText('runs Skills as instruction text', { exact: false })).toBeVisible()
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
    await page.getByRole('radio', { name: /Full access/ }).click()
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

    // And what was chosen here is what the Run is asked for: sending starts
    // it, and the Run boundary states the model and the mode it ran under.
    await page
      .getByRole('form', { name: 'New chat' })
      .getByLabel('Message')
      .fill('Choose the thinking')
    await page.getByRole('button', { name: 'Send' }).click()
    const boundary = page
      .getByRole('log', { name: 'Conversation history' })
      .getByText(/^Run · /)
      .last()
    await expect(boundary).toContainText('gpt-5.6-sol')
    await expect(boundary).toContainText('Full access')
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toContainText(
      'GPT-5.6-Sol'
    )
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
  await mkdir(join(sandbox.projectDir, 'src', 'deep'), { recursive: true })

  const app = await launchShell()
  try {
    const page = await app.firstWindow()

    // The git requirement is said before any folder is chosen, not discovered
    // on refusal: git is the only undo for the agent's edits.
    await page.getByRole('heading', { name: 'Add your first Project' }).waitFor()
    await expect(page.getByText('Must be a git repository', { exact: false })).toBeVisible()

    // A folder under git becomes a Project. The sandbox reaches it through a
    // symlink, so git names a root the person did not pick, and the app says so
    // before storing anything.
    await page.getByRole('button', { name: 'Choose a folder…' }).click()
    const symlinked = page.getByRole('alert')
    await expect(
      symlinked.getByText(await realpath(sandbox.projectDir), { exact: true })
    ).toBeVisible()
    await symlinked.getByRole('button', { name: 'Add this Project' }).click()
    await expect(page.getByText(basename(sandbox.projectDir), { exact: true })).toBeVisible()

    // A folder that is not under git is refused, naming the exact path, and
    // nothing is written until the offer is accepted.
    await page.getByRole('button', { name: 'Choose a folder…' }).click()
    const refusal = page.getByRole('alert')
    await expect(refusal.getByText(sandbox.plainDir)).toBeVisible()
    await expect(refusal.getByText('git init')).toBeVisible()
    expect(await readdir(sandbox.plainDir)).not.toContain('.git')

    // Accepting it runs the one Git mutation the app performs, and the folder
    // becomes a Project.
    await refusal.getByRole('button', { name: 'Set up git here' }).click()
    await expect(page.getByText(basename(sandbox.plainDir), { exact: true })).toBeVisible()
    expect(await readdir(sandbox.plainDir)).toContain('.git')

    // Pointing inside a Project adds the Project, but says so first: git
    // resolves a root the person did not pick, and adding it silently would
    // surprise them.
    await page.getByRole('button', { name: 'Choose a folder…' }).click()
    const confirmation = page.getByRole('alert')
    await expect(
      confirmation.getByText(join(sandbox.projectDir, 'src', 'deep'), { exact: true })
    ).toBeVisible()
    // Named exactly, because the root git resolves is the identity being added.
    await expect(
      confirmation.getByText(await realpath(sandbox.projectDir), { exact: true })
    ).toBeVisible()
    await confirmation.getByRole('button', { name: 'Add this Project' }).click()

    // Onboarding ends with the latest addition; both Projects made it in, and
    // the same root twice is still one Project.
    await page.getByRole('status').getByRole('button', { name: 'Continue', exact: true }).click()
    const inbox = page.getByRole('navigation', { name: 'Session inbox' })
    await expect(inbox.getByText(basename(sandbox.projectDir), { exact: true })).toHaveCount(1)
    await expect(inbox.getByText(basename(sandbox.plainDir), { exact: true })).toHaveCount(1)

    // Two Projects and no history: nothing can say which repository is about
    // to be edited, so the headline is a required picker and nothing can be
    // sent until it is answered.
    const composer = page.getByRole('form', { name: 'New chat' })
    await expect(composer.getByRole('button', { name: 'Project' })).toContainText(
      'one of your Projects'
    )
    await composer.getByLabel('Message').fill('Anything at all')
    await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
    await composer.getByRole('button', { name: 'Project' }).click()
    await page.getByRole('menuitem', { name: basename(sandbox.plainDir) }).click()
    await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()

    // Removing a Project asks first — one menu click must not silently change
    // what the inbox offers — then forgets it and leaves the directory alone.
    const plainGroup = inbox.getByRole('region', { name: basename(sandbox.plainDir) })
    await plainGroup.getByRole('button', { name: /^More for/ }).click()
    await page.getByRole('menuitem', { name: 'Remove Project…' }).click()
    const removeDialog = page.getByRole('dialog', { name: /Remove “/ })
    await expect(removeDialog).toContainText('Nothing on disk is touched')
    await removeDialog.getByRole('button', { name: 'Remove Project' }).click()
    await expect(inbox.getByText(basename(sandbox.plainDir), { exact: true })).toHaveCount(0)
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

const LONG_RUNNING_CLAUDE_FAKE = `case "$1" in
  --version) echo "2.1.220 (Claude Code)"; exit 0;;
esac
echo '{"type":"system","subtype":"init"}'
trap 'exit 0' TERM INT
while :; do /bin/sleep 1; done`

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
    const notice = page.getByRole('note', { name: 'Project Skills' })
    await expect(notice.getByText('deploy-to-prod', { exact: true })).toBeVisible()
    await expect(notice.getByText('Ships it')).toBeVisible()

    await notice.getByRole('button', { name: 'Trust this Project’s Skills' }).click()
    await page.getByLabel('Your message').fill('/')
    await expect(skills.getByRole('button', { name: /deploy-to-prod/ })).toBeVisible()
    await page.getByLabel('Your message').fill('')

    // Trust is bound to all nested content. A later catalog read withdraws it
    // and names the Skill that changed before asking again.
    await writeFile(join(own, 'template.md'), 'new instructions')
    await page.reload()
    await page.getByRole('button', { name: 'Offline receipts', exact: true }).click()
    await expect(notice.getByText('Changes since you trusted them')).toBeVisible()
    await expect(notice.getByText('Changed: deploy-to-prod (claude)')).toBeVisible()
    await notice.getByRole('button', { name: 'Trust this Project’s Skills' }).click()

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
    await page.getByRole('heading', { name: 'No Harness can run a Session yet' }).waitFor()

    // Not a bare refusal: one row per Harness, each with its own problem and
    // the one command that repairs it, copyable rather than run.
    const harnesses = page.getByRole('list', { name: 'Harnesses' })
    await expect(harnesses.getByRole('listitem')).toHaveCount(2)
    await expect(harnesses.getByText('Not installed', { exact: true })).toHaveCount(2)
    await expect(
      harnesses.getByText('claude command was not found', { exact: false })
    ).toBeVisible()
    await expect(harnesses.getByText('codex command was not found', { exact: false })).toBeVisible()
    await expect(harnesses.getByRole('button', { name: /^Copy command:/ })).toHaveCount(2)
    // And onboarding is not reachable behind it.
    await expect(page.getByRole('heading', { name: 'Add your first Project' })).toHaveCount(0)

    // Repaired in the person's own terminal, and the gate notices by itself:
    // no click, no restart — the re-check runs every few seconds.
    await installFakeHarness('claude', READY_CLAUDE_FAKE)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()

    await page.getByRole('heading', { name: 'Add your first Project' }).waitFor()
  } finally {
    await app.close()
  }
})
