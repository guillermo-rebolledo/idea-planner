import { z } from 'zod'
import {
  codexLaunchSchema,
  harnessEventSchema,
  queuedSubmissionChangeSchema,
  queuedSubmissionLaunchObservationSchema,
  recordAppActionInputSchema,
  runRequestSchema,
  submitConversationMessageInputSchema,
  type ConversationSnapshot,
  type ConversationStreamEvent,
  type DevelopSessionInput,
  type EditQueuedSubmissionInput,
  type EnqueueQueuedSubmissionInput,
  type MoveQueuedSubmissionInput,
  type QueuedSubmissionIdentity
} from './conversation'
import {
  grantStandingApprovalInputSchema,
  revokeStandingApprovalInputSchema,
  type RevokeStandingApprovalInput,
  type StandingApproval
} from './approval'
import type { ListSkillsInput, SkillCatalog, TrustProjectSkillsInput } from './skill'
import type { ModelCatalog } from './model'
import { harnessIdSchema } from './readiness'
import type { ChooseExecutableResult, HarnessId, ReadinessSnapshot } from './readiness'
import { projectSkillsTrustSchema, type ChooseProjectResult, type ProjectView } from './project'
import {
  checkoutRequestSchema,
  checkoutSchema,
  checkoutStateSchema,
  LOCAL_CHECKOUT,
  type BranchList,
  type CheckoutFacts,
  worktreeBootstrapResultSchema
} from './checkout'
import { completeRunLifecycleInputSchema, openRunLifecycleInputSchema } from './run-lifecycle'
import type { EditorCatalog, OpenInEditorInput } from './editor'
import type {
  ApplyRunUndoInput,
  PrepareRunUndoInput,
  RunUndoApplication,
  RunUndoPreparation
} from './run-undo'
import {
  recordRunEventInputSchema,
  type ResolveApprovalInput,
  type RunSnapshot,
  type StartRunInput,
  type StopRunInput
} from './run'
import { pullRequestSchema } from './pull-request'
import {
  appearanceSettingsSchema,
  resolvedThemeSchema,
  themePaletteSchema,
  themePreferenceSchema,
  type AppearanceSettings,
  type ResolvedTheme,
  type ThemePreference
} from './theme'
import type {
  CreatePullRequestInput,
  CreatePullRequestResult,
  PreparePullRequestInput,
  PreparePullRequestResult
} from './pull-request'

/**
 * The versioned contract shared by Core, Main, Preload, and Renderer.
 * Every payload crossing a process boundary is validated against these
 * schemas before it is acted on or presented.
 *
 * Bump this whenever a payload changes shape. The halves of the app are built
 * together but do not have to be running together — `electron-vite dev`
 * reloads the Renderer and leaves Main as it was — and this number is what
 * lets the Renderer notice before it acts on an answer it cannot read.
 *
 * 20: appearance settings include persisted presets and a derived custom palette.
 * 19: Settings exposes the persisted quit-warning preference to the Renderer.
 * 18: isolated Sessions can publish a reviewed draft through the user's `gh`,
 *     and mailbox rows carry the separately observed Pull Request state.
 * 17: a Run can be undone from app-owned Git snapshots, and the Files
 *     projection says which of its rows have been put back.
 * 16: messages and Queued Submissions carry Review Attachments — the exact
 *     reviewed code, snapshotted when it was selected.
 * 15: Conversation pushes carry explicit Mailbox lifecycle invalidation.
 * 14: deep Run lifecycle opening and terminal observations cross the boundary.
 * 13: isolated Checkout bootstrap results and retry/continue cross the boundary.
 * 12: the window can answer Main's active-Run quit warning.
 * 11: Checkout facts include the currently observed Checkout State.
 * 10: Project-wide Skill trust is bound to a reviewed content digest.
 * 9: Queued Submissions and queue state are durable Conversation projections.
 * 8: the Conversation stream carries app-owned Run start and stop boundaries.
 * 7: starting a Session answers with the Session *and* whether its first Run
 *    started, where it used to answer with the Session alone.
 */
export const CONTRACT_VERSION = 20

export const sessionSummarySchema = z.object({
  /** Opaque identity. A Session is app-owned state, never a path. */
  id: z.string().min(1),
  /** The Project this Session works against, by the root git resolved. */
  projectRoot: z.string().min(1),
  /**
   * Where the work happens: the Project's working copy, or an isolated
   * worktree. Fixed at creation; Sessions from before the field existed were
   * all working copies, which is exactly what the default says.
   */
  checkout: checkoutSchema.default(LOCAL_CHECKOUT),
  /** Filenames and outcomes from preparing an isolated Checkout; never contents. */
  worktreeBootstrap: worktreeBootstrapResultSchema.nullable().default(null),
  title: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  pinned: z.boolean().default(false),
  /** When set, the Session is archived; nothing about it moves. */
  archivedAt: z.string().datetime().nullable().default(null)
})
export type SessionSummary = z.infer<typeof sessionSummarySchema>

export const mailboxViewSchema = z.enum(['active', 'archived'])
export type MailboxView = z.infer<typeof mailboxViewSchema>

/** The Renderer's mailbox request; Main adds the configured thresholds. */
export const mailboxQuerySchema = z.object({
  search: z.string().max(500),
  view: mailboxViewSchema
})
export type MailboxQuery = z.infer<typeof mailboxQuerySchema>

export const mailboxCoreQuerySchema = mailboxQuerySchema.extend({
  /** Days without activity after which a pinned Session shows as Dormant. */
  dormantAfterDays: z.number().int().positive()
})
export type MailboxCoreQuery = z.infer<typeof mailboxCoreQuerySchema>

/**
 * What a Session is doing, derived from its Conversation rather than stored:
 * the Conversation is the truth, and a status written beside it is one that
 * can disagree with it.
 *
 * `blocked` is the one that earns the inbox its keep — the agent is mid-Run
 * and cannot proceed without an answer. A Session whose agent replied and
 * stopped is `idle`, and calling that blocked would put every quiet Session in
 * the group and make it worth nothing.
 */
export const sessionStatusSchema = z.enum(['running', 'blocked', 'idle', 'failed'])
export type SessionStatus = z.infer<typeof sessionStatusSchema>

export const mailboxSessionSchema = sessionSummarySchema.extend({
  dormant: z.boolean(),
  status: sessionStatusSchema,
  /** What it is waiting for, when it is waiting on the person. */
  waitingFor: z.enum(['approval', 'question']).nullable().default(null),
  /** Remote GitHub state, stored and allowed to be stale; never Session status. */
  pullRequest: pullRequestSchema.nullable().default(null)
})
export type MailboxSession = z.infer<typeof mailboxSessionSchema>

/**
 * A Project with its Sessions nested underneath. The sidebar groups by
 * Project, so rows never re-shuffle between groups as Runs start and stop:
 * what a Session is doing is a dot on its row, not an address.
 */
export const mailboxProjectSchema = z.object({
  root: z.string().min(1),
  name: z.string().min(1),
  /**
   * False when the directory is gone, or when the Project itself was removed
   * and only its Sessions remain to name it.
   */
  available: z.boolean(),
  sessions: z.array(mailboxSessionSchema)
})
export type MailboxProject = z.infer<typeof mailboxProjectSchema>

export const mailboxSnapshotSchema = z.object({
  view: mailboxViewSchema,
  /** Sessions in this view before the search filter: 0 means truly empty. */
  total: z.number().int().nonnegative(),
  /** Sessions matching the search across all groups. */
  matched: z.number().int().nonnegative(),
  /** Pinned Sessions on top, still nested under the Project that owns them. */
  pinned: z.array(mailboxProjectSchema),
  /** Every Project the app has, then any that only Sessions still name. */
  projects: z.array(mailboxProjectSchema),
  /** Archived Sessions across every Project, regardless of view or search. */
  archivedTotal: z.number().int().nonnegative()
})
export type MailboxSnapshot = z.infer<typeof mailboxSnapshotSchema>

export const setSessionPinnedInputSchema = z.object({
  sessionId: z.string().min(1),
  pinned: z.boolean()
})
export type SetSessionPinnedInput = z.infer<typeof setSessionPinnedInputSchema>

export const setSessionArchivedInputSchema = z.object({
  sessionId: z.string().min(1),
  archived: z.boolean()
})
export type SetSessionArchivedInput = z.infer<typeof setSessionArchivedInputSchema>

export const renameSessionInputSchema = z.object({
  sessionId: z.string().min(1),
  /** The person's own words for the Session, replacing the derived title. */
  title: z.string().trim().min(1).max(200)
})
export type RenameSessionInput = z.infer<typeof renameSessionInputSchema>

export const startSessionInputSchema = z.object({
  /** The Project the Session works against, by the root git resolved. */
  projectRoot: z.string().min(1),
  /**
   * The message that starts the Session. A Session is created on send, so
   * there is no moment where one exists without the message that asked for it,
   * and the title is derived from it locally.
   */
  message: z.string().min(1).max(100_000),
  /** Where the Session works. Absent means the Project's working copy. */
  checkout: checkoutSchema.default(LOCAL_CHECKOUT),
  /** Main's result from preparing an isolated Checkout, when one was created. */
  worktreeBootstrap: worktreeBootstrapResultSchema.nullable().default(null)
})
/** The caller's side of the schema, so an omitted checkout stays omittable. */
export type StartSessionInput = z.input<typeof startSessionInputSchema>

/**
 * What the composer sends. The checkout may still be an ask (`isolated`);
 * Main settles it into a real Checkout before Core hears anything — Core only
 * ever stores directories that exist.
 */
export const startSessionRequestSchema = startSessionInputSchema.extend({
  checkout: checkoutRequestSchema.default({ kind: 'local' }),
  /**
   * How the starting message is answered. Present is the ordinary case: the
   * launch screen chooses a model and a Permission Mode, and sending both
   * creates the Session and starts its first Run. Absent creates the Session
   * with its message unanswered, which is all a caller with no Harness to
   * choose from can ask for.
   */
  run: runRequestSchema.optional()
})
export type StartSessionRequest = z.input<typeof startSessionRequestSchema>

/**
 * What sending on the launch screen produced. A local Session reports its Run
 * separately because the two can part ways. An isolated Checkout is settled
 * first, so a precise typed refusal can return before a Session exists.
 */
export const startedSessionResultSchema = z.object({
  status: z.literal('started'),
  session: sessionSummarySchema,
  /** False when no Run was asked for, and when the one asked for failed. */
  runStarted: z.boolean()
})
export type StartedSessionResult = z.infer<typeof startedSessionResultSchema>

export const resumeWorktreeBootstrapInputSchema = z.object({
  token: z.string().uuid(),
  decision: z.enum(['retry', 'continue'])
})
export type ResumeWorktreeBootstrapInput = z.infer<typeof resumeWorktreeBootstrapInputSchema>

export const startSessionResultSchema = z.discriminatedUnion('status', [
  startedSessionResultSchema,
  z.object({
    status: z.literal('bootstrap-incomplete'),
    token: z.string().uuid(),
    result: worktreeBootstrapResultSchema
  }),
  z.object({
    status: z.literal('blocked'),
    action: z.literal('create-worktree'),
    state: checkoutStateSchema
  }),
  z.object({
    status: z.literal('refused'),
    action: z.literal('create-worktree'),
    reason: z.enum(['git-unavailable', 'not-a-repository'])
  }),
  z.object({
    status: z.literal('failed'),
    action: z.literal('create-worktree'),
    message: z.string().min(1).max(500)
  })
])
export type StartSessionResult = z.infer<typeof startSessionResultSchema>

export { appearanceSettingsSchema, resolvedThemeSchema, themePreferenceSchema }
export type { AppearanceSettings, ResolvedTheme, ThemePreference }

export const themeStateSchema = z.object({
  preference: themePreferenceSchema,
  resolved: resolvedThemeSchema,
  palette: themePaletteSchema.nullable().default(null)
})
export type ThemeState = z.infer<typeof themeStateSchema>

export const quitRequestResponseSchema = z.enum(['keep-working', 'quit', 'always-quit'])
export type QuitRequestResponse = z.infer<typeof quitRequestResponseSchema>

export const bootStateSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  appVersion: z.string(),
  theme: themeStateSchema
})
export type BootState = z.infer<typeof bootStateSchema>

export const coreErrorCodeSchema = z.enum([
  'SESSION_NOT_FOUND',
  'INVALID_INPUT',
  'IO_ERROR',
  'RUN_NOT_FOUND',
  'SUPERVISION_FAILED'
])
export type CoreErrorCode = z.infer<typeof coreErrorCodeSchema>

export class CoreError extends Error {
  constructor(
    readonly code: CoreErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CoreError'
  }
}

/** Commands Main may send to the Core utility process. */
export const coreCommandSchema = z.discriminatedUnion('type', [
  // Main probes with git and hands over the resolved root; Core decides
  // identity, duplication, and persistence (ADR 0005).
  z.object({ type: z.literal('project/add'), root: z.string().min(1) }),
  z.object({ type: z.literal('project/list') }),
  z.object({ type: z.literal('project/remove'), root: z.string().min(1) }),
  z.object({
    type: z.literal('project/trust-skills'),
    root: z.string().min(1),
    trust: projectSkillsTrustSchema.nullable()
  }),
  z.object({
    type: z.literal('project/observe-skills'),
    root: z.string().min(1),
    digest: z.string().length(64).nullable()
  }),
  z.object({ type: z.literal('approval/grant'), input: grantStandingApprovalInputSchema }),
  z.object({ type: z.literal('approval/list'), projectRoot: z.string().min(1) }),
  z.object({
    type: z.literal('approval/rules'),
    projectRoot: z.string().min(1),
    harness: harnessIdSchema
  }),
  z.object({ type: z.literal('approval/revoke'), input: revokeStandingApprovalInputSchema }),
  z.object({ type: z.literal('session/start'), input: startSessionInputSchema }),
  z.object({ type: z.literal('session/list') }),
  z.object({ type: z.literal('session/list-damaged') }),
  z.object({ type: z.literal('session/get'), sessionId: z.string().min(1) }),
  z.object({ type: z.literal('mailbox/query'), query: mailboxCoreQuerySchema }),
  z.object({
    type: z.literal('session/set-pinned'),
    sessionId: z.string().min(1),
    pinned: z.boolean()
  }),
  z.object({
    type: z.literal('session/set-archived'),
    sessionId: z.string().min(1),
    archived: z.boolean()
  }),
  z.object({ type: z.literal('session/rename'), input: renameSessionInputSchema }),
  z.object({ type: z.literal('session/delete'), sessionId: z.string().min(1) }),
  z.object({ type: z.literal('run/lifecycle-open'), input: openRunLifecycleInputSchema }),
  z.object({ type: z.literal('run/lifecycle-complete'), input: completeRunLifecycleInputSchema }),
  z.object({ type: z.literal('run/list'), sessionId: z.string().min(1) }),
  z.object({ type: z.literal('run/event'), input: recordRunEventInputSchema }),
  z.object({ type: z.literal('conversation/get'), sessionId: z.string().min(1) }),
  z.object({ type: z.literal('conversation/submit'), input: submitConversationMessageInputSchema }),
  z.object({ type: z.literal('conversation/app-action'), input: recordAppActionInputSchema }),
  z.object({ type: z.literal('conversation/queue-change'), input: queuedSubmissionChangeSchema }),
  z.object({ type: z.literal('conversation/queue-next'), sessionId: z.string().min(1) }),
  z.object({
    type: z.literal('conversation/queue-launch-observed'),
    input: queuedSubmissionLaunchObservationSchema
  }),
  z.object({
    type: z.literal('harness/open'),
    runId: z.string().min(1),
    harness: harnessIdSchema,
    launch: codexLaunchSchema.optional()
  }),
  z.object({
    type: z.literal('harness/answer'),
    runId: z.string().min(1),
    approvalId: z.string().min(1).max(200),
    allow: z.boolean(),
    remember: z.boolean()
  }),
  z.object({ type: z.literal('harness/interrupt'), runId: z.string().min(1) }),
  z.object({
    type: z.literal('conversation/ingest'),
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    harness: harnessIdSchema,
    chunk: z.string()
  }),
  z.object({
    type: z.literal('conversation/apply'),
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    event: harnessEventSchema
  }),
  z.object({ type: z.literal('conversation/unfinished') })
])
export type CoreCommand = z.infer<typeof coreCommandSchema>

export const coreRequestSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  id: z.string().min(1),
  command: coreCommandSchema
})
export type CoreRequest = z.infer<typeof coreRequestSchema>

export const coreResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  id: z.string().min(1),
  outcome: z.union([
    z.object({ ok: z.literal(true), result: z.unknown() }),
    z.object({
      ok: z.literal(false),
      error: z.object({ code: coreErrorCodeSchema, message: z.string() })
    })
  ])
})
export type CoreResponse = z.infer<typeof coreResponseSchema>

/** The complete surface Preload exposes to the sandboxed Renderer. */
export interface ShellApi {
  getBootState(): Promise<BootState>
  /**
   * Opens the native picker and offers the chosen folder as a Project. Git
   * decides whether it qualifies and what its root is.
   */
  chooseProject(): Promise<ChooseProjectResult>
  /**
   * Offers a folder the person already named — dropped onto the window — as
   * a Project. The same probing as `chooseProject`, without the picker.
   */
  offerProject(path: string): Promise<ChooseProjectResult>
  /**
   * The absolute path of a file the person dragged in. Synchronous and local
   * to Preload: the path never exists in the Renderer until the person hands
   * the app the file that carries it.
   */
  pathForFile(file: File): string
  listProjects(): Promise<ProjectView[]>
  /**
   * Forgets the Project, and with it the Standing Approvals it owned. The
   * directory on disk is never touched.
   */
  removeProject(root: string): Promise<void>
  /**
   * The methodologies available for a Run in this Project, and the Project's
   * own that are waiting to be trusted.
   */
  listSkills(input: ListSkillsInput): Promise<SkillCatalog>
  /**
   * The models each usable Harness can be asked for, grouped by the Harness
   * that reaches them. Choosing a model chooses a Harness, so the groups are
   * the only Harness selector there is (ticket 13).
   */
  listModels(): Promise<ModelCatalog>
  /** Offers this Project's own Skills, or stops offering them. */
  trustProjectSkills(input: TrustProjectSkillsInput): Promise<SkillCatalog>
  /** What this Project has permanently allowed, newest grant last. */
  listStandingApprovals(projectRoot: string): Promise<StandingApproval[]>
  /** Takes one back. The next Run in that Project asks about it again. */
  revokeStandingApproval(input: RevokeStandingApprovalInput): Promise<void>
  /**
   * Runs `git init` in a folder the user has just been offered it for, then
   * adds it. One of the app's explicit Git mutations; the other is publishing
   * an isolated Checkout (ADR 0007).
   */
  initializeProject(path: string): Promise<ChooseProjectResult>
  confirmProject(root: string): Promise<ChooseProjectResult>
  /**
   * Starts a Session against a Project. Nothing is written into the Project —
   * except when an isolated checkout is asked for, in which case its linked
   * worktree and branch are created before the Session is.
   */
  startSession(input: StartSessionRequest): Promise<StartSessionResult>
  /** Retries eligible files, or keeps the Checkout as-is and starts the Session. */
  resumeWorktreeBootstrap(input: ResumeWorktreeBootstrapInput): Promise<StartSessionResult>
  listSessions(): Promise<SessionSummary[]>
  /** Ids whose record could not be read, so the loss can be shown rather than inferred. */
  listDamagedSessions(): Promise<string[]>
  queryMailbox(query: MailboxQuery): Promise<MailboxSnapshot>
  setSessionPinned(input: SetSessionPinnedInput): Promise<SessionSummary>
  setSessionArchived(input: SetSessionArchivedInput): Promise<SessionSummary>
  /** Gives the Session the person's own title. */
  renameSession(input: RenameSessionInput): Promise<SessionSummary>
  /** Forgets the Session and its history. The Project is never touched. */
  deleteSession(sessionId: string): Promise<void>
  getAppearanceSettings(): Promise<AppearanceSettings>
  setAppearanceSettings(settings: AppearanceSettings): Promise<ThemeState>
  onThemeChanged(listener: (theme: ThemeState) => void): () => void
  /** Whether quitting with active Runs asks first. Cleanup always runs either way. */
  getQuitWarningPreference(): Promise<boolean>
  setQuitWarningPreference(enabled: boolean): Promise<boolean>
  /** Answers the in-app warning raised by a native or terminal quit request. */
  respondToQuitRequest(response: QuitRequestResponse): Promise<void>
  onQuitRequested(listener: (activeRunCount: number) => void): () => void
  /**
   * ⌘Z, delivered from Main: the application menu's Undo consumes the key
   * before the page sees it, so the Renderer is told instead. Fires for every
   * press — the listener decides whether anything of its own is undoable.
   */
  onUndoShortcut(listener: () => void): () => void
  /** ⌘S (Ctrl+S elsewhere), claimed from the native Save action by Main. */
  onToggleSidebarShortcut(listener: () => void): () => void
  /** Returns the latest readiness snapshot, probing on first demand. */
  getReadiness(): Promise<ReadinessSnapshot>
  /** Re-probes one Harness or all of them (“Check again”). */
  refreshReadiness(harness?: HarnessId): Promise<ReadinessSnapshot>
  /** Native picker for an explicit executable; the native probe still runs. */
  chooseHarnessExecutable(harness: HarnessId): Promise<ChooseExecutableResult>
  /** Returns the Harness to ordinary PATH resolution. */
  clearHarnessExecutable(harness: HarnessId): Promise<ReadinessSnapshot>
  /** Grants or revokes the one-time login-shell discovery consent. */
  setLoginShellDiscovery(consent: boolean): Promise<ReadinessSnapshot>
  /** Opens one of the fixed readiness-guidance URLs in the default browser. */
  openExternalLink(url: string): Promise<void>
  /** Prepares editable publishing prose without changing Git or contacting a Harness. */
  preparePullRequest(input: PreparePullRequestInput): Promise<PreparePullRequestResult>
  /** Explicitly commits and pushes an isolated Checkout, then creates its GitHub PR. */
  createPullRequest(input: CreatePullRequestInput): Promise<CreatePullRequestResult>
  /** Opens the stored PR for this Session; the Renderer never supplies a privileged URL. */
  openPullRequest(sessionId: string): Promise<void>
  startRun(input: StartRunInput): Promise<RunSnapshot>
  listRuns(sessionId: string): Promise<RunSnapshot[]>
  stopRun(input: StopRunInput): Promise<RunSnapshot>
  /** The Session's permanent Conversation, including partial and recovery state. */
  getConversation(sessionId: string): Promise<ConversationSnapshot>
  /**
   * Accepts the user message durably, then starts one Run for it. The message
   * survives even when the Run never reaches the Harness.
   */
  developSession(input: DevelopSessionInput): Promise<ConversationSnapshot>
  /** Adds a captured submission to the Session-owned durable queue. */
  enqueueQueuedSubmission(input: EnqueueQueuedSubmissionInput): Promise<ConversationSnapshot>
  editQueuedSubmission(input: EditQueuedSubmissionInput): Promise<ConversationSnapshot>
  moveQueuedSubmission(input: MoveQueuedSubmissionInput): Promise<ConversationSnapshot>
  cancelQueuedSubmission(input: QueuedSubmissionIdentity): Promise<ConversationSnapshot>
  pauseConversationQueue(sessionId: string): Promise<ConversationSnapshot>
  resumeConversationQueue(sessionId: string): Promise<ConversationSnapshot>
  sendQueuedSubmissionNow(input: QueuedSubmissionIdentity): Promise<ConversationSnapshot>
  /**
   * Answers the approval a Run is blocked on. Approving lets the agent
   * proceed; denying hands it the message and it carries on without.
   */
  resolveApproval(input: ResolveApprovalInput): Promise<ConversationSnapshot>
  /**
   * What undoing a Run would mean right now: every path it changed, how each
   * one stands against what the Run left there, and the inverse patch. Reads
   * only — nothing is written until the operation it answers with is applied.
   */
  prepareRunUndo(input: PrepareRunUndoInput): Promise<RunUndoPreparation>
  /**
   * Carries out a reviewed restoration. The tree is measured again first, so a
   * review the world has moved past is refused without touching a file.
   */
  applyRunUndo(input: ApplyRunUndoInput): Promise<RunUndoApplication>
  /** Assistant text and control events, delivered ahead of durable projection. */
  onConversationEvent(listener: (event: ConversationStreamEvent) => void): () => void
  /**
   * Main asking the window to open one Session — the click on a native
   * notification for a Run that finished while the person was elsewhere.
   */
  onOpenSessionRequest(listener: (sessionId: string) => void): () => void
  /**
   * The "where am I?" facts for one Session: its Checkout, the directory that
   * names, and the branch it is on right now. Observed on each ask — the
   * branch can be moved by the agent or by the person in a terminal.
   */
  getCheckoutFacts(sessionId: string): Promise<CheckoutFacts>
  /**
   * The Project's local branches, most recently committed first, for choosing
   * an isolated checkout's base. Observed on each ask.
   */
  listBranches(projectRoot: string): Promise<BranchList>
  /** What "Open in" can offer on this Mac, and what was chosen last. */
  listEditors(): Promise<EditorCatalog>
  /**
   * Opens the Session's Checkout in the named editor and remembers the
   * choice, so the chip itself opens the right thing next time.
   */
  openInEditor(input: OpenInEditorInput): Promise<EditorCatalog>
}

export { IPC_CHANNELS } from './channels'
export * from './approval'
export * from './checkout'
export * from './editor'
export * from './skill'
export * from './conversation'
export * from './model'
export * from './project'
export * from './pull-request'
export * from './readiness'
export * from './review-attachment'
export * from './run'
export * from './run-undo'
