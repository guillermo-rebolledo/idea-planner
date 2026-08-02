import { z } from 'zod'
import { harnessIdSchema } from './readiness'

/**
 * Standing Approvals: permissions the person has granted permanently for one
 * Project, expressed as the Harness's own permission rules and injected into
 * the Run's staged settings (ADR 0003, `docs/harness-permission-mapping.md`).
 *
 * Verification recorded in `.scratch/research/claude-code-permissions-and-protocol.md`
 * shows those rules are consulted *before* the approval tool: an approved call
 * never reaches this app at all. That is what makes them work, and it is also
 * why breadth has to be settled here rather than at runtime — once a rule is
 * stored there is no interception point left.
 *
 * So a rule is proposed only when it can be said plainly what it covers: a
 * named command with what it is doing, or every file in one Project. Anything
 * else is refused, and the person goes on answering it each time. Rule syntax
 * here is Claude Code's, per `docs/harness-permission-mapping.md`; each
 * approval records the Harness whose rules it is written in, so it is never
 * handed to one that reads them differently.
 */

export const standingApprovalKindSchema = z.enum(['command', 'edit'])
export type StandingApprovalKind = z.infer<typeof standingApprovalKindSchema>

/**
 * A rule this app is willing to write, in parts. The Harness wants it two
 * ways — as `Tool(content)` in a settings file, and as a tool name beside its
 * content when a rule is added to a running Harness Thread — so the parts are
 * what is kept and the written form is derived from them.
 */
export const proposedRuleSchema = z.object({
  kind: standingApprovalKindSchema,
  /** The Harness tool the rule governs, such as `Bash` or `Edit`. */
  toolName: z.string().min(1).max(100),
  /** What it allows: a command prefix, or a path pattern. */
  content: z.string().min(1).max(400)
})
export type ProposedRule = z.infer<typeof proposedRuleSchema>

/** The literal rule, as it is written down and as the person reads it. */
export function ruleText(rule: Pick<ProposedRule, 'toolName' | 'content'>): string {
  return `${rule.toolName}(${rule.content})`
}

export const standingApprovalSchema = z.object({
  id: z.string().min(1),
  /** The Project it belongs to, by the root git resolved (ADR 0005). */
  projectRoot: z.string().min(1),
  /** Whose rule syntax this is written in, and therefore who may be given it. */
  harness: harnessIdSchema,
  kind: standingApprovalKindSchema,
  toolName: z.string().min(1).max(100),
  content: z.string().min(1).max(400),
  /** What was being asked when it was granted, so the list reads as history. */
  summary: z.string().min(1).max(500),
  grantedAt: z.string().datetime()
})
export type StandingApproval = z.infer<typeof standingApprovalSchema>

export const grantStandingApprovalInputSchema = proposedRuleSchema.extend({
  projectRoot: z.string().min(1),
  harness: harnessIdSchema,
  summary: z.string().min(1).max(500)
})
export type GrantStandingApprovalInput = z.infer<typeof grantStandingApprovalInputSchema>

export const revokeStandingApprovalInputSchema = z.object({
  projectRoot: z.string().min(1),
  id: z.string().min(1)
})
export type RevokeStandingApprovalInput = z.infer<typeof revokeStandingApprovalInputSchema>

/**
 * Separators the Harness splits a command on before matching. Every part must
 * match a rule independently, so a command containing any of them cannot be
 * covered by one rule — and substitution brings along a command nobody read.
 */
const COMPOUND = /[&|;\n`]|\$\(|<\(/

/**
 * Heads no rule is offered for at all.
 *
 * Wrappers the Harness strips before matching (`timeout`, `nice`, …) would
 * produce a rule that never fires. Wrappers it always prompts for (`watch`,
 * `find -delete`) would produce one that never helps. And environment runners
 * (`npx`, `docker exec`, `devbox run`) are *not* stripped, so a rule about one
 * permits everything it can run — `Bash(docker exec:*)` allows
 * `docker exec any-container rm -rf /`. Reaching past a runner to the command
 * inside means guessing past flags, containers, and images, and a guess too
 * broad here cannot be taken back at runtime.
 */
const UNOFFERABLE = new Set([
  'timeout',
  'time',
  'nice',
  'nohup',
  'stdbuf',
  'command',
  'builtin',
  'noglob',
  'nocorrect',
  'xargs',
  'watch',
  'setsid',
  'ionice',
  'flock',
  'find',
  'env',
  'sudo',
  'npx',
  'pnpx',
  'bunx',
  'uvx',
  'docker',
  'devbox',
  'mise',
  'direnv'
])

/**
 * Words that only introduce another command. `Bash(pnpm run:*)` is every
 * script a Project defines, so the rule reaches one word further to the one
 * that says what is actually being run.
 */
const DELEGATING = new Set(['run', 'exec', 'dlx'])

/** A bare program or subcommand name — nothing with a path, flag, or quoting. */
const PLAIN_WORD = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

/** `NAME=value`, which the Harness strips from the front before matching. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Every file-editing tool, all of which are governed by `Edit(...)` rules. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Update'])

/**
 * The rule that would stop this request being asked again, or nothing when
 * there is no honest way to narrow it. Nothing is a perfectly good answer: the
 * person keeps deciding case by case, which is what Ask is for.
 */
export function proposeStandingApproval(
  tool: string,
  input: Record<string, unknown>,
  /**
   * The Project root with every symlink resolved. Measured on 2.1.220, the
   * Harness resolves a path before it checks any rule against it: working
   * through a symlinked root, a rule naming that root was not consulted and a
   * rule naming its target was. A rule written from the path the person sees
   * would therefore go on asking.
   */
  resolvedProjectRoot: string
): ProposedRule | null {
  const root = trimTrailingSlash(resolvedProjectRoot)
  if (EDIT_TOOLS.has(tool)) {
    // Offered on the file in front of the person, and only when the rule would
    // actually cover it: a Project-wide rule proposed for a file outside the
    // Project is a grant that goes on asking. The path arrives resolved, so it
    // is compared against the resolved root.
    const path = typeof input['file_path'] === 'string' ? input['file_path'] : ''
    if (!path.startsWith(`${root}/`)) return null
    // One rule for the whole Project rather than one per file: a file-by-file
    // grant is a question that never stops being asked, and it is repo-wide
    // edit permission that makes Ask livable.
    //
    // `//` anchors at the filesystem root. A single leading slash would anchor
    // at the staged settings file, which lives outside the repository.
    return { kind: 'edit', toolName: 'Edit', content: `/${root}/**` }
  }
  if (tool !== 'Bash') return null
  const command = typeof input['command'] === 'string' ? input['command'].trim() : ''
  if (!command || COMPOUND.test(command)) return null
  const prefix = commandPrefix(command)
  return prefix ? { kind: 'command', toolName: 'Bash', content: `${prefix}:*` } : null
}

/**
 * The leading words a rule should name, or nothing when they do not say
 * enough. Two words is the floor, because one is only ever the name of a
 * program: a rule offered from `rm -rf ./dist` that reads `Bash(rm:*)` permits
 * every `rm` there will ever be, which is not what anybody thought they were
 * agreeing to.
 */
function commandPrefix(command: string): string | null {
  const tokens = command.split(/\s+/).filter((token) => token !== '')
  // Only assignments of variables the Harness considers safe are stripped
  // before an allow rule is matched, and that list is not ours to know. A rule
  // written past one might simply never fire.
  if (ASSIGNMENT.test(tokens[0] ?? '')) return null
  const head = tokens[0]
  if (!head || !PLAIN_WORD.test(head) || UNOFFERABLE.has(head)) return null
  const named: string[] = []
  for (const token of tokens) {
    if (!PLAIN_WORD.test(token)) break
    named.push(token)
    // Two words name a subcommand, which is as far as a rule needs to go —
    // unless the second word only introduces another one.
    if (named.length >= 2 && !DELEGATING.has(token)) break
  }
  return named.length >= 2 ? named.join(' ') : null
}

function trimTrailingSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path
}
