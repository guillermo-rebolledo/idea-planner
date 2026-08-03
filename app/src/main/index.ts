import { basename, delimiter, dirname, join } from 'node:path'
import { stat } from 'node:fs/promises'
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell,
  type IpcMainInvokeEvent
} from 'electron'
import { z } from 'zod'
import {
  CONTRACT_VERSION,
  CoreError,
  IPC_CHANNELS,
  sessionSummarySchema,
  startSessionInputSchema,
  startSessionResultSchema,
  mailboxQuerySchema,
  mailboxSnapshotSchema,
  renameSessionInputSchema,
  setSessionArchivedInputSchema,
  setSessionPinnedInputSchema,
  themePreferenceSchema,
  listSkillsInputSchema,
  modelCatalogSchema,
  skillCatalogSchema,
  trustProjectSkillsInputSchema,
  type SkillCatalog,
  resolveApprovalInputSchema,
  revokeStandingApprovalInputSchema,
  runSnapshotSchema,
  standingApprovalSchema,
  startRunInputSchema,
  stopRunInputSchema,
  branchListSchema,
  checkoutDirectory,
  checkoutFactsSchema,
  isolatedBranchName,
  startSessionRequestSchema,
  editorCatalogSchema,
  openInEditorInputSchema,
  conversationSnapshotSchema,
  developSessionInputSchema,
  SKILL_ATTRIBUTION,
  projectViewSchema,
  type BootState,
  type ChooseProjectResult,
  type ThemeState
} from '@shared/contract'
import { WINDOW_BACKGROUND } from '@shared/theme'
import {
  chooseExecutableResultSchema,
  harnessIdSchema,
  type HarnessId,
  readinessSnapshotSchema,
  refreshReadinessInputSchema
} from '@shared/readiness'
import { PRODUCT_NAME, stateDirectory } from './identity'
import { discoverSkills } from './skills'
import { CoreClient } from './core-client'
import {
  createWorktree,
  currentBranch,
  initRepository,
  listBranches,
  resolveProjectRoot
} from './git'
import { detectEditors, openInEditor } from './editors'
import { discoverModels } from './models'
import { HARNESS_SPECS, readinessLinkHosts } from './readiness'
import { ReadinessService } from './readiness-service'
import { SettingsStore } from './settings'
import { RunProcessBroker } from './run-process-broker'
import { RunService } from './run-service'

/**
 * Thin privileged Main process: window lifecycle, native dialogs and theme,
 * IPC sender validation, and Core supervision. Product behavior lives in the
 * Core utility process; presentation lives in the sandboxed Renderer.
 */

// Test-only seams, ignored in packaged builds: substitute application support
// so test runs are hermetic, and answer the native folder picker without a
// real dialog.
const testAppData = process.env['APP_TEST_APP_DATA']
// Folders the Project picker answers with, in order; the last one repeats.
const testChooseProjectDirs = (process.env['APP_TEST_CHOOSE_PROJECT_DIRS'] ?? '')
  .split(delimiter)
  .filter((entry) => entry !== '')
let chosenProjectCount = 0
const testReadinessPath = process.env['APP_TEST_READINESS_PATH']
const testReadinessHome = process.env['APP_TEST_READINESS_HOME']
const testChooseExecutable = process.env['APP_TEST_CHOOSE_EXECUTABLE']
const devServerUrl = process.env['ELECTRON_RENDERER_URL']

// Who the app says it is, before anything reads it: the menu bar, the About
// panel and the window all take the name from here, and the state directory
// takes the identifier rather than the name so renaming the product later
// cannot orphan a person's history (ADR 0002).
app.setName(PRODUCT_NAME)
app.setAboutPanelOptions({ applicationName: PRODUCT_NAME, applicationVersion: app.getVersion() })
// A test run substitutes the application-support root rather than the state
// directory itself, so it is never the app installed on this machine that a
// suite reads or writes, and the derivation is exercised rather than bypassed.
const applicationSupport = testAppData && !app.isPackaged ? testAppData : app.getPath('appData')
app.setPath('userData', stateDirectory(applicationSupport))

app.enableSandbox()

let mainWindow: BrowserWindow | null = null
let settings: SettingsStore
let readiness: ReadinessService
let runService: RunService

const coreClient = new CoreClient(
  () => app.getPath('userData'),
  () => {
    // Core respawned after a crash. It reads its own durable state from the
    // app-owned store, so nothing has to be handed back to it; the Runs it
    // was supervising are no longer supervised and are stopped.
    void runService.stopAll('core-crash').catch(() => undefined)
  }
)

function themeState(): ThemeState {
  return {
    preference: settings.get().themePreference,
    resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (!mainWindow || !frame || frame !== mainWindow.webContents.mainFrame) return false
  const url = new URL(frame.url)
  if (url.protocol === 'file:') return true
  return Boolean(devServerUrl && !app.isPackaged && frame.url.startsWith(devServerUrl))
}

function handleInvoke<Args, Result>(
  channel: string,
  argsSchema: z.ZodType<Args>,
  handler: (args: Args) => Promise<Result> | Result
): void {
  ipcMain.handle(channel, async (event, rawArgs: unknown) => {
    if (!isTrustedSender(event)) {
      throw new Error('Rejected IPC from an untrusted sender')
    }
    const parsed = argsSchema.safeParse(rawArgs)
    if (!parsed.success) {
      throw new Error(`Rejected malformed IPC payload on ${channel}`)
    }
    try {
      return await handler(parsed.data)
    } catch (error) {
      if (error instanceof CoreError) {
        throw new Error(`${error.code}: ${error.message}`, { cause: error })
      }
      throw error
    }
  })
}

async function chooseProjectDirectory(): Promise<string | undefined> {
  if (testChooseProjectDirs.length > 0 && !app.isPackaged) {
    // Successive picks within one test run; the last entry repeats.
    const index = Math.min(chosenProjectCount++, testChooseProjectDirs.length - 1)
    return testChooseProjectDirs[index]
  }
  if (!mainWindow) return undefined
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Add a Project',
    message: 'The folder must be under git. Nothing inside it is read or changed by adding it.',
    buttonLabel: 'Add this Project',
    properties: ['openDirectory']
  })
  return result.canceled ? undefined : result.filePaths[0]
}

/**
 * Main probes with git and hands Core the root git resolved; Core decides
 * identity, duplication, and persistence (ADR 0005). Picking any folder
 * inside a Project therefore adds that Project, once.
 */
async function addProject(path: string): Promise<ChooseProjectResult> {
  const resolution = await resolveProjectRoot(path)
  if (resolution.status !== 'resolved') {
    return { status: 'refused', reason: resolution.status, path }
  }
  // Compared against the path the person actually chose, not its real path: if
  // git names the Project somewhere they did not point — through a symlink or
  // from a subdirectory — that is precisely what they have not seen yet.
  if (resolution.root !== path) {
    return { status: 'confirm-root', chosen: path, root: resolution.root }
  }
  return acceptProject(resolution.root)
}

/**
 * Persists a root the person has seen and asked for. It is probed again rather
 * than trusted: this is reachable from the Renderer, and ADR 0005 says a folder
 * becomes a Project only if git says so.
 */
async function acceptProject(root: string): Promise<ChooseProjectResult> {
  const resolution = await resolveProjectRoot(root)
  if (resolution.status !== 'resolved' || resolution.root !== root) {
    return {
      status: 'refused',
      reason: resolution.status === 'git-unavailable' ? 'git-unavailable' : 'not-a-repository',
      path: root
    }
  }
  const project = projectViewSchema.parse(await coreClient.send({ type: 'project/add', root }))
  return { status: 'added', project }
}

function registerIpc(): void {
  handleInvoke(IPC_CHANNELS.bootState, z.undefined(), (): BootState => {
    return {
      contractVersion: CONTRACT_VERSION,
      appVersion: app.getVersion(),
      theme: themeState()
    }
  })

  handleInvoke(
    IPC_CHANNELS.chooseProject,
    z.undefined(),
    async (): Promise<ChooseProjectResult> => {
      const path = await chooseProjectDirectory()
      if (!path) return { status: 'cancelled' }
      return addProject(path)
    }
  )

  // A folder the person dropped onto the window: already named by them, so
  // no picker — but probed exactly like a picked one. A dropped file offers
  // the folder that holds it: the file names a place, and a Project is the
  // place, so git resolves the root from there like any subdirectory.
  handleInvoke(
    IPC_CHANNELS.offerProject,
    z.string().min(1),
    async (path): Promise<ChooseProjectResult> => {
      const offered = (await stat(path).catch(() => null))?.isDirectory() ? path : dirname(path)
      return addProject(offered)
    }
  )

  handleInvoke(IPC_CHANNELS.listProjects, z.undefined(), async () =>
    projectViewSchema.array().parse(await coreClient.send({ type: 'project/list' }))
  )

  // Forgetting a Project is app state only: nothing on disk is touched.
  handleInvoke(IPC_CHANNELS.removeProject, z.string().min(1), async (root) => {
    await coreClient.send({ type: 'project/remove', root })
  })

  // Skills are discovered on demand: they are installed and removed by the
  // person, in their own directories, without telling this app.
  handleInvoke(IPC_CHANNELS.listSkills, listSkillsInputSchema, async (input) =>
    skillCatalogSchema.parse(await skillsFor(input.projectRoot, input.harness))
  )

  handleInvoke(IPC_CHANNELS.trustProjectSkills, trustProjectSkillsInputSchema, async (input) => {
    const project = projectViewSchema.parse(
      await coreClient.send({
        type: 'project/trust-skills',
        root: input.root,
        trusted: input.trusted
      })
    )
    return skillCatalogSchema.parse(await skillsFor(project.root, input.harness))
  })

  handleInvoke(IPC_CHANNELS.listStandingApprovals, z.string().min(1), async (projectRoot) =>
    standingApprovalSchema
      .array()
      .parse(await coreClient.send({ type: 'approval/list', projectRoot }))
  )

  // Revoking is the only way a rule leaves the store. Granting is not exposed
  // here: a rule reaches the store by answering the request that proposed it,
  // never as a string the window composes for itself.
  handleInvoke(
    IPC_CHANNELS.revokeStandingApproval,
    revokeStandingApprovalInputSchema,
    async (input) => {
      await coreClient.send({ type: 'approval/revoke', input })
    }
  )

  // Reached only from the offer the person accepted for this exact folder.
  // `git init` is the one Git mutation the app performs.
  handleInvoke(
    IPC_CHANNELS.initializeProject,
    z.string().min(1),
    async (path): Promise<ChooseProjectResult> => {
      const initialized = await initRepository(path)
      if (initialized.status === 'git-unavailable') {
        return { status: 'refused', reason: 'git-unavailable', path }
      }
      // No root to confirm: git was just told to start a Project at the exact
      // folder the person named, so the root can only be that folder.
      const resolution = await resolveProjectRoot(path)
      if (resolution.status !== 'resolved') {
        return { status: 'refused', reason: resolution.status, path }
      }
      return acceptProject(resolution.root)
    }
  )

  // The person has seen the root git resolved and asked for it by name.
  handleInvoke(
    IPC_CHANNELS.confirmProject,
    z.string().min(1),
    async (root): Promise<ChooseProjectResult> => acceptProject(root)
  )

  handleInvoke(IPC_CHANNELS.startSession, startSessionRequestSchema, async (raw) => {
    // Parsed once more so the omitted-checkout default is applied here and
    // the command Core receives is the settled shape, not the caller's.
    const request = startSessionRequestSchema.parse(raw)
    // An isolated checkout is settled before the Session exists: the linked
    // worktree is created here, on a branch derived from the message, and
    // Core only ever stores a directory that is really there.
    let checkout = request.checkout
    if (checkout.kind === 'isolated') {
      const created = await createWorktree({
        projectRoot: request.projectRoot,
        worktreesDirectory: join(
          app.getPath('userData'),
          'worktrees',
          basename(request.projectRoot)
        ),
        branch: isolatedBranchName(request.message),
        baseBranch: checkout.baseBranch
      })
      if (created.status !== 'created') {
        throw new Error(`The isolated checkout could not be created: ${created.message}`)
      }
      checkout = { kind: 'worktree', path: created.path }
    }
    // Creating the Session and answering its message is one act, and the Run
    // service owns it: sending on the launch screen is a Session and its
    // first Run, not a Session that sits there unanswered.
    return startSessionResultSchema.parse(
      await runService.startSession({
        input: startSessionInputSchema.parse({ ...request, checkout }),
        run: request.run
      })
    )
  })

  handleInvoke(IPC_CHANNELS.listBranches, z.string().min(1), async (projectRoot) =>
    branchListSchema.parse(await listBranches(projectRoot))
  )

  handleInvoke(IPC_CHANNELS.listSessions, z.undefined(), async () =>
    z.array(sessionSummarySchema).parse(await coreClient.send({ type: 'session/list' }))
  )

  handleInvoke(IPC_CHANNELS.listDamagedSessions, z.undefined(), async () =>
    z.array(z.string()).parse(await coreClient.send({ type: 'session/list-damaged' }))
  )

  handleInvoke(IPC_CHANNELS.queryMailbox, mailboxQuerySchema, async (query) =>
    mailboxSnapshotSchema.parse(
      await coreClient.send({
        type: 'mailbox/query',
        query: { ...query, dormantAfterDays: settings.get().dormantAfterDays }
      })
    )
  )

  handleInvoke(IPC_CHANNELS.setSessionPinned, setSessionPinnedInputSchema, async (input) =>
    sessionSummarySchema.parse(
      await coreClient.send({
        type: 'session/set-pinned',
        sessionId: input.sessionId,
        pinned: input.pinned
      })
    )
  )

  handleInvoke(IPC_CHANNELS.setSessionArchived, setSessionArchivedInputSchema, async (input) =>
    sessionSummarySchema.parse(
      await coreClient.send({
        type: 'session/set-archived',
        sessionId: input.sessionId,
        archived: input.archived
      })
    )
  )

  handleInvoke(IPC_CHANNELS.renameSession, renameSessionInputSchema, async (input) =>
    sessionSummarySchema.parse(await coreClient.send({ type: 'session/rename', input }))
  )

  // Forgetting a Session is app state only: the Project it worked in keeps
  // every file, because that is where the work lives (ADR 0002).
  handleInvoke(IPC_CHANNELS.deleteSession, z.string().min(1), async (sessionId) => {
    await coreClient.send({ type: 'session/delete', sessionId })
  })

  handleInvoke(IPC_CHANNELS.setThemePreference, themePreferenceSchema, (preference) => {
    settings.update({ themePreference: preference })
    nativeTheme.themeSource = preference
    return themeState()
  })

  handleInvoke(IPC_CHANNELS.getReadiness, z.undefined(), async () =>
    readinessSnapshotSchema.parse(await readiness.get())
  )

  // Asked of the Harnesses that can actually run a Session, so a model that
  // cannot be reached is never offered (ticket 13). Codex answers for itself;
  // Claude Code enumerates nothing and offers what its help documents.
  handleInvoke(IPC_CHANNELS.listModels, z.undefined(), async () => {
    const snapshot = await readiness.get()
    return modelCatalogSchema.parse(
      await discoverModels(
        snapshot.harnesses
          .filter((entry) => entry.capabilities.developSession.available && entry.executablePath)
          .map((entry) => ({
            harness: entry.harness,
            displayName: HARNESS_SPECS[entry.harness].displayName,
            executablePath: entry.executablePath ?? ''
          }))
      )
    )
  })

  handleInvoke(IPC_CHANNELS.refreshReadiness, refreshReadinessInputSchema, async ({ harness }) =>
    readinessSnapshotSchema.parse(await readiness.refresh(harness))
  )

  handleInvoke(IPC_CHANNELS.chooseHarnessExecutable, harnessIdSchema, async (harness) => {
    let selected: string | undefined
    if (testChooseExecutable && !app.isPackaged) {
      selected = testChooseExecutable
    } else {
      if (!mainWindow) return { canceled: true as const }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: `Choose the ${HARNESS_SPECS[harness].displayName} executable`,
        message:
          'The selected program is verified and must still pass the Harness’s own readiness checks. Nothing is installed or changed.',
        buttonLabel: 'Use this executable',
        properties: ['openFile', 'showHiddenFiles']
      })
      selected = result.canceled ? undefined : result.filePaths[0]
    }
    if (!selected) return { canceled: true as const }
    return chooseExecutableResultSchema.parse({
      canceled: false,
      snapshot: await readiness.setExplicitExecutable(harness, selected)
    })
  })

  handleInvoke(IPC_CHANNELS.clearHarnessExecutable, harnessIdSchema, async (harness) =>
    readinessSnapshotSchema.parse(await readiness.clearExplicitExecutable(harness))
  )

  handleInvoke(IPC_CHANNELS.setLoginShellDiscovery, z.boolean(), async (consent) =>
    readinessSnapshotSchema.parse(await readiness.setLoginShellDiscovery(consent))
  )

  // Only the fixed readiness-guidance and attribution hosts may leave the app.
  // Anything else is rejected, so the renderer cannot turn this into an open
  // redirect.
  const externalLinkHosts = new Set([
    ...readinessLinkHosts(),
    new URL(SKILL_ATTRIBUTION.website).hostname,
    new URL(SKILL_ATTRIBUTION.repository).hostname
  ])
  handleInvoke(IPC_CHANNELS.openExternalLink, z.string().url(), async (url) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !externalLinkHosts.has(parsed.hostname)) {
      throw new Error('Refused to open an unapproved external link')
    }
    await shell.openExternal(parsed.toString())
  })

  handleInvoke(IPC_CHANNELS.startRun, startRunInputSchema, (input) => runService.start(input))
  handleInvoke(IPC_CHANNELS.listRuns, z.string().min(1), async (sessionId) =>
    runSnapshotSchema.array().parse(await runService.list(sessionId))
  )
  handleInvoke(IPC_CHANNELS.stopRun, stopRunInputSchema, ({ runId, sessionId }) =>
    runService.stop(runId, sessionId)
  )

  // The "where am I?" facts the title bar states. Observed on each ask: the
  // branch belongs to git, and the agent or a terminal can move it any time.
  handleInvoke(IPC_CHANNELS.getCheckoutFacts, z.string().min(1), async (sessionId) => {
    const session = sessionSummarySchema.parse(
      await coreClient.send({ type: 'session/get', sessionId })
    )
    const path = checkoutDirectory(session.projectRoot, session.checkout)
    return checkoutFactsSchema.parse({
      checkout: session.checkout,
      path,
      branch: await currentBranch(path)
    })
  })

  handleInvoke(IPC_CHANNELS.listEditors, z.undefined(), async () =>
    editorCatalogSchema.parse({
      editors: await detectEditors(),
      lastChoice: settings.get().lastEditor
    })
  )

  // Opens the Checkout — the agent's edits are already there — and remembers
  // the choice so the chip itself opens the right thing next time.
  handleInvoke(IPC_CHANNELS.openInEditor, openInEditorInputSchema, async (input) => {
    const session = sessionSummarySchema.parse(
      await coreClient.send({ type: 'session/get', sessionId: input.sessionId })
    )
    await openInEditor(input.editor, checkoutDirectory(session.projectRoot, session.checkout))
    settings.update({ lastEditor: input.editor })
    return editorCatalogSchema.parse({
      editors: await detectEditors(),
      lastChoice: input.editor
    })
  })

  handleInvoke(IPC_CHANNELS.getConversation, z.string().min(1), async (sessionId) =>
    conversationSnapshotSchema.parse(await runService.conversation(sessionId))
  )
  handleInvoke(IPC_CHANNELS.developSession, developSessionInputSchema, async (input) =>
    conversationSnapshotSchema.parse(await runService.develop(input))
  )
  handleInvoke(IPC_CHANNELS.resolveApproval, resolveApprovalInputSchema, async (input) =>
    conversationSnapshotSchema.parse(await runService.resolveApproval(input))
  )
}

/**
 * What is installed for one Project, with the Project's own Skills offered
 * only once it has been trusted.
 */
async function skillsFor(projectRoot: string, harness: HarnessId): Promise<SkillCatalog> {
  // The same home readiness probes, so a test that installs Skills where it
  // says it did finds them there.
  const projects = projectViewSchema.array().parse(await coreClient.send({ type: 'project/list' }))
  return discoverSkills({
    homeDirectory: harnessHomeDirectory(),
    projectRoot,
    harness,
    // A Project the app does not have is not one whose Skills are trusted:
    // `undefined !== null` would have quietly said otherwise.
    projectTrusted:
      projects.find((project) => project.root === projectRoot)?.skillsTrustedAt != null
  })
}

/** Where a Harness's own directories live, redirected only by a test run. */
function harnessHomeDirectory(): string {
  return !app.isPackaged && testReadinessHome !== undefined
    ? testReadinessHome
    : app.getPath('home')
}

function hardenSession(): void {
  const ses = session.defaultSession

  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))

  // The renderer needs no arbitrary network access: allow only local app
  // resources (and the Vite dev server during development).
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed =
      details.url.startsWith('file:') ||
      details.url.startsWith('devtools:') ||
      details.url.startsWith('chrome-extension:') ||
      (!app.isPackaged &&
        devServerUrl &&
        (details.url.startsWith(devServerUrl) || details.url.startsWith('ws:')))
    callback({ cancel: !allowed })
  })
}

function createWindow(): void {
  const window = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1180,
    height: 780,
    minWidth: 840,
    minHeight: 560,
    show: false,
    titleBarStyle: 'hiddenInset',
    // Centered in the 44px title bar every surface draws (h-11): the macOS
    // buttons are 12px tall, so (44 − 12) / 2 from the top.
    trafficLightPosition: { x: 18, y: 16 },
    backgroundColor: WINDOW_BACKGROUND[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'],
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false
    }
  })
  mainWindow = window

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  // ⌘Z never reaches the page: the application menu's Undo consumes it
  // first. This hook fires before the menu, so the Renderer is told and can
  // undo its own last action — while typing it does nothing, and the menu's
  // Undo goes on serving the text field.
  window.webContents.on('before-input-event', (_event, input) => {
    const undo =
      input.type === 'keyDown' &&
      input.key.toLowerCase() === 'z' &&
      (input.meta || input.control) &&
      !input.shift
    if (undo) window.webContents.send(IPC_CHANNELS.undoShortcut)
  })

  window.on('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  if (devServerUrl && !app.isPackaged) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  settings = new SettingsStore(app.getPath('userData'))
  readiness = new ReadinessService({
    settings,
    homeDir: harnessHomeDirectory(),
    testPathOverride:
      !app.isPackaged && testReadinessPath !== undefined ? testReadinessPath : undefined
  })
  runService = new RunService({
    core: coreClient,
    broker: new RunProcessBroker(),
    readiness,
    homeDirectory: app.getPath('home'),
    privateRoot: join(app.getPath('userData'), 'runs'),
    proxyExecutable: process.execPath,
    proxyScript: join(__dirname, 'mcp-proxy.js'),
    skills: skillsFor,
    // Assistant text and control events take the direct path to the window so
    // streaming stays responsive; durable projection follows behind it.
    onConversationEvent: (event) => {
      mainWindow?.webContents.send(IPC_CHANNELS.conversationEvent, event)
    }
  })

  // A Run the app never got to finish still has a record of what it changed
  // waiting to be compared (12e), and a Conversation that still has it open
  // (12g). Not awaited: nothing on screen depends on it, and a Run started
  // before it lands waits for it itself.
  void runService.recoverUnfinishedWork().catch(() => undefined)

  // Resolve appearance before any window exists so the first paint already
  // matches System, Light, or Dark.
  nativeTheme.themeSource = settings.get().themePreference

  hardenSession()
  coreClient.start()
  registerIpc()

  // Keep both surfaces in step when the resolved appearance changes, whether
  // from macOS System appearance or an explicit preference change.
  nativeTheme.on('updated', () => {
    if (!mainWindow) return
    mainWindow.setBackgroundColor(
      WINDOW_BACKGROUND[nativeTheme.shouldUseDarkColors ? 'dark' : 'light']
    )
    mainWindow.webContents.send(IPC_CHANNELS.themeChanged, themeState())
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

let shutdownStarted = false
app.on('before-quit', (event) => {
  if (shutdownStarted) return
  event.preventDefault()
  shutdownStarted = true
  void runService
    .stopAll('quit')
    .then(() => {
      coreClient.stop()
      app.exit(0)
    })
    .catch(async () => {
      shutdownStarted = false
      await dialog.showMessageBox({
        type: 'error',
        title: 'Could not verify Run cleanup',
        message: 'The app stayed open because a Harness process group may still be running.',
        detail:
          'Check Activity Monitor, then try Quit again. New Runs remain blocked until supervision is recovered.',
        buttons: ['Keep app open']
      })
    })
})
