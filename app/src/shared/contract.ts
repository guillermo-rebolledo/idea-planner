import { z } from 'zod'
import {
  finalizeConversationRunInputSchema,
  harnessEventSchema,
  submitConversationMessageInputSchema,
  type ConversationSnapshot,
  type ConversationStreamEvent,
  type DevelopIdeaInput
} from './conversation'
import { providerIdSchema } from './readiness'
import type { ChooseExecutableResult, ProviderId, ReadinessSnapshot } from './readiness'
import { ideaRelativePathSchema, type IdeaRelativePath } from './portable-path'
import {
  acceptRunInputSchema,
  recordRunEventInputSchema,
  workflowSchema,
  type RunSnapshot,
  type StartRunInput,
  type StopRunInput
} from './run'

/**
 * The versioned contract shared by Core, Main, Preload, and Renderer.
 * Every payload crossing a process boundary is validated against these
 * schemas before it is acted on or presented.
 */
export const CONTRACT_VERSION = 1

export const ideaKindSchema = z.enum(['software', 'general'])
export type IdeaKind = z.infer<typeof ideaKindSchema>

export const ideaSummarySchema = z.object({
  id: z.string().min(1),
  kind: ideaKindSchema,
  title: z.string().min(1),
  status: z.literal('saved'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** Path of the Idea's folder relative to the Idea Library root. */
  relativePath: z.string().min(1),
  // Defaults keep summaries persisted before these fields existed readable.
  pinned: z.boolean().default(false),
  /** When set, the Idea is archived in place; canonical files never move. */
  archivedAt: z.string().datetime().nullable().default(null)
})
export type IdeaSummary = z.infer<typeof ideaSummarySchema>

export const managedDocumentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['root', 'planning-index', 'conversation']),
  path: z.string().min(1)
})
export type ManagedDocument = z.infer<typeof managedDocumentSchema>

export const openedIdeaSchema = z.object({
  idea: ideaSummarySchema,
  documents: z.object({
    root: managedDocumentSchema,
    planningIndex: managedDocumentSchema,
    conversation: managedDocumentSchema
  })
})
export type OpenedIdea = z.infer<typeof openedIdeaSchema>

export const librarySnapshotSchema = z.object({
  path: z.string().min(1),
  ideas: z.array(ideaSummarySchema)
})
export type LibrarySnapshot = z.infer<typeof librarySnapshotSchema>

export { ideaRelativePathSchema }
export type { IdeaRelativePath }

export const mailboxKindFilterSchema = z.enum(['all', 'software', 'general'])
export type MailboxKindFilter = z.infer<typeof mailboxKindFilterSchema>

export const mailboxViewSchema = z.enum(['active', 'archived'])
export type MailboxView = z.infer<typeof mailboxViewSchema>

/** The Renderer's mailbox request; Main adds the configured thresholds. */
export const mailboxQuerySchema = z.object({
  search: z.string().max(500),
  kind: mailboxKindFilterSchema,
  view: mailboxViewSchema
})
export type MailboxQuery = z.infer<typeof mailboxQuerySchema>

export const mailboxCoreQuerySchema = mailboxQuerySchema.extend({
  /** Days without activity after which a pinned Idea shows as Dormant. */
  dormantAfterDays: z.number().int().positive()
})
export type MailboxCoreQuery = z.infer<typeof mailboxCoreQuerySchema>

export const mailboxIdeaSchema = ideaSummarySchema.extend({
  dormant: z.boolean()
})
export type MailboxIdea = z.infer<typeof mailboxIdeaSchema>

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
  ideas: z.array(mailboxIdeaSchema)
})
export type MailboxGroup = z.infer<typeof mailboxGroupSchema>

export const mailboxSnapshotSchema = z.object({
  view: mailboxViewSchema,
  /** Ideas in this view before search and kind filters: 0 means truly empty. */
  total: z.number().int().nonnegative(),
  /** Ideas matching the search and filters across all groups. */
  matched: z.number().int().nonnegative(),
  /** Whether this answer required rebuilding the disposable search index. */
  index: z.enum(['ready', 'rebuilt']),
  groups: z.array(mailboxGroupSchema)
})
export type MailboxSnapshot = z.infer<typeof mailboxSnapshotSchema>

export const setIdeaPinnedInputSchema = z.object({
  relativePath: z.string().min(1),
  pinned: z.boolean()
})
export type SetIdeaPinnedInput = z.infer<typeof setIdeaPinnedInputSchema>

export const setIdeaArchivedInputSchema = z.object({
  relativePath: z.string().min(1),
  archived: z.boolean()
})
export type SetIdeaArchivedInput = z.infer<typeof setIdeaArchivedInputSchema>

export const deleteIdeaPreviewSchema = z.object({
  relativePath: z.string().min(1),
  title: z.string().min(1),
  /** Library-relative app-owned paths that permanent delete moves to Trash. */
  targets: z.array(z.string().min(1)),
  /** Library-relative content inside the folder that is kept untouched. */
  keeps: z.array(z.string().min(1))
})
export type DeleteIdeaPreview = z.infer<typeof deleteIdeaPreviewSchema>

export const deleteIdeaInputSchema = z.object({
  relativePath: z.string().min(1),
  /**
   * The exact previewed targets to move to Trash. Delete acts only on what
   * the person confirmed, so a retry after a partial failure can finish the
   * remaining targets even when the Idea itself is no longer recognizable.
   */
  targets: z.array(z.string().min(1)).min(1)
})
export type DeleteIdeaInput = z.infer<typeof deleteIdeaInputSchema>

export const deleteIdeaResultSchema = z.object({
  trashed: z.array(z.string().min(1)),
  failed: z.array(z.object({ path: z.string().min(1), message: z.string() }))
})
export type DeleteIdeaResult = z.infer<typeof deleteIdeaResultSchema>

export const captureIdeaInputSchema = z.object({
  kind: ideaKindSchema,
  title: z.string().max(300),
  notes: z.string().max(100_000)
})
export type CaptureIdeaInput = z.infer<typeof captureIdeaInputSchema>

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
  'IDEA_NOT_FOUND',
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
  z.object({ type: z.literal('idea/capture'), input: captureIdeaInputSchema }),
  z.object({ type: z.literal('idea/open'), relativePath: ideaRelativePathSchema }),
  z.object({ type: z.literal('idea/list') }),
  z.object({ type: z.literal('mailbox/query'), query: mailboxCoreQuerySchema }),
  z.object({
    type: z.literal('idea/set-pinned'),
    relativePath: ideaRelativePathSchema,
    pinned: z.boolean()
  }),
  z.object({
    type: z.literal('idea/set-archived'),
    relativePath: ideaRelativePathSchema,
    archived: z.boolean()
  }),
  z.object({ type: z.literal('idea/delete-preview'), relativePath: ideaRelativePathSchema }),
  z.object({ type: z.literal('run/accept'), input: acceptRunInputSchema }),
  z.object({ type: z.literal('run/list'), relativePath: ideaRelativePathSchema }),
  z.object({ type: z.literal('run/event'), input: recordRunEventInputSchema }),
  z.object({ type: z.literal('conversation/get'), relativePath: ideaRelativePathSchema }),
  z.object({ type: z.literal('conversation/submit'), input: submitConversationMessageInputSchema }),
  z.object({
    type: z.literal('conversation/begin'),
    relativePath: ideaRelativePathSchema,
    runId: z.string().min(1),
    submissionId: z.string().min(1),
    provider: providerIdSchema.optional(),
    workflow: workflowSchema.optional(),
    model: z.string().min(1).optional(),
    restorationNote: z.boolean().optional()
  }),
  z.object({
    type: z.literal('conversation/ingest'),
    relativePath: ideaRelativePathSchema,
    runId: z.string().min(1),
    provider: providerIdSchema,
    chunk: z.string()
  }),
  z.object({
    type: z.literal('conversation/apply'),
    relativePath: ideaRelativePathSchema,
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
export interface IdeaShellApi {
  getBootState(): Promise<BootState>
  /** Opens the native picker. Reads nothing and writes nothing. */
  chooseLibraryLocation(): Promise<ChooseLibraryResult>
  /** Opens (and remembers) the confirmed library location. */
  openLibrary(path: string): Promise<LibrarySnapshot>
  captureIdea(input: CaptureIdeaInput): Promise<IdeaSummary>
  openIdea(relativePath: IdeaRelativePath): Promise<OpenedIdea>
  listIdeas(): Promise<IdeaSummary[]>
  queryMailbox(query: MailboxQuery): Promise<MailboxSnapshot>
  setIdeaPinned(input: SetIdeaPinnedInput): Promise<IdeaSummary>
  setIdeaArchived(input: SetIdeaArchivedInput): Promise<IdeaSummary>
  /** Enumerates the exact app-owned targets before any permanent delete. */
  previewDeleteIdea(relativePath: IdeaRelativePath): Promise<DeleteIdeaPreview>
  /** Moves only the previewed, confirmed app-owned targets to the macOS Trash. */
  deleteIdeaPermanently(input: DeleteIdeaInput): Promise<DeleteIdeaResult>
  setThemePreference(preference: ThemePreference): Promise<ThemeState>
  onThemeChanged(listener: (theme: ThemeState) => void): () => void
  /** Returns the latest readiness snapshot, probing on first demand. */
  getReadiness(): Promise<ReadinessSnapshot>
  /** Re-probes one provider or all of them (“Check again”). */
  refreshReadiness(provider?: ProviderId): Promise<ReadinessSnapshot>
  /** Native picker for an explicit executable; the native probe still runs. */
  chooseProviderExecutable(provider: ProviderId): Promise<ChooseExecutableResult>
  /** Returns the provider to ordinary PATH resolution. */
  clearProviderExecutable(provider: ProviderId): Promise<ReadinessSnapshot>
  /** Grants or revokes the one-time login-shell discovery consent. */
  setLoginShellDiscovery(consent: boolean): Promise<ReadinessSnapshot>
  /** Opens one of the fixed readiness-guidance URLs in the default browser. */
  openExternalLink(url: string): Promise<void>
  startRun(input: StartRunInput): Promise<RunSnapshot>
  listRuns(relativePath: IdeaRelativePath): Promise<RunSnapshot[]>
  stopRun(input: StopRunInput): Promise<RunSnapshot>
  /** The Idea's permanent Conversation, including partial and recovery state. */
  getConversation(relativePath: IdeaRelativePath): Promise<ConversationSnapshot>
  /**
   * Accepts the user message durably, then starts one planning Run for it.
   * The message survives even when the Run never reaches the provider.
   */
  developIdea(input: DevelopIdeaInput): Promise<ConversationSnapshot>
  /** Assistant text and control events, delivered ahead of durable projection. */
  onConversationEvent(listener: (event: ConversationStreamEvent) => void): () => void
}

export { IPC_CHANNELS } from './channels'
export * from './conversation'
export * from './readiness'
export * from './run'
