import { join } from 'node:path'
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  type IpcMainInvokeEvent
} from 'electron'
import { z } from 'zod'
import {
  CONTRACT_VERSION,
  CoreError,
  IPC_CHANNELS,
  ideaSummarySchema,
  ideaRelativePathSchema,
  openedIdeaSchema,
  librarySnapshotSchema,
  captureIdeaInputSchema,
  themePreferenceSchema,
  type BootState,
  type ChooseLibraryResult,
  type LibrarySnapshot,
  type ThemeState
} from '@shared/contract'
import { CoreClient } from './core-client'
import { SettingsStore } from './settings'

/**
 * Thin privileged Main process: window lifecycle, native dialogs and theme,
 * IPC sender validation, and Core supervision. Product behavior lives in the
 * Core utility process; presentation lives in the sandboxed Renderer.
 */

// Test-only seams, ignored in packaged builds: redirect userData so test runs
// are hermetic, and answer the native folder picker without a real dialog.
const testUserData = process.env['IDEA_SHELL_TEST_USER_DATA']
const testChooseDir = process.env['IDEA_SHELL_TEST_CHOOSE_DIR']
const devServerUrl = process.env['ELECTRON_RENDERER_URL']
if (testUserData && !app.isPackaged) {
  app.setPath('userData', testUserData)
}

app.enableSandbox()

let mainWindow: BrowserWindow | null = null
let settings: SettingsStore
let libraryState: LibrarySnapshot | null = null
let bootReady: Promise<void> = Promise.resolve()

const coreClient = new CoreClient(() => {
  // Core respawned after a crash: restore its only piece of state from the
  // persisted settings so the renderer keeps working.
  const libraryPath = settings.get().libraryPath
  if (libraryPath) {
    void coreClient.send({ type: 'library/open', path: libraryPath }).catch(() => undefined)
  }
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
        title: 'Choose or create your Idea Library',
        message: 'Ideas are saved as plain Markdown folders inside this location.',
        buttonLabel: 'Use this folder',
        properties: ['openDirectory', 'createDirectory']
      })
      const path = result.filePaths[0]
      if (result.canceled || !path) return { canceled: true }
      return { canceled: false, path }
    }
  )

  handleInvoke(IPC_CHANNELS.openLibrary, z.string().min(1), openLibrary)

  handleInvoke(IPC_CHANNELS.captureIdea, captureIdeaInputSchema, async (input) => {
    const idea = ideaSummarySchema.parse(await coreClient.send({ type: 'idea/capture', input }))
    if (libraryState) {
      libraryState = { ...libraryState, ideas: [idea, ...libraryState.ideas] }
    }
    return idea
  })

  handleInvoke(IPC_CHANNELS.openIdea, ideaRelativePathSchema, async (relativePath) =>
    openedIdeaSchema.parse(await coreClient.send({ type: 'idea/open', relativePath }))
  )

  handleInvoke(IPC_CHANNELS.listIdeas, z.undefined(), async () => {
    const ideas = z.array(ideaSummarySchema).parse(await coreClient.send({ type: 'idea/list' }))
    if (libraryState) libraryState = { ...libraryState, ideas }
    return ideas
  })

  handleInvoke(IPC_CHANNELS.setThemePreference, themePreferenceSchema, (preference) => {
    settings.update({ themePreference: preference })
    nativeTheme.themeSource = preference
    return themeState()
  })
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

app.on('quit', () => {
  coreClient.stop()
})
