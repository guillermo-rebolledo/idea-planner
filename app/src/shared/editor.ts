import { z } from 'zod'

/**
 * The places "Open in" can hand a Checkout to. The editors are the ones this
 * app knows how to detect and address on a Mac; Terminal and Finder are part
 * of the operating system and are always offered.
 */
export const editorIdSchema = z.enum(['cursor', 'vscode', 'zed', 'terminal', 'finder'])
export type EditorId = z.infer<typeof editorIdSchema>

export const detectedEditorSchema = z.object({
  id: editorIdSchema,
  /** What the person reads on the row, exactly as the app names itself. */
  name: z.string().min(1)
})
export type DetectedEditor = z.infer<typeof detectedEditorSchema>

/**
 * What "Open in" offers: the editors detected on this Mac, then the two the
 * system always has. `lastChoice` is what the chip itself opens — the menu
 * exists to change it.
 */
export const editorCatalogSchema = z.object({
  editors: z.array(detectedEditorSchema),
  lastChoice: editorIdSchema.nullable()
})
export type EditorCatalog = z.infer<typeof editorCatalogSchema>

export const openInEditorInputSchema = z.object({
  sessionId: z.string().min(1),
  editor: editorIdSchema
})
export type OpenInEditorInput = z.infer<typeof openInEditorInputSchema>
