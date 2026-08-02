import { mkdir, rename, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
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
  sessionRelativePathSchema,
  openedSessionSchema,
  librarySnapshotSchema,
  captureSessionInputSchema,
  deleteSessionInputSchema,
  deleteSessionPreviewSchema,
  mailboxQuerySchema,
  mailboxSnapshotSchema,
  setSessionArchivedInputSchema,
  setSessionPinnedInputSchema,
  themePreferenceSchema,
  runSnapshotSchema,
  startRunInputSchema,
  stopRunInputSchema,
  conversationSnapshotSchema,
  developSessionInputSchema,
  SKILL_ATTRIBUTION,
  type BootState,
  type ChooseLibraryResult,
  type DeleteSessionResult,
  type LibrarySnapshot,
  type ThemeState
} from '@shared/contract'
import {
  chooseExecutableResultSchema,
  harnessIdSchema,
  readinessSnapshotSchema,
  refreshReadinessInputSchema
} from '@shared/readiness'
import { CoreClient } from './core-client'
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

// Test-only seams, ignored in packaged builds: redirect userData so test runs
// are hermetic, and answer the native folder picker without a real dialog.
const testUserData = process.env['APP_TEST_USER_DATA']
const testChooseDir = process.env['APP_TEST_CHOOSE_DIR']
const testTrashDir = process.env['APP_TEST_TRASH_DIR']
const testReadinessPath = process.env['APP_TEST_READINESS_PATH']
const testReadinessHome = process.env['APP_TEST_READINESS_HOME']
const testChooseExecutable = process.env['APP_TEST_CHOOSE_EXECUTABLE']
const devServerUrl = process.env['ELECTRON_RENDERER_URL']
if (testUserData && !app.isPackaged) {
  app.setPath('userData', testUserData)
}

app.enableSandbox()

let mainWindow: BrowserWindow | null = null
let settings: SettingsStore
let readiness: ReadinessService
let runService: RunService
let libraryState: LibrarySnapshot | null = null
let bootReady: Promise<void> = Promise.resolve()

const coreClient = new CoreClient(() => {
  // Core respawned after a crash: restore its only piece of state from the
  // persisted settings so the renderer keeps working.
  const libraryPath = settings.get().libraryPath
  if (libraryPath) {
    void coreClient.send({ type: 'library/open', path: libraryPath }).catch(() => undefined)
  }
  void runService.stopAll('core-crash').catch(() => undefined)
})

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

async function openLibrary(path: string): Promise<LibrarySnapshot> {
  // The native picker only yields existing folders; Core rejects anything
  // else. Main never creates a library location on its own.
  const snapshot = librarySnapshotSchema.parse(
    await coreClient.send({ type: 'library/open', path })
  )
  libraryState = snapshot
  settings.update({ libraryPath: path })
  return snapshot
}

function registerIpc(): void {
  handleInvoke(IPC_CHANNELS.bootState, z.undefined(), async (): Promise<BootState> => {
    await bootReady
    return {
      contractVersion: CONTRACT_VERSION,
      appVersion: app.getVersion(),
      theme: themeState(),
      library: libraryState
    }
  })

  handleInvoke(
    IPC_CHANNELS.chooseLibraryLocation,
    z.undefined(),
    async (): Promise<ChooseLibraryResult> => {
      if (testChooseDir && !app.isPackaged) {
        return { canceled: false, path: testChooseDir }
      }
      if (!mainWindow) return { canceled: true }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose or create your library',
        message: 'Sessions are saved as plain Markdown folders inside this location.',
        buttonLabel: 'Use this folder',
        properties: ['openDirectory', 'createDirectory']
      })
      const path = result.filePaths[0]
      if (result.canceled || !path) return { canceled: true }
      return { canceled: false, path }
    }
  )

  handleInvoke(IPC_CHANNELS.openLibrary, z.string().min(1), openLibrary)

  handleInvoke(IPC_CHANNELS.captureSession, captureSessionInputSchema, async (input) => {
    const session = sessionSummarySchema.parse(
      await coreClient.send({ type: 'session/capture', input })
    )
    if (libraryState) {
      libraryState = { ...libraryState, sessions: [session, ...libraryState.sessions] }
    }
    return session
  })

  handleInvoke(IPC_CHANNELS.openSession, sessionRelativePathSchema, async (relativePath) =>
    openedSessionSchema.parse(await coreClient.send({ type: 'session/open', relativePath }))
  )

  handleInvoke(IPC_CHANNELS.listSessions, z.undefined(), async () => {
    const sessions = z
      .array(sessionSummarySchema)
      .parse(await coreClient.send({ type: 'session/list' }))
    if (libraryState) libraryState = { ...libraryState, sessions }
    return sessions
  })

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
        relativePath: sessionRelativePathSchema.parse(input.relativePath),
        pinned: input.pinned
      })
    )
  )

  handleInvoke(IPC_CHANNELS.setSessionArchived, setSessionArchivedInputSchema, async (input) =>
    sessionSummarySchema.parse(
      await coreClient.send({
        type: 'session/set-archived',
        relativePath: sessionRelativePathSchema.parse(input.relativePath),
        archived: input.archived
      })
    )
  )

  handleInvoke(IPC_CHANNELS.previewDeleteSession, sessionRelativePathSchema, async (relativePath) =>
    deleteSessionPreviewSchema.parse(
      await coreClient.send({ type: 'session/delete-preview', relativePath })
    )
  )

  handleInvoke(
    IPC_CHANNELS.deleteSessionPermanently,
    deleteSessionInputSchema,
    async ({ relativePath, targets }): Promise<DeleteSessionResult> => {
      const libraryPath = libraryState?.path ?? settings.get().libraryPath
      if (!libraryPath) {
        throw new CoreError('NO_LIBRARY_OPEN', 'Open a library before deleting a Session')
      }
      // Delete acts only on the previewed, confirmed app-owned targets. That
      // keeps what happens identical to what the person read, and lets a
      // retry finish the remaining targets after a partial failure even when
      // the Session is no longer recognizable on disk.
      const folder = sessionRelativePathSchema.parse(relativePath)
      if (!targets.every((target) => isConfirmedSessionTarget(target, folder))) {
        throw new CoreError('INVALID_INPUT', 'Delete targets must stay inside the Session folder')
      }
      const trashed: string[] = []
      const failed: DeleteSessionResult['failed'] = []
      for (const target of targets) {
        try {
          await trashTarget(join(libraryPath, target))
          trashed.push(target)
        } catch (error) {
          if (await isMissing(join(libraryPath, target))) {
            // Already gone (for example after a retried partial delete): the
            // desired end state is reached.
            trashed.push(target)
            continue
          }
          failed.push({
            path: target,
            message: error instanceof Error ? error.message : 'Could not move to Trash'
          })
        }
      }
      // Resync canonical state and the search projection after the change.
      await openLibrary(libraryPath).catch(() => undefined)
      return { trashed, failed }
    }
  )

  handleInvoke(IPC_CHANNELS.setThemePreference, themePreferenceSchema, (preference) => {
    settings.update({ themePreference: preference })
    nativeTheme.themeSource = preference
    return themeState()
  })

  handleInvoke(IPC_CHANNELS.getReadiness, z.undefined(), async () =>
    readinessSnapshotSchema.parse(await readiness.get())
  )

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
  handleInvoke(IPC_CHANNELS.listRuns, sessionRelativePathSchema, async (relativePath) =>
    runSnapshotSchema.array().parse(await runService.list(relativePath))
  )
  handleInvoke(IPC_CHANNELS.stopRun, stopRunInputSchema, ({ runId, relativePath }) =>
    runService.stop(runId, relativePath)
  )

  handleInvoke(IPC_CHANNELS.getConversation, sessionRelativePathSchema, async (relativePath) =>
    conversationSnapshotSchema.parse(await runService.conversation(relativePath))
  )
  handleInvoke(IPC_CHANNELS.developSession, developSessionInputSchema, async (input) =>
    conversationSnapshotSchema.parse(await runService.develop(input))
  )
}

/** A previewed target: the Session folder itself or a portable path inside it. */
function isConfirmedSessionTarget(target: string, folder: string): boolean {
  if (target === folder) return true
  if (!target.startsWith(`${folder}/`)) return false
  return target
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes('\\'))
}

async function isMissing(absolutePath: string): Promise<boolean> {
  return stat(absolutePath).then(
    () => false,
    () => true
  )
}

async function trashTarget(absolutePath: string): Promise<void> {
  // Test seam: acceptance tests observe the move without touching the real
  // macOS Trash. Ignored in packaged builds.
  if (testTrashDir && !app.isPackaged) {
    await mkdir(testTrashDir, { recursive: true })
    await rename(absolutePath, join(testTrashDir, `${Date.now()}-${basename(absolutePath)}`))
    return
  }
  await shell.trashItem(absolutePath)
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
    width: 1180,
    height: 780,
    minWidth: 840,
    minHeight: 560,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101012' : '#fafafa',
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
    homeDir: !app.isPackaged && testReadinessHome ? testReadinessHome : app.getPath('home'),
    testPathOverride:
      !app.isPackaged && testReadinessPath !== undefined ? testReadinessPath : undefined
  })
  runService = new RunService({
    core: coreClient,
    broker: new RunProcessBroker(),
    readiness,
    libraryPath: () => libraryState?.path ?? settings.get().libraryPath,
    homeDirectory: app.getPath('home'),
    privateRoot: join(app.getPath('userData'), 'runs'),
    proxyExecutable: process.execPath,
    proxyScript: join(__dirname, 'mcp-proxy.js'),
    // Assistant text and control events take the direct path to the window so
    // streaming stays responsive; durable projection follows behind it.
    onConversationEvent: (event) => {
      mainWindow?.webContents.send(IPC_CHANNELS.conversationEvent, event)
    }
  })

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
    mainWindow.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#101012' : '#fafafa')
    mainWindow.webContents.send(IPC_CHANNELS.themeChanged, themeState())
  })

  const libraryPath = settings.get().libraryPath
  if (libraryPath) {
    bootReady = openLibrary(libraryPath).then(
      () => undefined,
      () => {
        // The remembered library is missing or unreadable: fall back to
        // onboarding instead of failing the launch.
        libraryState = null
      }
    )
  }

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
