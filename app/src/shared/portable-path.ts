import { z } from 'zod'

/** One portable Idea folder reference, with no path traversal or separators. */
export const ideaRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) => path !== '.' && path !== '..' && !path.includes('/') && !path.includes('\\'),
    'Expected a portable Idea folder reference'
  )
export type IdeaRelativePath = z.infer<typeof ideaRelativePathSchema>
