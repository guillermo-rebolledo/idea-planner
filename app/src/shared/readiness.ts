import { z } from 'zod'

/**
 * Harness readiness: the shared shapes for the checks the app runs per
 * Harness. Probing happens in Main; the Renderer only presents these
 * validated results.
 *
 * Three dimensions decide whether a Harness can be used at all — it has to be
 * there, be a version this app can talk to, and be signed in. `skills` is
 * reported beside them and gates nothing: a Harness that is installed,
 * compatible, and signed in works, and a methodology document missing from
 * somebody's home directory is not a reason to tell them it does not.
 */

export const harnessIdSchema = z.enum(['codex', 'claude'])
export type HarnessId = z.infer<typeof harnessIdSchema>

export const readinessDimensionSchema = z.enum([
  'executable',
  'compatibility',
  'authentication',
  'skills'
])
export type ReadinessDimension = z.infer<typeof readinessDimensionSchema>

/**
 * The dimensions that decide whether a Harness can be used at all. Everything
 * else is reported beside them and gates nothing, and the two are kept apart
 * here so that one list decides and the other only informs — a dimension that
 * cannot block anything must not be presented as though it had.
 */
export const GATING_DIMENSIONS: readonly ReadinessDimension[] = [
  'executable',
  'compatibility',
  'authentication'
]

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
  links: z.array(remediationLinkSchema)
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
  /** One per dimension, always, so a missing probe cannot read as a pass. */
  checks: z.array(readinessCheckSchema).length(readinessDimensionSchema.options.length),
  /** Keyed by capability so a new one is a new field, not a lookup. */
  capabilities: z.object({ developSession: harnessCapabilitySchema }),
  checkedAt: z.string().datetime(),
  /** True when every gating dimension is ready or a warning. */
  available: z.boolean()
})
export type HarnessReadiness = z.infer<typeof harnessReadinessSchema>

/**
 * The Harnesses this app could actually run a Session with. Deliberately
 * narrower than Readiness: being installed, compatible, and signed in makes a
 * Harness usable, but one this app cannot drive is still one the person would
 * type their first message into and watch do nothing. The launch gate exists
 * to prevent exactly that, so it asks the narrower question.
 */
export function harnessesReadyForASession(snapshot: ReadinessSnapshot): HarnessReadiness[] {
  return snapshot.harnesses.filter((harness) => harness.capabilities.developSession.available)
}

/**
 * The one thing standing between this Harness and a Session, in the person's
 * own situation: the first check that failed — not found, wrong version,
 * signed out — or, when readiness is not the problem, what the app says about
 * driving it.
 */
export function firstProblem(harness: HarnessReadiness): string {
  const failing = harness.checks.find(
    (check) => check.status === 'failed' || check.status === 'not-probed'
  )
  return failing?.summary ?? harness.capabilities.developSession.summary
}

/**
 * What the launch gate says about a Harness that cannot run a Session: how
 * bad it is, in two words, and the one repair worth copying. `missing` means
 * the executable itself is absent — the machine does not have the tool — and
 * everything else is `blocked`: installed, but standing behind a version or a
 * sign-in. The distinction is the dot's colour, so it is decided here where
 * it can be tested, not in a class name.
 */
export interface GateProblem {
  severity: 'missing' | 'blocked'
  /** Two or three words beside the name, e.g. "Not installed". */
  label: string
  /** The full sentence from the check or capability that failed. */
  summary: string
  /** Copyable terminal remediation. The app never runs it. */
  command: string | null
  /** Where to read more, when the check named somewhere. */
  links: RemediationLink[]
}

/** A dimension that can actually stand between a Harness and a Session. */
type GatingDimension = Exclude<ReadinessDimension, 'skills'>

export function isGating(dimension: ReadinessDimension): dimension is GatingDimension {
  return GATING_DIMENSIONS.includes(dimension)
}

const GATE_LABELS: Record<GatingDimension, string> = {
  executable: 'Not installed',
  compatibility: 'Installed, version not supported',
  authentication: 'Installed, not signed in'
}

export function gateProblem(harness: HarnessReadiness): GateProblem | null {
  if (harness.capabilities.developSession.available) return null
  const failing = harness.checks.find(
    (check) =>
      isGating(check.dimension) && (check.status === 'failed' || check.status === 'not-probed')
  )
  if (failing && isGating(failing.dimension)) {
    return {
      severity: failing.dimension === 'executable' ? 'missing' : 'blocked',
      label: GATE_LABELS[failing.dimension],
      summary: failing.summary,
      command: failing.command,
      links: failing.links
    }
  }
  // Every check passes and a Session still cannot run: the capability is the
  // problem, and it carries its own explanation and repair.
  return {
    severity: 'blocked',
    label: 'Installed, cannot run a Session yet',
    summary: harness.capabilities.developSession.summary,
    command: harness.capabilities.developSession.command,
    links: []
  }
}

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
