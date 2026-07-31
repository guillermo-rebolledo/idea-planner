import { z } from 'zod'

/**
 * The versioned contract shared by Core, Main, Preload, and Renderer.
 * Every payload crossing a process boundary is validated against these
 * schemas before it is acted on or presented.
 */
export const CONTRACT_VERSION = 1

export const ideaKindSchema = z.enum(['software', 'general'])
export type IdeaKind = z.infer<typeof ideaKindSchema>

export const ideaOpenStateSchema = z.enum([
  'ready',
  'recovered',
  'read-only-newer-format',
  'unrecoverable-content'
])
export type IdeaOpenState = z.infer<typeof ideaOpenStateSchema>

export const ideaSummarySchema = z.object({
  id: z.string().min(1),
  kind: ideaKindSchema,
  title: z.string().min(1),
  status: z.literal('saved'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  openState: ideaOpenStateSchema,
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

export const reconciliationStatusSchema = z.enum([
  'ready',
  'changed',
  'conflict',
  'location-missing',
  'unsafe-path',
  'duplicate-identity',
  'offline',
  'sync-copy-ambiguous'
])
export type ReconciliationStatus = z.infer<typeof reconciliationStatusSchema>

export const reconcileIdeaInputSchema = z.object({
  relativePath: z.string().min(1),
  reason: z.enum(['opened', 'changed', 'atomic-replacement', 'overflow', 'missing-volume']),
  activeRun: z
    .object({
      id: z.string().min(1),
      documents: z.array(
        z.object({
          id: z.string().min(1),
          baselineHash: z.string().length(64),
          aiDraft: z.string()
        })
      )
    })
    .optional()
})
export type ReconcileIdeaInput = z.infer<typeof reconcileIdeaInputSchema>
export type ReconciliationReason = ReconcileIdeaInput['reason']

export const reconciledDocumentSchema = managedDocumentSchema.extend({
  hash: z.string().length(64),
  version: z.number().int().positive()
})
export type ReconciledDocument = z.infer<typeof reconciledDocumentSchema>

export const managedVersionSchema = z.object({
  documentId: z.string().min(1),
  version: z.number().int().positive(),
  hash: z.string().length(64),
  createdAt: z.string().datetime()
})
export type ManagedVersion = z.infer<typeof managedVersionSchema>

export const reconciliationStateSchema = z.object({
  status: reconciliationStatusSchema,
  documents: z.array(reconciledDocumentSchema),
  history: z.array(managedVersionSchema),
  conflicts: z.array(
    z.object({
      documentId: z.string().min(1),
      disk: z.string(),
      aiDraft: z.string(),
      choices: z.tuple([z.literal('keep-disk'), z.literal('keep-ai-draft')])
    })
  ),
  pausedRunId: z.string().nullable(),
  recoveryAction: z.literal('locate').nullable(),
  duplicateCandidates: z.array(
    z.object({
      documentId: z.string().min(1),
      paths: z.array(z.string().min(1)).min(2)
    })
  )
})
export type ReconciliationState = z.infer<typeof reconciliationStateSchema>

export const locateIdeaResultSchema = z.union([
  z.object({ canceled: z.literal(true) }),
  z.object({ canceled: z.literal(false), state: reconciliationStateSchema })
])
export type LocateIdeaResult = z.infer<typeof locateIdeaResultSchema>

export const restoreManagedVersionInputSchema = z.object({
  relativePath: z.string().min(1),
  documentId: z.string().min(1),
  version: z.number().int().positive()
})
export type RestoreManagedVersionInput = z.infer<typeof restoreManagedVersionInputSchema>

export const resolveManagedConflictInputSchema = z.object({
  relativePath: z.string().min(1),
  documentId: z.string().min(1),
  choice: z.enum(['keep-disk', 'keep-ai-draft']),
  aiDraft: z.string().optional()
})
export type ResolveManagedConflictInput = z.infer<typeof resolveManagedConflictInputSchema>

export const resolveDuplicateManagedDocumentInputSchema = z.object({
  relativePath: z.string().min(1),
  documentId: z.string().min(1),
  selectedPath: z.string().min(1)
})
export type ResolveDuplicateManagedDocumentInput = z.infer<
  typeof resolveDuplicateManagedDocumentInputSchema
>

export const referenceAttachmentSchema = z.object({
  id: z.string().min(1),
  messageId: z.string().min(1),
  sourcePath: z.string().min(1),
  safeName: z.string().min(1),
  sourceHash: z.string().length(64),
  mediaType: z.enum(['image/png', 'image/jpeg']),
  durablePath: z.string().nullable(),
  omitted: z.boolean()
})
export type ReferenceAttachment = z.infer<typeof referenceAttachmentSchema>
export const referenceAttachmentViewSchema = referenceAttachmentSchema
  .omit({ sourcePath: true })
  .extend({ availability: z.enum(['available', 'missing', 'kept', 'omitted']) })
export type ReferenceAttachmentView = z.infer<typeof referenceAttachmentViewSchema>

export const chooseReferenceAttachmentInputSchema = z.object({
  relativePath: z.string().min(1),
  messageId: z.string().min(1)
})
export const chooseReferenceAttachmentResultSchema = z.union([
  z.object({ canceled: z.literal(true) }),
  z.object({ canceled: z.literal(false), reference: referenceAttachmentViewSchema })
])
export type ChooseReferenceAttachmentResult = z.infer<typeof chooseReferenceAttachmentResultSchema>
export const referenceActionInputSchema = z.object({
  relativePath: z.string().min(1),
  referenceId: z.string().min(1)
})
export type ReferenceActionInput = z.infer<typeof referenceActionInputSchema>

export const openedIdeaSchema = z.object({
  idea: ideaSummarySchema,
  documents: z.object({
    root: managedDocumentSchema,
    planningIndex: managedDocumentSchema,
    conversation: managedDocumentSchema
  }),
  notice: z.string().nullable()
})
export type OpenedIdea = z.infer<typeof openedIdeaSchema>

export const librarySnapshotSchema = z.object({
  path: z.string().min(1),
  ideas: z.array(ideaSummarySchema)
})
export type LibrarySnapshot = z.infer<typeof librarySnapshotSchema>

export const ideaRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) => path !== '.' && path !== '..' && !path.includes('/') && !path.includes('\\'),
    'Expected a portable Idea folder reference'
  )
export type IdeaRelativePath = z.infer<typeof ideaRelativePathSchema>

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
  'UNRECOVERABLE_CONTENT',
  'INVALID_INPUT',
  'IO_ERROR'
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
  z.object({ type: z.literal('idea/reconcile'), input: reconcileIdeaInputSchema }),
  z.object({ type: z.literal('idea/reconciliation-latest'), relativePath: ideaRelativePathSchema }),
  z.object({
    type: z.literal('idea/locate'),
    relativePath: ideaRelativePathSchema,
    selectedDirectory: z.string().min(1),
    expectedIdeaId: z.string().min(1)
  }),
  z.object({ type: z.literal('idea/restore-version'), input: restoreManagedVersionInputSchema }),
  z.object({ type: z.literal('idea/resolve-conflict'), input: resolveManagedConflictInputSchema }),
  z.object({
    type: z.literal('idea/resolve-duplicate'),
    input: resolveDuplicateManagedDocumentInputSchema
  }),
  z.object({
    type: z.literal('run/reconciliation-end'),
    relativePath: ideaRelativePathSchema,
    runId: z.string().min(1)
  }),
  z.object({
    type: z.literal('reference/add'),
    relativePath: z.string().min(1),
    messageId: z.string().min(1),
    sourcePath: z.string().min(1)
  }),
  z.object({ type: z.literal('reference/list'), relativePath: z.string().min(1) }),
  z.object({ type: z.literal('reference/keep'), input: referenceActionInputSchema }),
  z.object({ type: z.literal('reference/continue-without'), input: referenceActionInputSchema }),
  z.object({
    type: z.literal('reference/locate'),
    input: referenceActionInputSchema.extend({ sourcePath: z.string().min(1) })
  }),
  z.object({
    type: z.literal('reference/prepare-context'),
    relativePath: z.string().min(1),
    runId: z.string().min(1),
    referenceIds: z.array(z.string().min(1))
  }),
  z.object({ type: z.literal('reference/remove-context'), contextId: z.string().min(1) })
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
  reconcileIdea(input: ReconcileIdeaInput): Promise<ReconciliationState>
  latestReconciliation(relativePath: IdeaRelativePath): Promise<ReconciliationState | null>
  locateIdea(relativePath: IdeaRelativePath): Promise<LocateIdeaResult>
  restoreManagedVersion(input: RestoreManagedVersionInput): Promise<ReconciliationState>
  resolveManagedConflict(input: ResolveManagedConflictInput): Promise<ReconciliationState>
  resolveDuplicateManagedDocument(
    relativePath: IdeaRelativePath,
    documentId: string
  ): Promise<LocateIdeaResult>
  chooseReferenceAttachment(
    input: z.infer<typeof chooseReferenceAttachmentInputSchema>
  ): Promise<ChooseReferenceAttachmentResult>
  listReferenceAttachments(relativePath: IdeaRelativePath): Promise<ReferenceAttachmentView[]>
  keepReferenceWithIdea(input: ReferenceActionInput): Promise<ReferenceAttachmentView>
  locateReferenceAttachment(input: ReferenceActionInput): Promise<ChooseReferenceAttachmentResult>
  continueWithoutReference(input: ReferenceActionInput): Promise<void>
  /** Moves only the previewed, confirmed app-owned targets to the macOS Trash. */
  deleteIdeaPermanently(input: DeleteIdeaInput): Promise<DeleteIdeaResult>
  setThemePreference(preference: ThemePreference): Promise<ThemeState>
  onThemeChanged(listener: (theme: ThemeState) => void): () => void
}

export { IPC_CHANNELS } from './channels'
