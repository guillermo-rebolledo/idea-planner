import { z } from 'zod'

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
  relativePath: z.string().min(1)
})
export type IdeaSummary = z.infer<typeof ideaSummarySchema>

export const librarySnapshotSchema = z.object({
  path: z.string().min(1),
  ideas: z.array(ideaSummarySchema)
})
export type LibrarySnapshot = z.infer<typeof librarySnapshotSchema>

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
  z.object({ type: z.literal('idea/list') })
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
  listIdeas(): Promise<IdeaSummary[]>
  setThemePreference(preference: ThemePreference): Promise<ThemeState>
  onThemeChanged(listener: (theme: ThemeState) => void): () => void
}

export { IPC_CHANNELS } from './channels'
