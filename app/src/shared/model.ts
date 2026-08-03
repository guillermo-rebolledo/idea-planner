import { z } from 'zod'
import { harnessIdSchema } from './readiness'

/**
 * The models a Harness can be asked for, and the thinking levels each of them
 * supports.
 *
 * Where the list comes from differs per Harness, because what they offer
 * differs (ticket 13):
 *
 * - Codex enumerates its own. `model/list` over the app-server answers with
 *   display names, descriptions, and the reasoning efforts each model
 *   supports — which are not the same for every model. Asking the installed
 *   binary is the only list that cannot go stale.
 * - Claude Code has no enumeration. Its `--model` documents aliases that
 *   follow the latest of each family, and those are what this app offers.
 *   `default` leaves the choice to the Harness's own configuration, which is
 *   also where a model this app does not list is chosen.
 */

/** One thinking level, named as the Harness names it. */
export const effortOptionSchema = z.object({
  id: z.string().min(1).max(50),
  name: z.string().min(1).max(50)
})
export type EffortOption = z.infer<typeof effortOptionSchema>

export const modelOptionSchema = z.object({
  /** What is passed to the Harness, and what a Run records. */
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  description: z.string().max(300).default(''),
  /**
   * The thinking levels this model supports. Empty means it has none to
   * choose, and the picker's Thinking row hides itself.
   */
  efforts: z.array(effortOptionSchema).max(20).default([]),
  /** What this model is asked for when nothing else is chosen. */
  defaultEffort: z.string().max(50).nullable().default(null)
})
export type ModelOption = z.infer<typeof modelOptionSchema>

/**
 * One Harness's models, as a group in the picker. The heading names the
 * Harness because choosing a model chooses one, and a Harness carries
 * behaviour a model does not: Ask and Full access do not mean the same thing
 * across Harnesses (`docs/harness-permission-mapping.md`), and Skills work
 * natively on Claude Code where Codex is given instruction text (ADR 0003).
 */
export const modelGroupSchema = z.object({
  harness: harnessIdSchema,
  displayName: z.string().min(1).max(100),
  models: z.array(modelOptionSchema).max(100),
  /**
   * Why the list is what it is: `probed` was asked of the installed binary,
   * `documented` is what the Harness's own help documents because it offers no
   * enumeration. Shown, so a short list is not mistaken for a broken one.
   */
  source: z.enum(['probed', 'documented'])
})
export type ModelGroup = z.infer<typeof modelGroupSchema>

export const modelCatalogSchema = z.object({ groups: z.array(modelGroupSchema) })
export type ModelCatalog = z.infer<typeof modelCatalogSchema>

/**
 * What Claude Code's own `--model` help documents: aliases that follow the
 * latest of each family. Names rather than versions, so this ages slowly, and
 * `default` leaves the choice to the Harness's own configuration.
 */
export const CLAUDE_MODEL_ALIASES: { id: string; name: string; description: string }[] = [
  { id: 'default', name: 'Default', description: 'Whatever Claude Code is configured to use' },
  { id: 'fable', name: 'Fable', description: 'The latest Fable' },
  { id: 'opus', name: 'Opus', description: 'The latest Opus' },
  { id: 'sonnet', name: 'Sonnet', description: 'The latest Sonnet' },
  { id: 'haiku', name: 'Haiku', description: 'The latest Haiku' }
]

/**
 * Claude Code takes `--effort` alongside any model, so the levels belong to
 * the Harness rather than to one model — unlike Codex, which says per model
 * which it supports.
 */
export const CLAUDE_EFFORTS: EffortOption[] = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'xhigh', name: 'Xhigh' },
  { id: 'max', name: 'Max' }
]

/**
 * The level asked for when nothing else says. Named once: three places used to
 * spell it, and a fallback that disagrees with itself is a fallback nobody can
 * reason about.
 */
export const DEFAULT_EFFORT = 'medium'
export const CLAUDE_DEFAULT_EFFORT = DEFAULT_EFFORT
