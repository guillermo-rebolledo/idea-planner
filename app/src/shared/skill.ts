import { z } from 'zod'
import { harnessIdSchema } from './readiness'
import { skillNameSchema } from './run'

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
  projectTrusted: z.boolean()
})
export type SkillCatalog = z.infer<typeof skillCatalogSchema>

export const listSkillsInputSchema = z.object({
  projectRoot: z.string().min(1),
  harness: harnessIdSchema
})
export type ListSkillsInput = z.infer<typeof listSkillsInputSchema>

export const trustProjectSkillsInputSchema = z.object({
  root: z.string().min(1),
  /** Whose catalog to answer with: Skills live in per-Harness directories. */
  harness: harnessIdSchema,
  trusted: z.boolean()
})
export type TrustProjectSkillsInput = z.infer<typeof trustProjectSkillsInputSchema>
