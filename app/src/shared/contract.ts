import { z } from 'zod'
import {
  finalizeConversationRunInputSchema,
  harnessEventSchema,
  submitConversationMessageInputSchema,
  type ConversationSnapshot,
  type ConversationStreamEvent,
  type DevelopSessionInput
} from './conversation'
import { harnessIdSchema } from './readiness'
import type { ChooseExecutableResult, HarnessId, ReadinessSnapshot } from './readiness'
import type { ChooseProjectResult, ProjectView } from './project'
import {
  acceptRunInputSchema,
  recordRunEventInputSchema,
  skillNameSchema,
  type RunSnapshot,
  type StartRunInput,
  type StopRunInput
} from './run'

/**
 * The versioned contract shared by Core, Main, Preload, and Renderer.
 * Every payload crossing a process boundary is validated against these
 * schemas before it is acted on or presented.
 */
export const CONTRACT_VERSION = 2

export const sessionSummarySchema = z.object({
  /** Opaque identity. A Session is app-owned state, never a path. */
  id: z.string().min(1),
  /** The Project this Session works against, by the root git resolved. */
  projectRoot: z.string().min(1),
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

export const mailboxSessionSchema = sessionSummarySchema.extend({
  dormant: z.boolean()
})
export type MailboxSession = z.infer<typeof mailboxSessionSchema>

export const mailboxGroupKeySchema = z.enum([
  'pinned',
  'needs-attention',
  'running',
  'recent',
  'archived'
])
export type MailboxGroupKey = z.infer<typeof mailboxGroupKeySchema>

export const mailboxGroupSchema = z.object({
  key: mailboxGroupKeySchema,
  sessions: z.array(mailboxSessionSchema)
})
export type MailboxGroup = z.infer<typeof mailboxGroupSchema>

export const mailboxSnapshotSchema = z.object({
  view: mailboxViewSchema,
  /** Sessions in this view before the search filter: 0 means truly empty. */
  total: z.number().int().nonnegative(),
  /** Sessions matching the search across all groups. */
  matched: z.number().int().nonnegative(),
  groups: z.array(mailboxGroupSchema)
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

export const startSessionInputSchema = z.object({
  /** The Project the Session works against, by the root git resolved. */
  projectRoot: z.string().min(1),
  /**
   * The message that starts the Session. A Session is created on send, so
   * there is no moment where one exists without the message that asked for it,
   * and the title is derived from it locally.
   */
  message: z.string().min(1).max(100_000)
})
export type StartSessionInput = z.infer<typeof startSessionInputSchema>

export const themePreferenceSchema = z.enum(['system', 'light', 'dark'])
export type ThemePreference = z.infer<typeof themePreferenceSchema>

export const resolvedThemeSchema = z.enum(['light', 'dark'])
export type ResolvedTheme = z.infer<typeof resolvedThemeSchema>

export const themeStateSchema = z.object({
  preference: themePreferenceSchema,
  resolved: resolvedThemeSchema
})
export type ThemeState = z.infer<typeof themeStateSchema>

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
  z.object({ type: z.literal('session/delete'), sessionId: z.string().min(1) }),
  z.object({ type: z.literal('run/accept'), input: acceptRunInputSchema }),
  z.object({ type: z.literal('run/list'), sessionId: z.string().min(1) }),
  z.object({ type: z.literal('run/event'), input: recordRunEventInputSchema }),
  z.object({ type: z.literal('conversation/get'), sessionId: z.string().min(1) }),
  z.object({ type: z.literal('conversation/submit'), input: submitConversationMessageInputSchema }),
  z.object({
    type: z.literal('conversation/begin'),
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    submissionId: z.string().min(1),
    harness: harnessIdSchema.optional(),
    skill: skillNameSchema.optional(),
    model: z.string().min(1).optional(),
    restorationNote: z.boolean().optional()
  }),
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
  z.object({ type: z.literal('conversation/finalize'), input: finalizeConversationRunInputSchema })
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
  listProjects(): Promise<ProjectView[]>
  /** Forgets the Project. The directory on disk is never touched. */
  removeProject(root: string): Promise<void>
  /**
   * Runs `git init` in a folder the user has just been offered it for, then
   * adds it. The only Git mutation the app performs.
   */
  initializeProject(path: string): Promise<ChooseProjectResult>
  confirmProject(root: string): Promise<ChooseProjectResult>
  /** Starts a Session against a Project. Nothing is written into the Project. */
  startSession(input: StartSessionInput): Promise<SessionSummary>
  listSessions(): Promise<SessionSummary[]>
  /** Ids whose record could not be read, so the loss can be shown rather than inferred. */
  listDamagedSessions(): Promise<string[]>
  queryMailbox(query: MailboxQuery): Promise<MailboxSnapshot>
  setSessionPinned(input: SetSessionPinnedInput): Promise<SessionSummary>
  setSessionArchived(input: SetSessionArchivedInput): Promise<SessionSummary>
  /** Forgets the Session and its history. The Project is never touched. */
  deleteSession(sessionId: string): Promise<void>
  setThemePreference(preference: ThemePreference): Promise<ThemeState>
  onThemeChanged(listener: (theme: ThemeState) => void): () => void
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
  /** Assistant text and control events, delivered ahead of durable projection. */
  onConversationEvent(listener: (event: ConversationStreamEvent) => void): () => void
}

export { IPC_CHANNELS } from './channels'
export * from './conversation'
export * from './project'
export * from './readiness'
export * from './run'
