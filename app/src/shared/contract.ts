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
import { sessionRelativePathSchema, type SessionRelativePath } from './portable-path'
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
  id: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** Path of the Session's folder relative to the library root. */
  relativePath: z.string().min(1),
  // Defaults keep summaries persisted before these fields existed readable.
  pinned: z.boolean().default(false),
  /** When set, the Session is archived in place; canonical files never move. */
  archivedAt: z.string().datetime().nullable().default(null)
})
export type SessionSummary = z.infer<typeof sessionSummarySchema>

export const managedDocumentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['root', 'conversation']),
  path: z.string().min(1)
})
export type ManagedDocument = z.infer<typeof managedDocumentSchema>

export const openedSessionSchema = z.object({
  session: sessionSummarySchema,
  documents: z.object({
    root: managedDocumentSchema,
    conversation: managedDocumentSchema
  })
})
export type OpenedSession = z.infer<typeof openedSessionSchema>

export const librarySnapshotSchema = z.object({
  path: z.string().min(1),
  sessions: z.array(sessionSummarySchema)
})
export type LibrarySnapshot = z.infer<typeof librarySnapshotSchema>

export { sessionRelativePathSchema }
export type { SessionRelativePath }

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
  /** Whether this answer required rebuilding the disposable search index. */
  index: z.enum(['ready', 'rebuilt']),
  groups: z.array(mailboxGroupSchema)
})
export type MailboxSnapshot = z.infer<typeof mailboxSnapshotSchema>

export const setSessionPinnedInputSchema = z.object({
  relativePath: z.string().min(1),
  pinned: z.boolean()
})
export type SetSessionPinnedInput = z.infer<typeof setSessionPinnedInputSchema>

export const setSessionArchivedInputSchema = z.object({
  relativePath: z.string().min(1),
  archived: z.boolean()
})
export type SetSessionArchivedInput = z.infer<typeof setSessionArchivedInputSchema>

export const deleteSessionPreviewSchema = z.object({
  relativePath: z.string().min(1),
  title: z.string().min(1),
  /** Library-relative app-owned paths that permanent delete moves to Trash. */
  targets: z.array(z.string().min(1)),
  /** Library-relative content inside the folder that is kept untouched. */
  keeps: z.array(z.string().min(1))
})
export type DeleteSessionPreview = z.infer<typeof deleteSessionPreviewSchema>

export const deleteSessionInputSchema = z.object({
  relativePath: z.string().min(1),
  /**
   * The exact previewed targets to move to Trash. Delete acts only on what
   * the person confirmed, so a retry after a partial failure can finish the
   * remaining targets even when the Session itself is no longer recognizable.
   */
  targets: z.array(z.string().min(1)).min(1)
})
export type DeleteSessionInput = z.infer<typeof deleteSessionInputSchema>

export const deleteSessionResultSchema = z.object({
  trashed: z.array(z.string().min(1)),
  failed: z.array(z.object({ path: z.string().min(1), message: z.string() }))
})
export type DeleteSessionResult = z.infer<typeof deleteSessionResultSchema>

export const captureSessionInputSchema = z.object({
  title: z.string().max(300),
  notes: z.string().max(100_000)
})
export type CaptureSessionInput = z.infer<typeof captureSessionInputSchema>

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
  theme: themeStateSchema,
  library: librarySnapshotSchema.nullable()
})
export type BootState = z.infer<typeof bootStateSchema>

export const chooseLibraryResultSchema = z.union([
  z.object({ canceled: z.literal(true) }),
  z.object({ canceled: z.literal(false), path: z.string().min(1) })
])
export type ChooseLibraryResult = z.infer<typeof chooseLibraryResultSchema>

export const coreErrorCodeSchema = z.enum([
  'LIBRARY_MISSING',
  'NOT_A_DIRECTORY',
  'NO_LIBRARY_OPEN',
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
  z.object({ type: z.literal('library/open'), path: z.string().min(1) }),
  z.object({ type: z.literal('session/capture'), input: captureSessionInputSchema }),
  z.object({ type: z.literal('session/open'), relativePath: sessionRelativePathSchema }),
  z.object({ type: z.literal('session/list') }),
  z.object({ type: z.literal('mailbox/query'), query: mailboxCoreQuerySchema }),
  z.object({
    type: z.literal('session/set-pinned'),
    relativePath: sessionRelativePathSchema,
    pinned: z.boolean()
  }),
  z.object({
    type: z.literal('session/set-archived'),
    relativePath: sessionRelativePathSchema,
    archived: z.boolean()
  }),
  z.object({ type: z.literal('session/delete-preview'), relativePath: sessionRelativePathSchema }),
  z.object({ type: z.literal('run/accept'), input: acceptRunInputSchema }),
  z.object({ type: z.literal('run/list'), relativePath: sessionRelativePathSchema }),
  z.object({ type: z.literal('run/event'), input: recordRunEventInputSchema }),
  z.object({ type: z.literal('conversation/get'), relativePath: sessionRelativePathSchema }),
  z.object({ type: z.literal('conversation/submit'), input: submitConversationMessageInputSchema }),
  z.object({
    type: z.literal('conversation/begin'),
    relativePath: sessionRelativePathSchema,
    runId: z.string().min(1),
    submissionId: z.string().min(1),
    harness: harnessIdSchema.optional(),
    skill: skillNameSchema.optional(),
    model: z.string().min(1).optional(),
    restorationNote: z.boolean().optional()
  }),
  z.object({
    type: z.literal('conversation/ingest'),
    relativePath: sessionRelativePathSchema,
    runId: z.string().min(1),
    harness: harnessIdSchema,
    chunk: z.string()
  }),
  z.object({
    type: z.literal('conversation/apply'),
    relativePath: sessionRelativePathSchema,
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
  /** Opens the native picker. Reads nothing and writes nothing. */
  chooseLibraryLocation(): Promise<ChooseLibraryResult>
  /** Opens (and remembers) the confirmed library location. */
  openLibrary(path: string): Promise<LibrarySnapshot>
  captureSession(input: CaptureSessionInput): Promise<SessionSummary>
  openSession(relativePath: SessionRelativePath): Promise<OpenedSession>
  listSessions(): Promise<SessionSummary[]>
  queryMailbox(query: MailboxQuery): Promise<MailboxSnapshot>
  setSessionPinned(input: SetSessionPinnedInput): Promise<SessionSummary>
  setSessionArchived(input: SetSessionArchivedInput): Promise<SessionSummary>
  /** Enumerates the exact app-owned targets before any permanent delete. */
  previewDeleteSession(relativePath: SessionRelativePath): Promise<DeleteSessionPreview>
  /** Moves only the previewed, confirmed app-owned targets to the macOS Trash. */
  deleteSessionPermanently(input: DeleteSessionInput): Promise<DeleteSessionResult>
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
  listRuns(relativePath: SessionRelativePath): Promise<RunSnapshot[]>
  stopRun(input: StopRunInput): Promise<RunSnapshot>
  /** The Session's permanent Conversation, including partial and recovery state. */
  getConversation(relativePath: SessionRelativePath): Promise<ConversationSnapshot>
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
export * from './readiness'
export * from './run'
