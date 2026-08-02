import { z } from 'zod'

/**
 * Harness and skill readiness: the shared shapes for the five independent
 * checks the app runs per Harness. Probing happens in Main; the Renderer
 * only presents these validated results.
 */

export const harnessIdSchema = z.enum(['codex', 'claude'])
export type HarnessId = z.infer<typeof harnessIdSchema>

export const readinessDimensionSchema = z.enum([
  'executable',
  'compatibility',
  'authentication',
  'sandbox',
  'skills'
])
export type ReadinessDimension = z.infer<typeof readinessDimensionSchema>

/**
 * `warning` keeps a Harness usable (for example an untested version);
 * `failed` disables only the failing dimension's dependents; `not-probed`
 * marks dimensions that could not run because the executable is unavailable.
 */
export const readinessStatusSchema = z.enum(['ready', 'warning', 'failed', 'not-probed'])
export type ReadinessStatus = z.infer<typeof readinessStatusSchema>

export const readinessCodeSchema = z.enum([
  'ready',
  'executable-missing',
  'selected-executable-invalid',
  'version-incompatible',
  'version-unrecognized',
  'version-untested',
  'unauthenticated',
  'sandbox-unavailable',
  'skills-missing',
  'probe-timeout',
  'probe-failed',
  'not-probed'
])
export type ReadinessCode = z.infer<typeof readinessCodeSchema>

export const remediationLinkSchema = z.object({
  label: z.string().min(1),
  url: z.string().url()
})
export type RemediationLink = z.infer<typeof remediationLinkSchema>

export const readinessCheckSchema = z.object({
  dimension: readinessDimensionSchema,
  status: readinessStatusSchema,
  code: readinessCodeSchema,
  /** One safe sentence describing the result. Never raw Harness output. */
  summary: z.string().min(1),
  /** Copyable terminal remediation. The app never runs it. */
  command: z.string().nullable(),
  links: z.array(remediationLinkSchema),
  /** Skill names still missing, when the dimension is `skills`. */
  missingSkills: z.array(z.string().min(1))
})
export type ReadinessCheck = z.infer<typeof readinessCheckSchema>

export const executableSourceSchema = z.enum(['path', 'explicit'])
export type ExecutableSource = z.infer<typeof executableSourceSchema>

/**
 * A product capability a Harness either supports or does not. Readiness
 * reports these so a feature can be offered with an explanation rather than
 * silently omitted, which is the difference between "I can't" and "I won't".
 */
export const harnessCapabilitySchema = z.object({
  available: z.boolean(),
  /** One sentence saying why, in the person's terms. */
  summary: z.string().min(1),
  /** Copyable remediation. The app never runs it. */
  command: z.string().nullable()
})
export type HarnessCapability = z.infer<typeof harnessCapabilitySchema>

export const harnessReadinessSchema = z.object({
  harness: harnessIdSchema,
  displayName: z.string().min(1),
  /** The exact configured command name, e.g. `codex`. */
  command: z.string().min(1),
  /** Resolved absolute executable path, visible before a Harness is usable. */
  executablePath: z.string().nullable(),
  executableSource: executableSourceSchema,
  version: z.string().nullable(),
  checks: z.array(readinessCheckSchema).length(5),
  /** Keyed by capability so a new one is a new field, not a lookup. */
  capabilities: z.object({ developSession: harnessCapabilitySchema }),
  checkedAt: z.string().datetime(),
  /** True when every dimension is ready or a warning. */
  available: z.boolean()
})
export type HarnessReadiness = z.infer<typeof harnessReadinessSchema>

export const pathSourceSchema = z.enum(['login-shell', 'launchctl', 'inherited'])
export type PathSource = z.infer<typeof pathSourceSchema>

export const readinessSnapshotSchema = z.object({
  harnesses: z.array(harnessReadinessSchema),
  /** Where the effective PATH came from, in merge order. */
  pathSources: z.array(pathSourceSchema),
  loginShellConsent: z.boolean(),
  /** The only skill installation guidance the app shows. Never executed. */
  skillsInstallCommand: z.string().min(1)
})
export type ReadinessSnapshot = z.infer<typeof readinessSnapshotSchema>

export const chooseExecutableResultSchema = z.union([
  z.object({ canceled: z.literal(true) }),
  z.object({ canceled: z.literal(false), snapshot: readinessSnapshotSchema })
])
export type ChooseExecutableResult = z.infer<typeof chooseExecutableResultSchema>

export const refreshReadinessInputSchema = z.object({
  harness: harnessIdSchema.optional()
})
export type RefreshReadinessInput = z.infer<typeof refreshReadinessInputSchema>
