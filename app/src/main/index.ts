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
  chooseReferenceAttachmentInputSchema,
  chooseReferenceAttachmentResultSchema,
  ideaSummarySchema,
  ideaRelativePathSchema,
  openedIdeaSchema,
  librarySnapshotSchema,
  locateIdeaResultSchema,
  captureIdeaInputSchema,
  deleteIdeaInputSchema,
  deleteIdeaPreviewSchema,
  mailboxQuerySchema,
  mailboxSnapshotSchema,
  reconcileIdeaInputSchema,
  reconciliationStateSchema,
  referenceActionInputSchema,
  referenceAttachmentSchema,
  referenceAttachmentViewSchema,
  resolveManagedConflictInputSchema,
  resolveDuplicateManagedDocumentInputSchema,
  restoreManagedVersionInputSchema,
  setIdeaArchivedInputSchema,
  setIdeaPinnedInputSchema,
  themePreferenceSchema,
  type BootState,
  type ChooseLibraryResult,
  type DeleteIdeaResult,
  type LibrarySnapshot,
  type ReferenceAttachment,
  type ReferenceAttachmentView,
  type ThemeState
} from '@shared/contract'
import {
  chooseExecutableResultSchema,
  providerIdSchema,
  readinessSnapshotSchema,
  refreshReadinessInputSchema
} from '@shared/readiness'
import { CoreClient } from './core-client'
import { PROVIDER_SPECS, readinessLinkHosts } from './readiness'
import { ReadinessService } from './readiness-service'
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
const testTrashDir = process.env['IDEA_SHELL_TEST_TRASH_DIR']
const testReadinessPath = process.env['IDEA_SHELL_TEST_READINESS_PATH']
const testReadinessHome = process.env['IDEA_SHELL_TEST_READINESS_HOME']
const testChooseExecutable = process.env['IDEA_SHELL_TEST_CHOOSE_EXECUTABLE']
const devServerUrl = process.env['ELECTRON_RENDERER_URL']
if (testUserData && !app.isPackaged) {
  app.setPath('userData', testUserData)
}

app.enableSandbox()

let mainWindow: BrowserWindow | null = null
let settings: SettingsStore
let readiness: ReadinessService
let libraryState: LibrarySnapshot | null = null
let bootReady: Promise<void> = Promise.resolve()

const coreClient = new CoreClient(() => {
  // Core respawned after a crash: restore its only piece of state from the
  // persisted settings so the renderer keeps working.
  const libraryPath = settings.get().libraryPath
  if (libraryPath) {
    void coreClient
      .send({ type: 'library/open', path: libraryPath })
      .then(restoreWorkingDirectories, () => undefined)
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
  const previousLibraryPath = settings.get().libraryPath
  const snapshot = librarySnapshotSchema.parse(
    await coreClient.send({ type: 'library/open', path })
  )
  libraryState = snapshot
  settings.update({
    libraryPath: path,
    ...(previousLibraryPath && previousLibraryPath !== path ? { workingDirectories: {} } : {})
  })
  return snapshot
}

async function restoreWorkingDirectories(): Promise<void> {
  for (const [relativePath, registration] of Object.entries(settings.get().workingDirectories)) {
    try {
      await coreClient.send({
        type: 'idea/locate',
        relativePath,
        selectedDirectory: registration.path,
        expectedIdeaId: registration.ideaId
      })
      const opened = openedIdeaSchema.parse(
        await coreClient.send({ type: 'idea/open', relativePath })
      )
      if (libraryState && !libraryState.ideas.some((idea) => idea.id === opened.idea.id)) {
        libraryState = { ...libraryState, ideas: [opened.idea, ...libraryState.ideas] }
      }
    } catch {
      // Keep the placeholder registration so a remounted volume recovers on restart.
    }
  }
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

  handleInvoke(IPC_CHANNELS.queryMailbox, mailboxQuerySchema, async (query) =>
    mailboxSnapshotSchema.parse(
      await coreClient.send({
        type: 'mailbox/query',
        query: { ...query, dormantAfterDays: settings.get().dormantAfterDays }
      })
    )
  )

  handleInvoke(IPC_CHANNELS.setIdeaPinned, setIdeaPinnedInputSchema, async (input) =>
    ideaSummarySchema.parse(
      await coreClient.send({
        type: 'idea/set-pinned',
        relativePath: ideaRelativePathSchema.parse(input.relativePath),
        pinned: input.pinned
      })
    )
  )

  handleInvoke(IPC_CHANNELS.setIdeaArchived, setIdeaArchivedInputSchema, async (input) =>
    ideaSummarySchema.parse(
      await coreClient.send({
        type: 'idea/set-archived',
        relativePath: ideaRelativePathSchema.parse(input.relativePath),
        archived: input.archived
      })
    )
  )

  handleInvoke(IPC_CHANNELS.previewDeleteIdea, ideaRelativePathSchema, async (relativePath) =>
    deleteIdeaPreviewSchema.parse(
      await coreClient.send({ type: 'idea/delete-preview', relativePath })
    )
  )

  handleInvoke(IPC_CHANNELS.reconcileIdea, reconcileIdeaInputSchema, async (input) =>
    reconciliationStateSchema.parse(await coreClient.send({ type: 'idea/reconcile', input }))
  )

  handleInvoke(IPC_CHANNELS.latestReconciliation, ideaRelativePathSchema, async (relativePath) =>
    reconciliationStateSchema
      .nullable()
      .parse(await coreClient.send({ type: 'idea/reconciliation-latest', relativePath }))
  )

  handleInvoke(IPC_CHANNELS.locateIdea, ideaRelativePathSchema, async (relativePath) => {
    if (!mainWindow) return { canceled: true as const }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Locate Idea Working Directory',
      message: 'Choose this Idea’s folder. The app will not search anywhere else.',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory']
    })
    const selectedDirectory = result.filePaths[0]
    if (result.canceled || !selectedDirectory) return { canceled: true as const }
    const expectedIdeaId = libraryState?.ideas.find(
      (idea) => idea.relativePath === relativePath
    )?.id
    if (!expectedIdeaId) throw new CoreError('IDEA_NOT_FOUND', 'The Idea identity is unavailable')
    const state = await coreClient.send({
      type: 'idea/locate',
      relativePath,
      selectedDirectory,
      expectedIdeaId
    })
    settings.update({
      workingDirectories: {
        ...settings.get().workingDirectories,
        [relativePath]: { path: selectedDirectory, ideaId: expectedIdeaId }
      }
    })
    return locateIdeaResultSchema.parse({
      canceled: false,
      state
    })
  })

  handleInvoke(
    IPC_CHANNELS.restoreManagedVersion,
    restoreManagedVersionInputSchema,
    async (input) =>
      reconciliationStateSchema.parse(
        await coreClient.send({ type: 'idea/restore-version', input })
      )
  )

  handleInvoke(
    IPC_CHANNELS.resolveManagedConflict,
    resolveManagedConflictInputSchema,
    async (input) =>
      reconciliationStateSchema.parse(
        await coreClient.send({ type: 'idea/resolve-conflict', input })
      )
  )

  handleInvoke(
    IPC_CHANNELS.resolveDuplicateManagedDocument,
    resolveDuplicateManagedDocumentInputSchema.pick({ relativePath: true, documentId: true }),
    async ({ relativePath, documentId }) => {
      if (!mainWindow) return { canceled: true as const }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose the Intended Managed Copy',
        message:
          'Choose the Markdown file to keep. Other duplicate copies will be preserved in recovery storage.',
        buttonLabel: 'Keep this copy',
        properties: ['openFile'],
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      const selectedPath = result.filePaths[0]
      if (result.canceled || !selectedPath) return { canceled: true as const }
      const state = reconciliationStateSchema.parse(
        await coreClient.send({
          type: 'idea/resolve-duplicate',
          input: { relativePath, documentId, selectedPath }
        })
      )
      return locateIdeaResultSchema.parse({ canceled: false, state })
    }
  )

  handleInvoke(
    IPC_CHANNELS.chooseReferenceAttachment,
    chooseReferenceAttachmentInputSchema,
    async (input) => {
      if (!mainWindow) return { canceled: true as const }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose a Reference Attachment',
        message: 'The image stays external unless you choose Keep with Idea.',
        buttonLabel: 'Use image',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]
      })
      const sourcePath = result.filePaths[0]
      if (result.canceled || !sourcePath) return { canceled: true as const }
      const reference = referenceAttachmentSchema.parse(
        await coreClient.send({
          type: 'reference/add',
          relativePath: input.relativePath,
          messageId: input.messageId,
          sourcePath
        })
      )
      return chooseReferenceAttachmentResultSchema.parse({
        canceled: false,
        reference: await referenceView(reference)
      })
    }
  )

  handleInvoke(
    IPC_CHANNELS.listReferenceAttachments,
    ideaRelativePathSchema,
    async (relativePath) => {
      const references = z
        .array(referenceAttachmentSchema)
        .parse(await coreClient.send({ type: 'reference/list', relativePath }))
      return Promise.all(references.map(referenceView))
    }
  )

  handleInvoke(IPC_CHANNELS.keepReferenceWithIdea, referenceActionInputSchema, async (input) =>
    referenceView(
      referenceAttachmentSchema.parse(await coreClient.send({ type: 'reference/keep', input }))
    )
  )

  handleInvoke(
    IPC_CHANNELS.locateReferenceAttachment,
    referenceActionInputSchema,
    async (input) => {
      if (!mainWindow) return { canceled: true as const }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Locate Reference Attachment',
        buttonLabel: 'Use image',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]
      })
      const sourcePath = result.filePaths[0]
      if (result.canceled || !sourcePath) return { canceled: true as const }
      return chooseReferenceAttachmentResultSchema.parse({
        canceled: false,
        reference: await referenceView(
          referenceAttachmentSchema.parse(
            await coreClient.send({
              type: 'reference/locate',
              input: { ...input, sourcePath }
            })
          )
        )
      })
    }
  )

  handleInvoke(IPC_CHANNELS.continueWithoutReference, referenceActionInputSchema, async (input) => {
    await coreClient.send({ type: 'reference/continue-without', input })
  })

  handleInvoke(
    IPC_CHANNELS.deleteIdeaPermanently,
    deleteIdeaInputSchema,
    async ({ relativePath, targets }): Promise<DeleteIdeaResult> => {
      const libraryPath = libraryState?.path ?? settings.get().libraryPath
      if (!libraryPath) {
        throw new CoreError('NO_LIBRARY_OPEN', 'Open an Idea Library before deleting an Idea')
      }
      // Delete acts only on the previewed, confirmed app-owned targets. That
      // keeps what happens identical to what the person read, and lets a
      // retry finish the remaining targets after a partial failure even when
      // the Idea is no longer recognizable on disk.
      const folder = ideaRelativePathSchema.parse(relativePath)
      if (!targets.every((target) => isConfirmedIdeaTarget(target, folder))) {
        throw new CoreError('INVALID_INPUT', 'Delete targets must stay inside the Idea folder')
      }
      const trashed: string[] = []
      const failed: DeleteIdeaResult['failed'] = []
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

  handleInvoke(IPC_CHANNELS.refreshReadiness, refreshReadinessInputSchema, async ({ provider }) =>
    readinessSnapshotSchema.parse(await readiness.refresh(provider))
  )

  handleInvoke(IPC_CHANNELS.chooseProviderExecutable, providerIdSchema, async (provider) => {
    let selected: string | undefined
    if (testChooseExecutable && !app.isPackaged) {
      selected = testChooseExecutable
    } else {
      if (!mainWindow) return { canceled: true as const }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: `Choose the ${PROVIDER_SPECS[provider].displayName} executable`,
        message:
          'The selected program is verified and must still pass the provider’s own readiness checks. Nothing is installed or changed.',
        buttonLabel: 'Use this executable',
        properties: ['openFile', 'showHiddenFiles']
      })
      selected = result.canceled ? undefined : result.filePaths[0]
    }
    if (!selected) return { canceled: true as const }
    return chooseExecutableResultSchema.parse({
      canceled: false,
      snapshot: await readiness.setExplicitExecutable(provider, selected)
    })
  })

  handleInvoke(IPC_CHANNELS.clearProviderExecutable, providerIdSchema, async (provider) =>
    readinessSnapshotSchema.parse(await readiness.clearExplicitExecutable(provider))
  )

  handleInvoke(IPC_CHANNELS.setLoginShellDiscovery, z.boolean(), async (consent) =>
    readinessSnapshotSchema.parse(await readiness.setLoginShellDiscovery(consent))
  )

  // Only the fixed readiness-guidance hosts may leave the app. Anything else
  // is rejected, so the renderer cannot turn this into an open redirect.
  const externalLinkHosts = readinessLinkHosts()
  handleInvoke(IPC_CHANNELS.openExternalLink, z.string().url(), async (url) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !externalLinkHosts.has(parsed.hostname)) {
      throw new Error('Refused to open an unapproved external link')
    }
    await shell.openExternal(parsed.toString())
  })
}

async function referenceView(reference: ReferenceAttachment): Promise<ReferenceAttachmentView> {
  const availability = reference.omitted
    ? 'omitted'
    : reference.durablePath
      ? 'kept'
      : (await isMissing(reference.sourcePath))
        ? 'missing'
        : 'available'
  return referenceAttachmentViewSchema.parse({ ...reference, availability })
}

/** A previewed target: the Idea folder itself or a portable path inside it. */
function isConfirmedIdeaTarget(target: string, folder: string): boolean {
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
    bootReady = openLibrary(libraryPath).then(restoreWorkingDirectories, () => {
      // The remembered library is missing or unreadable: fall back to
      // onboarding instead of failing the launch.
      libraryState = null
    })
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
