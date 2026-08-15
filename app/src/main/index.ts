import { basename, delimiter, dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import {
  BrowserWindow,
  Notification,
  app,
  dialog,
  ipcMain,
  nativeImage,
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
  appearanceSettingsSchema,
  listSkillsInputSchema,
  modelCatalogSchema,
  skillCatalogSchema,
  trustProjectSkillsInputSchema,
  type SkillCatalog,
  denyApprovalsInputSchema,
  resolveApprovalInputSchema,
  applyRunUndoInputSchema,
  prepareRunUndoInputSchema,
  runUndoApplicationSchema,
  runUndoPreparationSchema,
  revokeStandingApprovalInputSchema,
  runSnapshotSchema,
  standingApprovalSchema,
  startRunInputSchema,
  stopRunInputSchema,
  branchListSchema,
  buildWorktreeBootstrapResult,
  removeWorktreesInputSchema,
  worktreeInventorySchema,
  worktreeRemovalResultSchema,
  checkoutCostRecordSchema,
  checkoutDirectory,
  checkoutFactsSchema,
  isolatedBranchName,
  startSessionRequestSchema,
  resumeWorktreeBootstrapInputSchema,
  editorCatalogSchema,
  openInEditorInputSchema,
  conversationSnapshotSchema,
  compactSessionInputSchema,
  developSessionInputSchema,
  editQueuedSubmissionInputSchema,
  enqueueQueuedSubmissionInputSchema,
  moveQueuedSubmissionInputSchema,
  queuedSubmissionIdentitySchema,
  rewindSessionInputSchema,
  SKILL_ATTRIBUTION,
  projectViewSchema,
  githubRepositoryListResultSchema,
  projectCloneEventSchema,
  projectCloneInputSchema,
  projectCloneLocationSchema,
  projectCloneStartedSchema,
  type BootState,
  type Checkout,
  type ChooseProjectResult,
  type ConversationStreamEvent,
  quitRequestResponseSchema,
  updateAvailabilitySchema,
  type AppearanceSettings,
  type ThemeState
} from '@shared/contract'
import type { StartSessionRequest, WorktreeBootstrapResult } from '@shared/contract'
import {
  WINDOW_BACKGROUND,
  nativeThemeSourceFor,
  resolveAppearance,
  type ThemePreference
} from '@shared/theme'
import {
  chooseExecutableResultSchema,
  harnessIdSchema,
  type HarnessId,
  readinessSnapshotSchema,
  refreshReadinessInputSchema
} from '@shared/readiness'
import { PRODUCT_NAME, releaseFeedUrl, releasePagePrefix, stateDirectory } from './identity'
import { unpackedPath } from './packaging'
import { UpdateService } from './update'
import {
  confirmProjectSkillsTrust,
  diffProjectSkillManifests,
  discoverSkills,
  observeProjectSkills
} from './skills'
import { CoreClient } from './core-client'
import {
  createWorktree,
  currentBranch,
  initRepository,
  listBranches,
  observeCheckoutState,
  resolveProjectRoot
} from './git'
import { detectEditors, openInEditor } from './editors'
import { discoverModels } from './models'
import { HARNESS_SPECS, readinessLinkHosts } from './readiness'
import { ReadinessService } from './readiness-service'
import { SettingsStore } from './settings'
import { createMainEffectRuntime, RunProcessBroker } from './run-process-broker'
import { RunService } from './run-service'
import { RunUndoService } from './run-undo'
import { SessionSnapshotStore } from './snapshot-store'
import { CheckoutCostStore } from './checkout-cost-store'
import { bootstrapWorktree } from './worktree-bootstrap'
import { WorktreeReclaimService } from './worktree-reclaim'
import { GitHubPullRequests } from './github'
import { PullRequestStore } from './pull-request-store'
import { makePullRequestService, type PullRequestService } from './pull-request-service'
import { ProjectCloneService } from './project-clone'
import { ReviewStore } from './review-store'
import { ReviewService } from './review-service'
import { reviewStateSchema } from '@shared/review'
import {
  createPullRequestInputSchema,
  createPullRequestResultSchema,
  preparePullRequestInputSchema,
  preparePullRequestResultSchema
} from '@shared/pull-request'

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
const testChooseCloneDirs = (process.env['APP_TEST_CHOOSE_CLONE_DIRS'] ?? '')
  .split(delimiter)
  .filter((entry) => entry !== '')
let chosenCloneCount = 0
const testReadinessPath = process.env['APP_TEST_READINESS_PATH']
const testReadinessHome = process.env['APP_TEST_READINESS_HOME']
const testChooseExecutable = process.env['APP_TEST_CHOOSE_EXECUTABLE']
const testBackground = !app.isPackaged && process.env['APP_TEST_BACKGROUND'] === '1'
// A published release, answered without a network. Only a packaged build looks
// for one for real, so this is also how the behavior is exercised at all.
const testUpdateRelease = !app.isPackaged ? process.env['APP_TEST_UPDATE_RELEASE'] : undefined
const answerUpdateFeedInTests: typeof globalThis.fetch = () =>
  Promise.resolve(
    new Response(testUpdateRelease, {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  )
const devServerUrl = process.env['ELECTRON_RENDERER_URL']

// Who the app says it is, before anything reads it. Packaged, the bundle
// already says it: the packager writes the name and the version into
// `Info.plist` from this same identity, macOS titles the application menu from
// there before a line of this runs, and the About panel reads them — repeating
// it here could only make the two disagree. Unpackaged the bundle is
// Electron's own, so say it by hand. Either way the state directory takes the
// identifier rather than the name, so renaming the product later cannot orphan
// a person's history (ADR 0002).
if (!app.isPackaged) {
  app.setName(PRODUCT_NAME)
  app.setAboutPanelOptions({ applicationName: PRODUCT_NAME, applicationVersion: app.getVersion() })
}
// A packaged build wears the icon baked into its bundle by the packager
// (`build/icon.icns`). Unpackaged, the Dock would show Electron's own icon
// instead, so point it at the same artwork by hand. `build/` sits beside the
// bundled output rather than inside it, and an icon is decoration: if it ever
// goes missing that is not a reason to refuse to start.
if (process.platform === 'darwin' && !app.isPackaged) {
  const icon = nativeImage.createFromPath(join(__dirname, '../../build/icon.png'))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}
// Shell acceptance tests exercise the real app without taking over the
// person's desktop. Accessory apps do not appear in the Dock or menu bar.
if (testBackground && process.platform === 'darwin') app.setActivationPolicy('accessory')
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
let runUndo: RunUndoService
let worktreeReclaim: WorktreeReclaimService
let pullRequests: PullRequestService
let pullRequestStore: PullRequestStore
let reviews: ReviewService
let reviewStore: ReviewStore
let github: GitHubPullRequests
let projectClones: ProjectCloneService
let updates: UpdateService
/** The one store of app-owned Run snapshots; Runs write it, undo reads it. */
let snapshots: SessionSnapshotStore
/** What bootstrapping isolated Checkouts on this machine has cost. */
let checkoutCosts: CheckoutCostStore
let shutdownStarted = false
let quitPromptOpen = false
let servicesReady = false

interface PendingWorktreeBootstrap {
  request: StartSessionRequest
  baseBranch: string
  path: string
  result: WorktreeBootstrapResult
}

/** Kept only while the launch surface is offering Retry or Continue. */
const pendingWorktreeBootstraps = new Map<string, PendingWorktreeBootstrap>()

// One scoped runtime owns Main product behavior for exactly this Electron
// process. Its child Run scopes are released before the process may exit.
const mainEffectRuntime = createMainEffectRuntime()

const coreClient = new CoreClient(
  () => app.getPath('userData'),
  () => {
    // Core respawned after a crash. It reads its own durable state from the
    // app-owned store, so nothing has to be handed back to it; the Runs it
    // was supervising are no longer supervised and are stopped.
    void runService.stopAll('core-crash').catch(() => undefined)
  }
)

function appearanceSettings(): AppearanceSettings {
  return {
    preference: settings.get().themePreference,
    custom: settings.get().customTheme
  }
}

function themeState(): ThemeState {
  const appearance = appearanceSettings()
  const resolved = resolveAppearance(appearance, nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  return {
    preference: appearance.preference,
    resolved: resolved.resolved,
    palette: resolved.palette
  }
}

function windowBackground(state: ThemeState = themeState()): string {
  return state.palette?.background ?? WINDOW_BACKGROUND[state.resolved]
}

function applyNativeThemeSource(preference: ThemePreference): void {
  nativeTheme.themeSource = nativeThemeSourceFor(preference)
}

function publishTheme(): ThemeState {
  const state = themeState()
  mainWindow?.setBackgroundColor(windowBackground(state))
  mainWindow?.webContents.send(IPC_CHANNELS.themeChanged, state)
  return state
}

/** The Session ids the app still has, so app-owned records for the rest can go. */
function known(sessions: unknown): ReadonlySet<string> {
  return new Set(
    sessionSummarySchema
      .array()
      .parse(sessions)
      .map((session) => session.id)
  )
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

function cloneLocations(
  suggestedName: string
): { label: string; parent: string; destination: string }[] {
  const candidates = [
    { label: 'Home', parent: app.getPath('home') },
    { label: 'Documents', parent: app.getPath('documents') },
    { label: 'Desktop', parent: app.getPath('desktop') }
  ]
  const seen = new Set<string>()
  return candidates.flatMap(({ label, parent }) => {
    if (seen.has(parent)) return []
    seen.add(parent)
    return [{ label, parent, destination: join(parent, suggestedName) }]
  })
}

async function chooseCloneLocation(
  suggestedName: string
): Promise<{ label: string; parent: string; destination: string } | null> {
  let parent: string | undefined
  if (testChooseCloneDirs.length > 0 && !app.isPackaged) {
    const index = Math.min(chosenCloneCount++, testChooseCloneDirs.length - 1)
    parent = testChooseCloneDirs[index]
  } else if (mainWindow) {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose where to clone',
      message: `${suggestedName} will be created inside the selected folder.`,
      buttonLabel: 'Choose this location',
      properties: ['openDirectory']
    })
    if (!result.canceled) parent = result.filePaths[0]
  }
  if (!parent) return null
  return { label: basename(parent) || parent, parent, destination: join(parent, suggestedName) }
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

  handleInvoke(IPC_CHANNELS.listGitHubRepositories, z.undefined(), async () =>
    githubRepositoryListResultSchema.parse(
      await mainEffectRuntime.runPromise(github.repositories(app.getPath('home')))
    )
  )

  const suggestedCloneName = z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/u)
    .max(255)
  handleInvoke(IPC_CHANNELS.listProjectCloneLocations, suggestedCloneName, (suggestedName) =>
    projectCloneLocationSchema.array().parse(cloneLocations(suggestedName))
  )
  handleInvoke(
    IPC_CHANNELS.chooseProjectCloneLocation,
    suggestedCloneName,
    async (suggestedName) => {
      const location = await chooseCloneLocation(suggestedName)
      return location === null ? null : projectCloneLocationSchema.parse(location)
    }
  )
  handleInvoke(IPC_CHANNELS.startProjectClone, projectCloneInputSchema, async (input) => {
    return projectCloneStartedSchema.parse(await projectClones.start(input))
  })
  handleInvoke(IPC_CHANNELS.beginProjectClone, z.string().uuid(), async (operationId) => {
    await projectClones.begin(operationId)
  })
  handleInvoke(IPC_CHANNELS.cancelProjectClone, z.string().uuid(), async (operationId) => {
    await projectClones.cancel(operationId)
  })

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
    let trust = null
    if (input.trusted) {
      if (!input.reviewedDigest) throw new Error('A reviewed Skill digest is required')
      trust = await confirmProjectSkillsTrust(input.root, input.reviewedDigest)
    }
    const project = projectViewSchema.parse(
      await coreClient.send({
        type: 'project/trust-skills',
        root: input.root,
        trust
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
  // `git init` is one explicit Git mutation; cloning and publishing an
  // isolated Checkout are the others (ADR 0007).
  handleInvoke(
    IPC_CHANNELS.initializeProject,
    z.string().min(1),
    async (path): Promise<ChooseProjectResult> => {
      const initialized = await initRepository(path)
      if (initialized.status === 'git-unavailable') {
        return { status: 'refused', reason: 'git-unavailable', path }
      }
      if (initialized.status === 'blocked') {
        const resolution = await resolveProjectRoot(path)
        if (resolution.status === 'resolved') {
          return { status: 'confirm-root', chosen: path, root: resolution.root }
        }
        return { status: 'refused', reason: resolution.status, path }
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
    let checkout: Checkout
    let worktreeBootstrap: WorktreeBootstrapResult | null = null
    if (request.checkout.kind === 'isolated') {
      const created = await createWorktree({
        projectRoot: request.projectRoot,
        worktreesDirectory: worktreesDirectory(request.projectRoot),
        branch: isolatedBranchName(request.message),
        baseBranch: request.checkout.baseBranch
      })
      if (created.status !== 'created') {
        if (created.status === 'blocked') {
          return startSessionResultSchema.parse({
            status: 'blocked',
            action: 'create-worktree',
            state: created.state
          })
        }
        if (created.status === 'git-unavailable' || created.status === 'not-a-repository') {
          return startSessionResultSchema.parse({
            status: 'refused',
            action: 'create-worktree',
            reason: created.status
          })
        }
        return startSessionResultSchema.parse({
          status: 'failed',
          action: 'create-worktree',
          message: created.message
        })
      }
      checkout = {
        kind: 'worktree',
        path: created.path,
        baseBranch: request.checkout.baseBranch
      }
      worktreeBootstrap = created.bootstrap
      // What this Checkout cost, written before the Session exists: the answer
      // is about the directory, and a bootstrap the person then abandoned at
      // the incomplete notice is still a bootstrap that was paid for.
      await recordCheckoutCost(created.path, created.bootstrap)
      if (created.bootstrap.skipped.length > 0) {
        const token = randomUUID()
        pendingWorktreeBootstraps.set(token, {
          request,
          baseBranch: request.checkout.baseBranch,
          path: created.path,
          result: created.bootstrap
        })
        return startSessionResultSchema.parse({
          status: 'bootstrap-incomplete',
          token,
          result: created.bootstrap
        })
      }
    } else {
      checkout = request.checkout
    }
    // Creating the Session and answering its message is one act, and the Run
    // service owns it: sending on the launch screen is a Session and its
    // first Run, not a Session that sits there unanswered.
    return startSessionResultSchema.parse(
      await runService.startSession({
        input: startSessionInputSchema.parse({ ...request, checkout, worktreeBootstrap }),
        run: request.run
      })
    )
  })

  handleInvoke(
    IPC_CHANNELS.resumeWorktreeBootstrap,
    resumeWorktreeBootstrapInputSchema,
    async (input) => {
      const pending = pendingWorktreeBootstraps.get(input.token)
      if (!pending) throw new Error('That Checkout is no longer waiting for a bootstrap decision')
      if (input.decision === 'retry') {
        const retryable = pending.result.skipped
          .filter((entry) => entry.reason !== 'invalid-path')
          .map((entry) => entry.path)
        const retried = await bootstrapWorktree({
          projectRoot: pending.request.projectRoot,
          checkoutRoot: pending.path,
          paths: retryable
        })
        pending.result = mergeBootstrapResults(pending.result, retried)
        // The same Checkout, re-answered: the entry is replaced rather than
        // added beside, and the retry's time is added to what came before it.
        await recordCheckoutCost(pending.path, pending.result)
        if (pending.result.skipped.length > 0) {
          return startSessionResultSchema.parse({
            status: 'bootstrap-incomplete',
            token: input.token,
            result: pending.result
          })
        }
      }
      pendingWorktreeBootstraps.delete(input.token)
      return startSessionResultSchema.parse(
        await runService.startSession({
          input: startSessionInputSchema.parse({
            projectRoot: pending.request.projectRoot,
            message: pending.request.message,
            checkout: {
              kind: 'worktree',
              path: pending.path,
              baseBranch: pending.baseBranch
            },
            worktreeBootstrap: pending.result
          }),
          run: pending.request.run
        })
      )
    }
  )

  handleInvoke(IPC_CHANNELS.listBranches, z.string().min(1), async (projectRoot) =>
    branchListSchema.parse(await listBranches(projectRoot))
  )

  handleInvoke(IPC_CHANNELS.listSessions, z.undefined(), async () =>
    z.array(sessionSummarySchema).parse(await coreClient.send({ type: 'session/list' }))
  )

  handleInvoke(IPC_CHANNELS.listDamagedSessions, z.undefined(), async () =>
    z.array(z.string()).parse(await coreClient.send({ type: 'session/list-damaged' }))
  )

  handleInvoke(IPC_CHANNELS.listProjectsWithActiveLocalRuns, z.undefined(), async () =>
    z.array(z.string()).parse(await coreClient.send({ type: 'session/active-local-runs' }))
  )

  handleInvoke(IPC_CHANNELS.queryMailbox, mailboxQuerySchema, async (query) => {
    const snapshot = mailboxSnapshotSchema.parse(
      await coreClient.send({
        type: 'mailbox/query',
        query: { ...query, dormantAfterDays: settings.get().dormantAfterDays }
      })
    )
    return mailboxSnapshotSchema.parse(
      await mainEffectRuntime.runPromise(pullRequests.attachToMailbox(snapshot))
    )
  })

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
  // every file, because that is where the work lives (ADR 0002). The Git
  // objects the app kept for it go too — they follow Session lifetime exactly,
  // and Delete is the one act that means gone (ADR 0006).
  handleInvoke(IPC_CHANNELS.deleteSession, z.string().min(1), async (sessionId) => {
    await coreClient.send({ type: 'session/delete', sessionId })
    runUndo.forget(sessionId)
    await snapshots.forget(sessionId)
    await mainEffectRuntime.runPromise(pullRequests.forget(sessionId))
    await reviews.forget(sessionId)
  })

  handleInvoke(IPC_CHANNELS.getAppearanceSettings, z.undefined(), appearanceSettings)

  handleInvoke<AppearanceSettings, ThemeState>(
    IPC_CHANNELS.setAppearanceSettings,
    appearanceSettingsSchema as z.ZodType<AppearanceSettings>,
    (appearance) => {
      settings.update({
        themePreference: appearance.preference,
        customTheme: appearance.custom
      })
      applyNativeThemeSource(appearance.preference)
      return publishTheme()
    }
  )

  handleInvoke(
    IPC_CHANNELS.getQuitWarningPreference,
    z.undefined(),
    () => settings.get().warnBeforeQuitWithActiveRuns
  )

  handleInvoke(IPC_CHANNELS.setQuitWarningPreference, z.boolean(), (enabled) => {
    settings.update({ warnBeforeQuitWithActiveRuns: enabled })
    return enabled
  })

  handleInvoke(IPC_CHANNELS.respondToQuitRequest, quitRequestResponseSchema, async (response) => {
    quitPromptOpen = false
    if (response === 'keep-working') return
    if (response === 'always-quit') {
      settings.update({ warnBeforeQuitWithActiveRuns: false })
    }
    await beginSafeShutdown()
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

  // What Main already learned, never a network call the window waits behind.
  handleInvoke(IPC_CHANNELS.getUpdate, z.undefined(), () =>
    updateAvailabilitySchema.parse(updates.latest())
  )

  // Taking the update is the person's action, and it ends in their browser:
  // Argos opens the release and stops there (ADR 0009). The Renderer asks for
  // "the update" and never supplies an address, so this is not a way to open
  // an arbitrary URL — Main opens the one it validated when it learned it.
  handleInvoke(IPC_CHANNELS.openUpdate, z.undefined(), async () => {
    const releaseUrl = updates.releaseUrl()
    if (!releaseUrl) throw new Error('There is no published update to open')
    await shell.openExternal(releaseUrl)
  })

  handleInvoke(IPC_CHANNELS.preparePullRequest, preparePullRequestInputSchema, async (input) => {
    const session = sessionSummarySchema.parse(
      await coreClient.send({ type: 'session/get', sessionId: input.sessionId })
    )
    const conversation = conversationSnapshotSchema.parse(
      await coreClient.send({ type: 'conversation/get', sessionId: input.sessionId })
    )
    const checkout = checkoutDirectory(session.projectRoot, session.checkout)
    const localSafety =
      session.checkout.kind === 'local'
        ? await snapshots.localPublishSafety(session.id, checkout)
        : undefined
    const comparison =
      localSafety?.status === 'safe'
        ? localSafety.comparison
        : await snapshots.compareCurrent(session.id, checkout)
    return preparePullRequestResultSchema.parse(
      await mainEffectRuntime.runPromise(
        pullRequests.prepare(session, {
          changedFiles:
            comparison?.changes ??
            conversation.changedFiles
              .filter((file) => !file.restored)
              .map(({ path, changeKind }) => ({ path, changeKind })),
          unlisted: comparison?.unlisted ?? 0,
          localSafety,
          messages: conversation.entries.flatMap((entry) =>
            entry.kind === 'message' && entry.role === 'user' ? [entry.text] : []
          )
        })
      )
    )
  })

  handleInvoke(IPC_CHANNELS.createPullRequest, createPullRequestInputSchema, async (input) => {
    const session = sessionSummarySchema.parse(
      await coreClient.send({ type: 'session/get', sessionId: input.sessionId })
    )
    if (session.checkout.kind === 'local') {
      const safety = await snapshots.localPublishSafety(session.id, session.projectRoot)
      if (safety.status !== 'safe') {
        return createPullRequestResultSchema.parse({ status: 'failed', detail: safety.detail })
      }
      if (input.publishMode !== 'local' || input.expectedTree !== safety.expectedTree) {
        return createPullRequestResultSchema.parse({
          status: 'failed',
          detail: 'The Local Checkout changed after this Pull Request was reviewed.'
        })
      }
    }
    return createPullRequestResultSchema.parse(
      await mainEffectRuntime.runPromise(pullRequests.create(session, input))
    )
  })

  handleInvoke(IPC_CHANNELS.openPullRequest, z.string().min(1), async (sessionId) => {
    const pullRequest = await pullRequestStore.read(sessionId)
    if (!pullRequest) throw new Error('This Session has no Pull Request to open')
    const url = new URL(pullRequest.url)
    if (url.protocol !== 'https:') throw new Error('Refused a non-HTTPS Pull Request link')
    await shell.openExternal(url.toString())
  })

  // Asking for a Review is explicit and costs the Session nothing: it runs on
  // a thread of its own, appends nothing to the Conversation, and is refused
  // the ability to change anything in the Checkout.
  handleInvoke(IPC_CHANNELS.getSessionReview, z.string().min(1), async (sessionId) =>
    reviewStateSchema.parse(await reviews.state(sessionId))
  )
  handleInvoke(IPC_CHANNELS.requestSessionReview, z.string().min(1), async (sessionId) =>
    reviewStateSchema.parse(await reviews.request(sessionId))
  )

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
      branch: await currentBranch(path),
      state: await observeCheckoutState(path)
    })
  })

  // Two calls, and nothing between them happens on its own (ADR 0010). Listing
  // reads the app's own worktrees directory and writes nothing; removing acts
  // on exactly the directories the person named after reading that list.
  // Neither is reached from Delete, from Archive, from quit, or from a timer.
  handleInvoke(IPC_CHANNELS.listProjectWorktrees, z.string().min(1), async (projectRoot) =>
    worktreeInventorySchema.parse(await worktreeReclaim.inventory(projectRoot))
  )
  handleInvoke(IPC_CHANNELS.removeWorktrees, removeWorktreesInputSchema, async (input) =>
    worktreeRemovalResultSchema.parse(await worktreeReclaim.remove(input))
  )

  // What creating isolated Checkouts here has cost, so ADR 0004's asserted
  // price of isolation can be checked rather than believed. One bounded file
  // on this machine, read and never sent: no request is made to answer this.
  handleInvoke(IPC_CHANNELS.getCheckoutCosts, z.undefined(), async () =>
    checkoutCostRecordSchema.parse(await checkoutCosts.read())
  )

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
  handleInvoke(IPC_CHANNELS.compactSession, compactSessionInputSchema, async (input) =>
    conversationSnapshotSchema.parse(await runService.compact(input))
  )
  handleInvoke(IPC_CHANNELS.rewindSession, rewindSessionInputSchema, async (input) =>
    conversationSnapshotSchema.parse(await runService.rewind(input))
  )
  handleInvoke(
    IPC_CHANNELS.enqueueQueuedSubmission,
    enqueueQueuedSubmissionInputSchema,
    async (input) =>
      conversationSnapshotSchema.parse(await runService.enqueueQueuedSubmission(input))
  )
  handleInvoke(IPC_CHANNELS.editQueuedSubmission, editQueuedSubmissionInputSchema, async (input) =>
    conversationSnapshotSchema.parse(await runService.editQueuedSubmission(input))
  )
  handleInvoke(IPC_CHANNELS.moveQueuedSubmission, moveQueuedSubmissionInputSchema, async (input) =>
    conversationSnapshotSchema.parse(await runService.moveQueuedSubmission(input))
  )
  handleInvoke(IPC_CHANNELS.cancelQueuedSubmission, queuedSubmissionIdentitySchema, async (input) =>
    conversationSnapshotSchema.parse(await runService.cancelQueuedSubmission(input))
  )
  handleInvoke(IPC_CHANNELS.pauseConversationQueue, z.string().min(1), async (sessionId) =>
    conversationSnapshotSchema.parse(await runService.pauseConversationQueue(sessionId))
  )
  handleInvoke(IPC_CHANNELS.resumeConversationQueue, z.string().min(1), async (sessionId) =>
    conversationSnapshotSchema.parse(await runService.resumeConversationQueue(sessionId))
  )
  handleInvoke(
    IPC_CHANNELS.sendQueuedSubmissionNow,
    queuedSubmissionIdentitySchema,
    async (input) =>
      conversationSnapshotSchema.parse(await runService.sendQueuedSubmissionNow(input))
  )
  handleInvoke(IPC_CHANNELS.resolveApproval, resolveApprovalInputSchema, async (input) =>
    conversationSnapshotSchema.parse(await runService.resolveApproval(input))
  )
  handleInvoke(IPC_CHANNELS.denyApprovals, denyApprovalsInputSchema, async (input) =>
    conversationSnapshotSchema.parse(await runService.denyApprovals(input))
  )

  // Two calls, deliberately. Preparing reads and writes nothing; applying is
  // the destructive half, and it revalidates before it does anything (ADR
  // 0006). Neither is reachable from ambient ⌘Z.
  handleInvoke(IPC_CHANNELS.prepareRunUndo, prepareRunUndoInputSchema, async (input) =>
    runUndoPreparationSchema.parse(await runUndo.prepare(input))
  )
  handleInvoke(IPC_CHANNELS.applyRunUndo, applyRunUndoInputSchema, async (input) =>
    runUndoApplicationSchema.parse(await runUndo.apply(input))
  )
}

/**
 * The directory one Project's isolated checkouts live under. Keyed by the
 * root itself, hashed, not by its folder name: two Projects called
 * `weather-app` in different places must not share a worktrees directory.
 * The basename stays in front so a person browsing the state directory can
 * still tell whose worktrees these are.
 *
 * Derived in one place because two things now depend on it agreeing with
 * itself: creating an isolated Checkout, and listing the ones already made.
 */
function worktreesDirectory(projectRoot: string): string {
  const digest = createHash('sha256').update(projectRoot).digest('hex').slice(0, 12)
  return join(app.getPath('userData'), 'worktrees', `${basename(projectRoot)}-${digest}`)
}

/**
 * Notes what one Checkout cost to become usable. Deliberately swallowing its
 * own failure: this is a local diagnostic, and a Session must never fail to
 * start because the file recording how long its Checkout took could not be
 * written.
 */
async function recordCheckoutCost(path: string, result: WorktreeBootstrapResult): Promise<void> {
  await checkoutCosts
    .recordBootstrap({ path, at: new Date().toISOString(), result })
    .catch(() => undefined)
}

function mergeBootstrapResults(
  previous: WorktreeBootstrapResult,
  retry: WorktreeBootstrapResult
): WorktreeBootstrapResult {
  const copied = [...new Set([...previous.copied, ...retry.copied])].sort()
  const retriedPaths = new Set([...retry.copied, ...retry.skipped.map((entry) => entry.path)])
  const skipped = [
    ...previous.skipped.filter((entry) => !retriedPaths.has(entry.path)),
    ...retry.skipped
  ].sort((left, right) => left.path.localeCompare(right.path, 'en'))
  // The origin belongs to the bootstrap, not to each attempt at it: a retry is
  // the same bootstrap answered again, so it only fills in an origin the first
  // attempt could not read. What it cost is the opposite — every attempt was
  // time the person spent waiting for this Checkout, so the attempts add up.
  return buildWorktreeBootstrapResult(copied, skipped, {
    provenance: previous.provenance ?? retry.provenance,
    durationMs:
      previous.durationMs === null && retry.durationMs === null
        ? null
        : (previous.durationMs ?? 0) + (retry.durationMs ?? 0)
  })
}

/**
 * What is installed for one Project, with the Project's own Skills offered
 * only once it has been trusted.
 */
async function skillsFor(projectRoot: string, harness: HarnessId): Promise<SkillCatalog> {
  // The same home readiness probes, so a test that installs Skills where it
  // says it did finds them there.
  const projects = projectViewSchema.array().parse(await coreClient.send({ type: 'project/list' }))
  const project = projects.find((entry) => entry.root === projectRoot)
  const observed = await observeProjectSkills(projectRoot)
  const checkedProject = project
    ? projectViewSchema.parse(
        await coreClient.send({
          type: 'project/observe-skills',
          root: projectRoot,
          digest: observed.status === 'ok' ? observed.digest : null
        })
      )
    : undefined
  if (observed.status === 'error') {
    return {
      ...(await discoverSkills({
        homeDirectory: harnessHomeDirectory(),
        projectRoot,
        harness,
        projectTrusted: false
      })),
      reviewedDigest: null,
      projectTrustError: observed.reason
    }
  }
  const projectTrusted =
    checkedProject?.skillsTrustedAt != null &&
    checkedProject.skillsTrustedDigest === observed.digest
  const changes = diffProjectSkillManifests(
    checkedProject?.skillsTrustedManifest ?? [],
    observed.manifest
  )
  return {
    ...(await discoverSkills({
      homeDirectory: harnessHomeDirectory(),
      projectRoot,
      harness,
      projectTrusted
    })),
    reviewedDigest: observed.digest,
    changes: projectTrusted ? { added: [], removed: [], changed: [] } : changes
  }
}

/**
 * Moments already told out loud, so the adapter's own completed/failed event
 * and the conclusion's do not become two notifications for one ending, and a
 * re-journaled request does not knock twice.
 */
const notifiedMoments = new Set<string>()

/**
 * Work arrives like mail. A Run ending — or stopping to ask permission —
 * while the window is elsewhere changes only a sidebar dot, so it is also
 * said the way the desktop says things: a quiet native notification, silent
 * by design, that opens the Session when clicked. The approval is the urgent
 * one — it is the state that blocks all progress, and it must reach the
 * person first, not last. A focused window needs none of this: the
 * Conversation is already telling the story.
 */
async function notifyWhileAway(streamed: ConversationStreamEvent): Promise<void> {
  const event = streamed.event
  if (event.type !== 'completed' && event.type !== 'failed' && event.type !== 'approval-request') {
    return
  }
  const moment =
    event.type === 'approval-request' ? `${streamed.runId}:${event.id}` : streamed.runId
  if (notifiedMoments.has(moment)) return
  notifiedMoments.add(moment)
  if (notifiedMoments.size > 500) notifiedMoments.clear()
  // Test runs must not post to the real Notification Center.
  if (testAppData && !app.isPackaged) return
  if (!mainWindow || mainWindow.isFocused() || !Notification.isSupported()) return
  const title = await coreClient
    .send({ type: 'session/get', sessionId: streamed.sessionId })
    .then((session) => sessionSummarySchema.parse(session).title)
    .catch(() => null)
  if (title === null) return
  const notification = new Notification({
    title,
    body:
      event.type === 'completed'
        ? 'The Run finished while you were away.'
        : event.type === 'failed'
          ? 'The Run failed. The Conversation says what is safe to do next.'
          : `Waiting for your approval: ${event.summary.slice(0, 120)}`,
    silent: true
  })
  notification.on('click', () => {
    const window = mainWindow
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    window.webContents.send(IPC_CHANNELS.openSessionRequest, streamed.sessionId)
  })
  notification.show()
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
    skipTaskbar: testBackground,
    titleBarStyle: 'hiddenInset',
    // Centered in the 44px title bar every surface draws (h-11): the macOS
    // buttons are 12px tall, so (44 − 12) / 2 from the top.
    trafficLightPosition: { x: 18, y: 16 },
    backgroundColor: windowBackground(),
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
  window.webContents.on('before-input-event', (event, input) => {
    const undo =
      input.type === 'keyDown' &&
      input.key.toLowerCase() === 'z' &&
      (input.meta || input.control) &&
      !input.shift
    if (undo) window.webContents.send(IPC_CHANNELS.undoShortcut)

    const toggleSidebar =
      input.type === 'keyDown' &&
      input.key.toLowerCase() === 's' &&
      (input.meta || input.control) &&
      !input.shift &&
      !input.alt
    if (toggleSidebar) {
      // Electron otherwise treats this as Save Page before the Renderer can
      // use it. Claiming it here also makes the shortcut independent of focus.
      event.preventDefault()
      window.webContents.send(IPC_CHANNELS.toggleSidebarShortcut)
    }
  })

  window.on('ready-to-show', () => {
    if (!testBackground) window.show()
  })
  window.on('close', (event) => {
    if (shutdownStarted) return
    event.preventDefault()
    requestQuit()
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  if (devServerUrl && !app.isPackaged) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(async () => {
  settings = new SettingsStore(app.getPath('userData'))
  readiness = new ReadinessService({
    settings,
    homeDir: harnessHomeDirectory(),
    testPathOverride:
      !app.isPackaged && testReadinessPath !== undefined ? testReadinessPath : undefined
  })
  snapshots = new SessionSnapshotStore(join(app.getPath('userData'), 'runs'))
  pullRequestStore = new PullRequestStore(join(app.getPath('userData'), 'runs'))
  checkoutCosts = new CheckoutCostStore(app.getPath('userData'))
  github = await mainEffectRuntime.runPromise(GitHubPullRequests.live)
  pullRequests = await mainEffectRuntime.runPromise(
    makePullRequestService({ github, store: pullRequestStore })
  )
  reviewStore = new ReviewStore(join(app.getPath('userData'), 'runs'))
  runService = new RunService({
    core: coreClient,
    snapshots,
    broker: new RunProcessBroker(mainEffectRuntime),
    readiness,
    homeDirectory: app.getPath('home'),
    privateRoot: join(app.getPath('userData'), 'runs'),
    proxyExecutable: process.execPath,
    proxyScript: unpackedPath(join(__dirname, 'mcp-proxy.js')),
    runEffect: (effect) => mainEffectRuntime.runPromise(effect),
    skills: skillsFor,
    // Assistant text and control events take the direct path to the window so
    // streaming stays responsive; durable projection follows behind it. A Run
    // ending away from a focused window is also told the desktop's way.
    onConversationEvent: (event) => {
      mainWindow?.webContents.send(IPC_CHANNELS.conversationEvent, event)
      void notifyWhileAway(event).catch(() => undefined)
    },
    // Whether the Checkout a Run was handed arrived usable. Nothing waits on
    // this and a failed write changes nothing the person is doing: it is a
    // note in a diagnostic file, and losing one entry costs a measurement.
    onRunCommandFinished: (checkout, command) => {
      void checkoutCosts.recordFirstCommand(checkout, command).catch(() => undefined)
    }
  })
  reviews = new ReviewService({
    core: coreClient,
    store: reviewStore,
    session: async (sessionId) =>
      sessionSummarySchema.parse(await coreClient.send({ type: 'session/get', sessionId })),
    // The Harness a Review is asked of is the one that has been answering in
    // this Session, so a Review is never a second opinion from a Harness the
    // person did not choose.
    harnessFor: async (sessionId) =>
      runSnapshotSchema
        .array()
        .parse(await coreClient.send({ type: 'run/list', sessionId }))
        .at(-1)?.configuration.harness ?? null,
    readiness,
    homeDirectory: app.getPath('home'),
    privateRoot: join(app.getPath('userData'), 'runs')
  })
  runUndo = new RunUndoService({
    store: snapshots,
    session: async (sessionId) =>
      sessionSummarySchema.parse(await coreClient.send({ type: 'session/get', sessionId })),
    recordAppAction: async (input) => {
      await coreClient.send({
        type: 'conversation/app-action',
        input: { ...input, action: 'run-undo' }
      })
    }
  })
  worktreeReclaim = new WorktreeReclaimService({
    directoryFor: worktreesDirectory,
    sessions: async () =>
      sessionSummarySchema.array().parse(await coreClient.send({ type: 'session/list' })),
    // Asked on every call rather than held: a Run can start between the person
    // opening the list and confirming what to remove from it.
    busyCheckouts: () => runService.activeCheckouts()
  })
  projectClones = new ProjectCloneService({
    runtime: mainEffectRuntime,
    hooksDirectory: join(app.getPath('userData'), 'clone-hooks'),
    resolveRoot: (path) => resolveProjectRoot(path),
    acceptProject,
    emit: (event) => {
      mainWindow?.webContents.send(
        IPC_CHANNELS.projectCloneEvent,
        projectCloneEventSchema.parse(event)
      )
    }
  })
  updates = new UpdateService({
    // From the bundle, which the packager wrote from the manifest — the same
    // identity packaging and signing use, read rather than restated.
    installedVersion: app.getVersion(),
    feedUrl: releaseFeedUrl(),
    releasePagePrefix: releasePagePrefix(),
    fetchImpl: testUpdateRelease === undefined ? undefined : answerUpdateFeedInTests,
    // A window that has been open for days is told without being reopened —
    // both when there is something to take and when there stops being.
    onChanged: (availability) => {
      mainWindow?.webContents.send(IPC_CHANNELS.updateAvailable, availability)
    }
  })
  servicesReady = true

  // Nothing is awaited here and nothing on screen waits for it: a check that
  // hangs or fails leaves the app exactly as it would have been without one.
  // Only a packaged build asks — running from source, the version in the
  // manifest is not a version anybody published a newer copy of.
  if (app.isPackaged || testUpdateRelease !== undefined) updates.start()

  // A Run the app never got to finish still has a record of what it changed
  // waiting to be compared (12e), and a Conversation that still has it open
  // (12g). Not awaited: nothing on screen depends on it, and a Run started
  // before it lands waits for it itself.
  void runService.recoverUnfinishedWork().catch(() => undefined)

  // Resolve appearance before any window exists so the first paint already
  // matches System, Light, or Dark.
  applyNativeThemeSource(settings.get().themePreference)

  hardenSession()
  coreClient.start()
  void coreClient
    .send({ type: 'session/list' })
    .then((sessions) =>
      Promise.all([
        pullRequestStore.pruneUnknown(known(sessions)),
        reviewStore.pruneUnknown(known(sessions))
      ])
    )
    .catch(() => undefined)
  registerIpc()

  // Keep both surfaces in step when the resolved appearance changes, whether
  // from macOS System appearance or an explicit preference change.
  nativeTheme.on('updated', () => {
    publishTheme()
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  requestQuit()
})

app.on('before-quit', (event) => {
  if (shutdownStarted) return
  event.preventDefault()
  requestQuit()
})

// Ctrl+C in `pnpm dev` already says to stop. Skip the product warning, but use
// the same verified process-group cleanup as every other exit path.
process.on('SIGINT', () => void beginSafeShutdown())

function requestQuit(): void {
  if (shutdownStarted) return
  if (!servicesReady) {
    app.exit(0)
    return
  }
  const activeRunCount = runService.activeRunCount()
  // Shell acceptance tests close their app in `finally`; individual warning
  // tests opt in so teardown never becomes an unanswered product prompt.
  const warningEnabledInThisProcess =
    !testAppData || app.isPackaged || process.env['APP_TEST_QUIT_WARNING'] === '1'
  if (
    activeRunCount > 0 &&
    warningEnabledInThisProcess &&
    settings.get().warnBeforeQuitWithActiveRuns
  ) {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (!testBackground) {
      mainWindow.show()
      mainWindow.focus()
    }
    if (!quitPromptOpen) {
      quitPromptOpen = true
      mainWindow.webContents.send(IPC_CHANNELS.quitRequested, activeRunCount)
    }
    return
  }
  void beginSafeShutdown()
}

async function beginSafeShutdown(): Promise<void> {
  if (shutdownStarted) return
  shutdownStarted = true
  updates.stop()
  await projectClones
    .cancelAll()
    .then(() => runService.stopAll('quit'))
    .then(() => mainEffectRuntime.dispose())
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
}
