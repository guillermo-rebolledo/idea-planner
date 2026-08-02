import { z } from 'zod'

/**
 * A Project the user has added. The root is the path git resolved (ADR 0005),
 * and it is the Project's identity: two clones of one remote resolve to two
 * roots and stay two Projects.
 */
export const projectSchema = z.object({
  root: z.string().min(1),
  name: z.string().min(1),
  addedAt: z.string().datetime(),
  /**
   * When the person trusted this Project's own Skills. Null means its Skills
   * are found and not offered: a Skill is instruction text steering an agent
   * with write and command access, and one that arrived by `git clone` is text
   * from whoever wrote that repository.
   */
  skillsTrustedAt: z.string().datetime().nullable().default(null)
})
export type Project = z.infer<typeof projectSchema>

/**
 * A Project as the app presents it. Availability is observed when the list is
 * read, never stored: a Project is unavailable exactly while its directory is
 * not there.
 */
export const projectViewSchema = projectSchema.extend({ available: z.boolean() })
export type ProjectView = z.infer<typeof projectViewSchema>

/** Why a chosen folder could not become a Project. */
export const projectRejectionSchema = z.enum(['not-a-repository', 'git-unavailable'])
export type ProjectRejection = z.infer<typeof projectRejectionSchema>

/**
 * The result of offering a folder to the app. `git-unavailable` is kept
 * distinct from `not-a-repository` on purpose: reporting a machine with no git
 * as "not a repository" sends the user to fix the wrong thing (ADR 0005).
 */
export const chooseProjectResultSchema = z.union([
  z.object({ status: z.literal('added'), project: projectViewSchema }),
  z.object({ status: z.literal('cancelled') }),
  /**
   * The chosen folder is inside a Project whose root is elsewhere. Adding it
   * silently would add something the person did not pick, so the root is named
   * and confirmed first.
   */
  z.object({
    status: z.literal('confirm-root'),
    chosen: z.string().min(1),
    root: z.string().min(1)
  }),
  z.object({
    status: z.literal('refused'),
    reason: projectRejectionSchema,
    path: z.string().min(1)
  })
])
export type ChooseProjectResult = z.infer<typeof chooseProjectResultSchema>
