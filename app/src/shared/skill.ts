import { z } from 'zod'
import { harnessIdSchema } from './readiness'
import { skillNameSchema } from './run'
import { projectSkillDigestSchema } from './project'

/**
 * Skills: the methodologies a Run can be asked to work to. They are installed
 * by the person, never by this app, and discovered from the documented
 * directories each Harness already reads.
 *
 * A Skill is instruction text steering an agent that has write and command
 * access. One that arrives with a `git clone` is text from whoever wrote that
 * repository, and offering it in a menu is this app recommending it — so a
 * Project's own Skills stay inert until the person has seen them and said yes.
 */

export const skillSourceSchema = z.enum(['global', 'project'])
export type SkillSource = z.infer<typeof skillSourceSchema>

export const skillSchema = z.object({
  name: skillNameSchema,
  /** The directory holding its `SKILL.md`, which is its identity on disk. */
  path: z.string().min(1),
  source: skillSourceSchema,
  /** Whose documented directory it was found in. */
  harness: harnessIdSchema,
  /** The one-line description its own frontmatter gives, when it gives one. */
  description: z.string().max(500)
})
export type Skill = z.infer<typeof skillSchema>

export const skillCatalogSchema = z.object({
  /** What a Run may be asked to use, and what the composer offers. */
  available: z.array(skillSchema),
  /**
   * The Project's own Skills, found and deliberately not offered. Shown so the
   * person decides with them in front of them rather than in the abstract.
   */
  untrusted: z.array(skillSchema),
  /** Whether this Project's own Skills have been trusted. */
  projectTrusted: z.boolean(),
  /** Digest shown with the review and echoed by a trust command. */
  reviewedDigest: z.string().length(64).nullable(),
  /** Why Project Skills could not be observed safely. */
  projectTrustError: z.enum(['unreadable', 'unsupported', 'cyclic', 'over-limit']).nullable(),
  /** Difference from the last content-bound trust, when one exists. */
  changes: z.object({
    added: z.array(projectSkillDigestSchema.omit({ digest: true })),
    removed: z.array(projectSkillDigestSchema.omit({ digest: true })),
    changed: z.array(projectSkillDigestSchema.omit({ digest: true }))
  })
})
export type SkillCatalog = z.infer<typeof skillCatalogSchema>

export const listSkillsInputSchema = z.object({
  projectRoot: z.string().min(1),
  harness: harnessIdSchema
})
export type ListSkillsInput = z.infer<typeof listSkillsInputSchema>

export const trustProjectSkillsInputSchema = z
  .object({
    root: z.string().min(1),
    /** Whose catalog to answer with: Skills live in per-Harness directories. */
    harness: harnessIdSchema,
    trusted: z.boolean(),
    /** Required when granting; Main re-observes and refuses stale reviews. */
    reviewedDigest: z.string().length(64).optional()
  })
  .superRefine((input, context) => {
    if (input.trusted && input.reviewedDigest === undefined) {
      context.addIssue({ code: 'custom', message: 'A reviewed Skill digest is required' })
    }
  })
export type TrustProjectSkillsInput = z.infer<typeof trustProjectSkillsInputSchema>
