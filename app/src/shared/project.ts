import { z } from 'zod'
import { harnessIdSchema } from './readiness'
import { skillNameSchema } from './run'

export const projectSkillDigestSchema = z.object({
  harness: harnessIdSchema,
  name: skillNameSchema,
  digest: z.string().length(64)
})
export type ProjectSkillDigest = z.infer<typeof projectSkillDigestSchema>

export const projectSkillsTrustSchema = z.object({
  digest: z.string().length(64),
  manifest: z.array(projectSkillDigestSchema).max(500)
})
export type ProjectSkillsTrust = z.infer<typeof projectSkillsTrustSchema>

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
  skillsTrustedAt: z.string().datetime().nullable().default(null),
  /** Digest of both supported Project Skill trees at the time trust was granted. */
  skillsTrustedDigest: z.string().length(64).nullable().default(null),
  /** Bounded per-Skill digests used to explain what invalidated trust. */
  skillsTrustedManifest: z.array(projectSkillDigestSchema).max(500).default([])
})
export type Project = z.infer<typeof projectSchema>

/**
 * A Project as the app presents it. Availability is observed when the list is
 * read, never stored: a Project is unavailable exactly while its directory is
 * not there.
 */
export const projectViewSchema = projectSchema.extend({ available: z.boolean() })
export type ProjectView = z.infer<typeof projectViewSchema>

/**
 * The Project as a person names it: the folder, not the whole path. The one
 * derivation behind `Project.name` and every chip that says it, so a surface
 * can name a Project from its root alone without re-inventing the rule.
 */
export function projectDisplayName(root: string): string {
  return root.split(/[\\/]/u).filter(Boolean).at(-1) ?? root
}

/** Only network transports whose credential behavior the product can explain. */
export function isSupportedGitRemote(remote: string): boolean {
  let hasControlCharacter = false
  for (let index = 0; index < remote.length; index += 1) {
    const code = remote.charCodeAt(index)
    if (code <= 31 || code === 127) {
      hasControlCharacter = true
      break
    }
  }
  if (remote.length > 2048 || hasControlCharacter) return false
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/u.test(remote)) return true
  try {
    const url = new URL(remote)
    if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return false
    if (!url.hostname || url.password || url.search || url.hash) return false
    if (url.protocol === 'https:' && url.username) return false
    return url.pathname.split('/').filter(Boolean).length >= 2
  } catch {
    return false
  }
}

/** A safe suggested leaf for a supported Git remote. */
export function projectNameFromRemote(remote: string): string | null {
  if (!isSupportedGitRemote(remote)) return null
  const path = remote.includes('://')
    ? new URL(remote).pathname
    : remote.slice(remote.indexOf(':') + 1)
  const leaf =
    path
      .split('/')
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.git$/u, '') ?? ''
  return /^[A-Za-z0-9._-]+$/u.test(leaf) && leaf !== '.' && leaf !== '..' ? leaf : null
}

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

/** A repository the authenticated GitHub CLI account may clone. */
export const githubRepositorySchema = z.object({
  nameWithOwner: z.string().min(3).max(300),
  description: z.string().max(500),
  private: z.boolean(),
  updatedAt: z.string().datetime()
})
export type GitHubRepository = z.infer<typeof githubRepositorySchema>

export const githubRepositoryListResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), repositories: z.array(githubRepositorySchema).max(200) }),
  z.object({
    status: z.enum(['unavailable', 'unauthenticated', 'failed']),
    detail: z.string().min(1).max(500)
  })
])
export type GitHubRepositoryListResult = z.infer<typeof githubRepositoryListResultSchema>

/** One existing parent directory and the child a clone would create inside it. */
export const projectCloneLocationSchema = z.object({
  label: z.string().min(1).max(100),
  parent: z.string().min(1),
  destination: z.string().min(1)
})
export type ProjectCloneLocation = z.infer<typeof projectCloneLocationSchema>

const projectCloneDestinationSchema = z.string().min(1).max(4096)
const gitUrlSchema = z.string().trim().min(1).max(2048)
const githubNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)

/** The two remote sources supported by the first Add Project release. */
export const projectCloneInputSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('git-url'),
    url: gitUrlSchema,
    destination: projectCloneDestinationSchema
  }),
  z.object({
    source: z.literal('github'),
    repository: githubNameSchema,
    destination: projectCloneDestinationSchema
  })
])
export type ProjectCloneInput = z.infer<typeof projectCloneInputSchema>

export const projectCloneStartedSchema = z.object({ operationId: z.string().uuid() })
export type ProjectCloneStarted = z.infer<typeof projectCloneStartedSchema>

export const projectCloneFailureSchema = z.enum([
  'invalid-source',
  'destination-exists',
  'destination-unavailable',
  'git-unavailable',
  'github-unavailable',
  'github-unauthenticated',
  'authentication',
  'not-found',
  'network',
  'timed-out',
  'add-failed',
  'unknown'
])
export type ProjectCloneFailure = z.infer<typeof projectCloneFailureSchema>

/** Events from one Main-owned clone. Output is sanitized before it crosses IPC. */
export const projectCloneEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    operationId: z.string().uuid(),
    phase: z.enum(['starting', 'receiving', 'resolving', 'checking-out', 'verifying', 'adding']),
    detail: z.string().max(500)
  }),
  z.object({
    type: z.literal('completed'),
    operationId: z.string().uuid(),
    project: projectViewSchema
  }),
  z.object({
    type: z.literal('cancelled'),
    operationId: z.string().uuid(),
    destination: projectCloneDestinationSchema
  }),
  z.object({
    type: z.literal('failed'),
    operationId: z.string().uuid(),
    reason: projectCloneFailureSchema,
    detail: z.string().min(1).max(500),
    destination: projectCloneDestinationSchema
  })
])
export type ProjectCloneEvent = z.infer<typeof projectCloneEventSchema>
