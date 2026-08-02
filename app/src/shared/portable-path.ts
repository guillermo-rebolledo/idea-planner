import { z } from 'zod'

/** One portable Session folder reference, with no path traversal or separators. */
export const sessionRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) => path !== '.' && path !== '..' && !path.includes('/') && !path.includes('\\'),
    'Expected a portable Session folder reference'
  )
export type SessionRelativePath = z.infer<typeof sessionRelativePathSchema>
