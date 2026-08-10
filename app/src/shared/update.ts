import { z } from 'zod'

/**
 * What Argos knows about a newer version of itself.
 *
 * Argos is distributed outside the App Store (ADR 0008), so nobody else will
 * tell a person their copy is old. It tells them — and stops there. Taking the
 * update opens the release in their browser, where they install it the way
 * they installed it the first time. Nothing is downloaded or replaced by the
 * app itself (ADR 0009).
 */
export const updateAvailabilitySchema = z.object({
  /** The version running right now, as the bundle states it. */
  installed: z.string().min(1),
  /**
   * The newer published version, once a check has found one.
   *
   * Null says every quiet thing at once: no check has finished yet, the last
   * one failed, the network was unreachable, or this is already the newest
   * version. That is deliberate. A person opened Argos to write code, and
   * "we could not reach the internet" is not news they asked for — so the
   * absence of an update and the failure to look for one are the same shape,
   * and neither has anywhere to be shown.
   */
  available: z
    .object({
      version: z.string().min(1),
      /**
       * The published release. Main learned it, validated it, and is the only
       * one that opens it; the Renderer asks to take the update and never says
       * where the update lives.
       */
      url: z.string().url()
    })
    .nullable()
})
export type UpdateAvailability = z.infer<typeof updateAvailabilitySchema>

interface ParsedVersion {
  readonly release: readonly number[]
  /** Empty for a final release, which outranks every prerelease of itself. */
  readonly prerelease: readonly string[]
}

/**
 * `1.2.3`, `v1.2.3`, `1.2.3-beta.4`, and the build metadata semver says to
 * ignore when comparing. Anything else is not a version this app publishes.
 */
const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION.exec(value.trim())
  if (!match) return null
  return {
    release: [Number(match[1] ?? '0'), Number(match[2] ?? '0'), Number(match[3] ?? '0')],
    prerelease: match[4] === undefined ? [] : match[4].split('.')
  }
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  // A final release outranks every prerelease of the same numbers.
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0
    return left.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const one = left[index]
    const other = right[index]
    // Fewer identifiers ranks lower: `1.0.0-beta` precedes `1.0.0-beta.1`.
    if (one === undefined) return -1
    if (other === undefined) return 1
    const oneIsNumeric = /^\d+$/u.test(one)
    const otherIsNumeric = /^\d+$/u.test(other)
    if (oneIsNumeric && otherIsNumeric) {
      if (Number(one) !== Number(other)) return Number(one) - Number(other)
    } else if (oneIsNumeric !== otherIsNumeric) {
      return oneIsNumeric ? -1 : 1
    } else if (one !== other) {
      return one < other ? -1 : 1
    }
  }
  return 0
}

/**
 * Whether `candidate` is a version worth telling somebody about.
 *
 * A version either side cannot be read is never newer. The feed is remote and
 * this answer becomes a notice with the person's name on it: something
 * unreadable arriving from the network must produce silence, not a nag about
 * a version that may not exist.
 */
export function isNewerVersion(candidate: string, installed: string): boolean {
  const one = parseVersion(candidate)
  const other = parseVersion(installed)
  if (!one || !other) return false
  for (let index = 0; index < one.release.length; index++) {
    const left = one.release[index] ?? 0
    const right = other.release[index] ?? 0
    if (left !== right) return left > right
  }
  return comparePrerelease(one.prerelease, other.prerelease) > 0
}
