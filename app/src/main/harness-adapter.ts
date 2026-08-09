import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { z } from 'zod'
import {
  HARNESS_DEFAULT_MODEL,
  harnessEventSchema,
  type CodexLaunch,
  type HarnessEvent
} from '@shared/conversation'
import {
  APP_TOOLS,
  APPROVAL_TOOL,
  MCP_SERVER_NAME,
  SESSION_DIFF_TOOL_NAME,
  type PermissionMode,
  type SkillName
} from '@shared/run'
import type { RunConfiguration } from '@shared/run'
import type { HarnessId } from '@shared/readiness'
import type { ProposedRule } from '@shared/approval'
import type { CoreCommand } from '@shared/contract'
import { redactCredentials } from '@shared/redaction'

export interface HarnessAdapterCorePort {
  send(command: CoreCommand): Promise<unknown>
}

/**
 * The complete Run-native Harness seam in Main. Implementations own credentials,
 * staged homes, arguments, native permissions, Thread continuity, interruption,
 * and completion facts. They delegate raw-frame normalization and protocol
 * answers to Core; RunService only selects one.
 */

export interface HarnessAdapterDeps {
  core: HarnessAdapterCorePort
  homeDirectory: string
  proxyExecutable: string
  proxyScript: string
  claudeOauthToken?: () => Promise<string>
  stageSettings?: (permissionMode: PermissionMode) => unknown
  validateExecpolicy?: (executable: string, rulesFile: string) => Promise<void>
  writeFrame?: (runId: string, frame: string) => void
  /** Stable domain identity generation, injectable with every other external. */
  randomId: () => string
  /** How a bounded request reaches a Harness process; injectable for tests. */
  runBounded?: BoundedRunner
}

export class HarnessAdapterExternal extends Context.Tag('main/HarnessAdapterExternal')<
  HarnessAdapterExternal,
  HarnessAdapterDeps
>() {}

export function harnessAdapterLayer(
  dependencies: HarnessAdapterDeps
): Layer.Layer<HarnessAdapterExternal> {
  return Layer.succeed(HarnessAdapterExternal, dependencies)
}

export class HarnessAdapterError extends Error {
  readonly _tag = 'HarnessAdapterError'

  constructor(
    readonly operation: string,
    cause: unknown
  ) {
    super(
      `Harness adapter could not ${operation}${cause instanceof Error ? `: ${cause.message}` : ''}`,
      { cause }
    )
  }
}

export interface HarnessAdapterConfiguration {
  permissionMode: PermissionMode
  model: string
  effort: RunConfiguration['effort']
  skill: { name: string; path: string; hash: string } | null
}

export interface HarnessPreparation {
  runDirectory: string
  socketPath: string
  capabilityToken: string
  permissionMode: PermissionMode
  standingRules: string[]
  executable: string
}

export interface HarnessOpenInput {
  runId: string
  checkout: string
  configuration: HarnessAdapterConfiguration
  prompt: string
  skillInstructions: string
  handoff?: string
  resumeThreadId?: string
}

export interface HarnessStream {
  events: HarnessEvent[]
  outgoing: string[]
}

/**
 * One bounded, non-mutating question put to a Harness outside any Run: what
 * this Conversation amounts to, in prose. It touches no Conversation, saves no
 * Thread, and is refused the ability to change anything in the Checkout — a
 * summary that edited the person's code while writing itself would be a far
 * worse failure than not having one.
 */
export interface HarnessSummaryRequest {
  executable: string
  /** The directory the request runs in; nothing in it may be written. */
  checkout: string
  /** The Run directory this request may use for its own scratch files. */
  runDirectory: string
  /** What the Harness is asked, whole. */
  prompt: string
}

/** How long one summary request is given before it is abandoned. */
export const SUMMARY_TIMEOUT_MS = 120_000

/** One Harness process run to completion and read for its answer. */
export interface BoundedRequest {
  executable: string
  args: string[]
  environment: Record<string, string>
  workingDirectory: string
  /** Fed on stdin, which is how both Harnesses take a prompt too long for argv. */
  stdin: string
  timeoutMs: number
}

export type BoundedRunner = (request: BoundedRequest) => Promise<string>

export interface AdapterTerminalFact {
  status: 'completed' | 'failed'
  kind: 'lifecycle' | 'error'
  summary: string
}

export interface AdapterContinuation {
  harness: HarnessId
  model: string
  effort: RunConfiguration['effort']
  skill: SkillName | null
  permissionMode: PermissionMode
}

export interface AdapterRequestProposal {
  projectRoot: string
  harness: HarnessId
  proposed: ProposedRule | null
  summary: string
  /** The exact choices the fallback next turn must keep. */
  continuation: AdapterContinuation
}

interface ApprovalHost {
  hasOutstandingApproval(id: string): boolean
  resolveApproval(
    id: string,
    response:
      | {
          behavior: 'allow'
          sessionRule?: { toolName: string; content: string }
        }
      | { behavior: 'deny'; message: string }
  ): boolean
}

export interface AdapterApprovalAnswer {
  sessionId: string
  runId: string
  approvalId: string
  allowed: boolean
  remembered: boolean
  /** Present only when the person supplied an alternative instruction. */
  reason: string | undefined
  proposal: AdapterRequestProposal
  host?: ApprovalHost
}

export interface HarnessAdapter {
  readonly id: HarnessId
  readonly answersProtocol: boolean
  readonly servesApprovals: boolean
  askedPermissionMode(permissionMode: PermissionMode): string
  environment(
    executable: string,
    runDirectory: string
  ): Effect.Effect<Record<string, string>, HarnessAdapterError>
  launchEnvironment(
    executable: string,
    runDirectory: string
  ): Effect.Effect<Record<string, string>, HarnessAdapterError>
  threadExists(checkout: string, threadId: string): Effect.Effect<boolean, HarnessAdapterError>
  prepare(input: HarnessPreparation): Effect.Effect<void, HarnessAdapterError>
  arguments(
    configuration: HarnessAdapterConfiguration & { prompt: string },
    runDirectory: string,
    handoff?: string,
    threadId?: string
  ): Effect.Effect<string[], HarnessAdapterError>
  open(input: HarnessOpenInput): Effect.Effect<HarnessStream, HarnessAdapterError>
  /**
   * Asks this Harness one bounded, non-mutating question and returns its prose
   * answer. Used to write the summary a compaction carries; it belongs to no
   * Run and leaves no Harness Thread behind.
   */
  summarize(input: HarnessSummaryRequest): Effect.Effect<string, HarnessAdapterError>
  /** Delivers a correction to the active turn when this Harness supports it. */
  steer(runId: string, prompt: string): Effect.Effect<boolean, HarnessAdapterError>
  interrupt(runId: string): Effect.Effect<boolean, HarnessAdapterError>
  answerApproval(input: AdapterApprovalAnswer): Effect.Effect<boolean, HarnessAdapterError>
  terminalFact(event: HarnessEvent): AdapterTerminalFact | null
}

const harnessStreamSchema = z.object({
  events: z.array(harnessEventSchema),
  outgoing: z.array(z.string())
})

const answerSchema = z.object({ answered: z.boolean(), outgoing: z.array(z.string()) })
const steerSchema = z.object({ steered: z.boolean(), outgoing: z.array(z.string()) })

const claudeSettingsSchema = z.object({
  permissions: z.object({
    defaultMode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']),
    allow: z.array(z.string().min(1)).optional(),
    deny: z.array(z.string().min(1)).optional()
  })
})

const claudeCredentialsSchema = z.object({
  claudeAiOauth: z.object({ accessToken: z.string().min(1) })
})

const CLAUDE_PERMISSION_MODES: Record<PermissionMode, 'default' | 'bypassPermissions'> = {
  ask: 'default',
  auto: 'bypassPermissions'
}

const CODEX_APPROVAL_POLICIES: Record<PermissionMode, CodexLaunch['approvalPolicy']> = {
  ask: 'untrusted',
  auto: 'never'
}

const CODEX_SANDBOXES: Record<PermissionMode, CodexLaunch['sandbox']> = {
  ask: 'workspace-write',
  auto: 'danger-full-access'
}

function effectPromise<A>(
  operation: string,
  thunk: () => Promise<A>
): Effect.Effect<A, HarnessAdapterError> {
  return Effect.tryPromise({
    try: thunk,
    catch: (cause) => new HarnessAdapterError(operation, cause)
  })
}

type HarnessAdapterExternalLayer = Layer.Layer<HarnessAdapterExternal>

function withExternal<A>(
  layer: HarnessAdapterExternalLayer,
  operation: string,
  use: (dependencies: HarnessAdapterDeps) => Promise<A>
): Effect.Effect<A, HarnessAdapterError> {
  return Effect.flatMap(HarnessAdapterExternal, (dependencies) =>
    effectPromise(operation, () => use(dependencies))
  ).pipe(Effect.provide(layer))
}

function baseEnvironment(executable: string, home: string): Record<string, string> {
  return {
    PATH: `${dirname(executable)}:/usr/bin:/bin`,
    HOME: home,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8'
  }
}

function proxyConfiguration(deps: HarnessAdapterDeps, input: HarnessPreparation) {
  return {
    command: deps.proxyExecutable,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: `--require=${deps.proxyScript}`,
      APP_MCP_SOCKET: input.socketPath,
      APP_MCP_CAPABILITY: input.capabilityToken
    }
  }
}

function stageMcpConfiguration(deps: HarnessAdapterDeps, input: HarnessPreparation): Promise<void> {
  return writeFile(
    join(input.runDirectory, 'mcp.json'),
    JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: proxyConfiguration(deps, input) } }),
    { mode: 0o600 }
  )
}

function validateExecpolicy(
  deps: HarnessAdapterDeps,
  executable: string,
  rulesFile: string
): Promise<void> {
  if (deps.validateExecpolicy) return deps.validateExecpolicy(executable, rulesFile)
  return promisify(execFile)(executable, [
    'execpolicy',
    'check',
    '--rules',
    rulesFile,
    '--',
    'true'
  ]).then(
    () => undefined,
    (cause: unknown) => {
      const detail = cause instanceof Error ? cause.message : 'unknown problem'
      throw new Error(`Refusing to start: this Project's Codex rules are not valid — ${detail}`)
    }
  )
}

/**
 * One Harness process, fed a prompt and read for what it printed. Bounded in
 * time and in output: a request that never ends, or answers with a gigabyte,
 * is a request that takes the app down with it.
 */
function runBoundedProcess(request: BoundedRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      request.executable,
      request.args,
      {
        cwd: request.workingDirectory,
        env: request.environment,
        timeout: request.timeoutMs,
        maxBuffer: 4_000_000
      },
      (error: Error | null, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      }
    )
    child.stdin?.end(request.stdin)
  })
}

function boundedRunner(deps: HarnessAdapterDeps): BoundedRunner {
  return deps.runBounded ?? runBoundedProcess
}

/**
 * What a Harness is asked, and what it must not do while answering. Said in
 * the prompt as well as enforced by the arguments: an agent told it is only
 * writing prose does not go looking for something to fix.
 */
function summaryPreamble(): string {
  return [
    'You are summarizing a coding session so it can be continued in a fresh context.',
    'Write prose only. Do not use any tools, do not read or change any files, and do not ask questions.',
    'Answer with the summary itself and nothing else.'
  ].join('\n')
}

function readClaudeOauthToken(): Promise<string> {
  return promisify(execFile)('/usr/bin/security', [
    'find-generic-password',
    '-s',
    'Claude Code-credentials',
    '-w'
  ]).then(
    ({ stdout }) => claudeCredentialsSchema.parse(JSON.parse(stdout)).claudeAiOauth.accessToken
  )
}

function createCodexAdapter(layer: HarnessAdapterExternalLayer): HarnessAdapter {
  return {
    id: 'codex',
    answersProtocol: true,
    servesApprovals: false,
    askedPermissionMode: (permissionMode) => CODEX_APPROVAL_POLICIES[permissionMode],
    environment: (executable, runDirectory) =>
      withExternal(layer, 'build the Codex environment', (dependencies) =>
        Promise.resolve({
          ...baseEnvironment(executable, dependencies.homeDirectory),
          CODEX_HOME: join(runDirectory, 'codex-home')
        })
      ),
    launchEnvironment(executable, runDirectory) {
      return this.environment(executable, runDirectory)
    },
    /**
     * Whether Codex still holds the rollout behind a saved Harness Thread.
     * Codex refuses to resume a thread whose rollout file is gone — "no
     * rollout found for thread id …" — and retrying the same id can never
     * succeed, so a thread that is not on disk takes the restore-from-history
     * path instead of failing the Run. Rollouts live under
     * `sessions/YYYY/MM/DD/rollout-…-<threadId>.jsonl`; checked on disk like
     * Claude's, because the app-server is not running yet.
     */
    threadExists(_checkout, threadId) {
      return withExternal(layer, 'inspect Codex Thread continuity', async (dependencies) => {
        const sessions = join(dependencies.homeDirectory, '.codex', 'sessions')
        const suffix = `-${threadId}.jsonl`
        const list = (directory: string): Promise<{ name: string; isDirectory(): boolean }[]> =>
          readdir(directory, { withFileTypes: true }).then(
            (entries) => entries,
            () => []
          )
        for (const year of await list(sessions)) {
          if (!year.isDirectory()) continue
          for (const month of await list(join(sessions, year.name))) {
            if (!month.isDirectory()) continue
            for (const day of await list(join(sessions, year.name, month.name))) {
              if (!day.isDirectory()) continue
              const files = await list(join(sessions, year.name, month.name, day.name))
              if (files.some((file) => !file.isDirectory() && file.name.endsWith(suffix)))
                return true
            }
          }
        }
        return false
      })
    },
    prepare(input) {
      return withExternal(layer, 'prepare Codex', async (dependencies) => {
        await stageMcpConfiguration(dependencies, input)
        const codexHome = join(input.runDirectory, 'codex-home')
        await mkdir(codexHome, { recursive: true, mode: 0o700 })
        if (input.standingRules.length > 0) {
          const rulesDirectory = join(codexHome, 'rules')
          await mkdir(rulesDirectory, { recursive: true, mode: 0o700 })
          const rulesFile = join(rulesDirectory, 'standing-approvals.rules')
          await writeFile(rulesFile, `${input.standingRules.join('\n')}\n`, { mode: 0o600 })
          await validateExecpolicy(dependencies, input.executable, rulesFile)
        }
        await symlink(
          join(dependencies.homeDirectory, '.codex', 'auth.json'),
          join(codexHome, 'auth.json')
        )
        const proxy = proxyConfiguration(dependencies, input)
        await writeFile(
          join(codexHome, 'config.toml'),
          `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = ${JSON.stringify(proxy.command)}\n\n[mcp_servers.${MCP_SERVER_NAME}.env]\nELECTRON_RUN_AS_NODE = "1"\nNODE_OPTIONS = ${JSON.stringify(proxy.env.NODE_OPTIONS)}\nAPP_MCP_SOCKET = ${JSON.stringify(input.socketPath)}\nAPP_MCP_CAPABILITY = ${JSON.stringify(input.capabilityToken)}\n\n[mcp_servers.${MCP_SERVER_NAME}.tools.${SESSION_DIFF_TOOL_NAME}]\napproval_mode = "approve"\n`,
          { mode: 0o600 }
        )
      })
    },
    arguments: () => Effect.succeed(['app-server']),
    open(input) {
      return withExternal(layer, 'open the Codex protocol', async (dependencies) =>
        harnessStreamSchema.parse(
          await dependencies.core.send({
            type: 'harness/open',
            runId: input.runId,
            harness: 'codex',
            launch: {
              cwd: input.checkout,
              approvalPolicy: CODEX_APPROVAL_POLICIES[input.configuration.permissionMode],
              sandbox: CODEX_SANDBOXES[input.configuration.permissionMode],
              ...(input.configuration.model === HARNESS_DEFAULT_MODEL
                ? {}
                : { model: input.configuration.model }),
              effort: input.configuration.effort,
              developerInstructions: input.skillInstructions,
              prompt: input.handoff
                ? `${input.prompt}\n\nDeterministic handoff from the Conversation so far:\n${input.handoff}`
                : input.prompt,
              ...(input.resumeThreadId ? { resumeThreadId: input.resumeThreadId } : {})
            }
          })
        )
      )
    },
    /**
     * `codex exec`, sandboxed read-only and told to persist nothing. The
     * answer comes back through `--output-last-message` rather than off
     * stdout, because stdout is a transcript and the summary is one message
     * inside it — both flags are the installed binary's own.
     */
    summarize(input) {
      return withExternal(layer, 'ask Codex for a summary', async (dependencies) => {
        const answerPath = join(input.runDirectory, 'compaction-summary.txt')
        // A staged home, exactly as a Run gets one: the person's own
        // `~/.codex` is never written to and never read from beyond the
        // credentials this borrows (ADR 0003). It carries no `config.toml`, so
        // this request reaches no MCP server and no execpolicy rules either.
        const codexHome = join(input.runDirectory, 'codex-home')
        await mkdir(codexHome, { recursive: true, mode: 0o700 })
        await symlink(
          join(dependencies.homeDirectory, '.codex', 'auth.json'),
          join(codexHome, 'auth.json')
        ).catch(() => undefined)
        await boundedRunner(dependencies)({
          executable: input.executable,
          args: [
            'exec',
            '--sandbox',
            'read-only',
            '--skip-git-repo-check',
            // Nothing about this request belongs in any history, and nothing
            // the person configured for themselves applies to it.
            '--ephemeral',
            '--ignore-user-config',
            '--color',
            'never',
            '--cd',
            input.checkout,
            '--output-last-message',
            answerPath,
            '-'
          ],
          environment: {
            ...baseEnvironment(input.executable, dependencies.homeDirectory),
            CODEX_HOME: codexHome
          },
          workingDirectory: input.checkout,
          stdin: `${summaryPreamble()}\n\n${input.prompt}`,
          timeoutMs: SUMMARY_TIMEOUT_MS
        })
        return (await readFile(answerPath, 'utf8')).trim()
      })
    },
    steer(runId, prompt) {
      return withExternal(layer, 'steer Codex', async (dependencies) => {
        const answer = steerSchema.parse(
          await dependencies.core.send({ type: 'harness/steer', runId, prompt })
        )
        for (const frame of answer.outgoing) dependencies.writeFrame?.(runId, frame)
        return answer.steered
      })
    },
    interrupt(runId) {
      return withExternal(layer, 'interrupt Codex', async (dependencies) => {
        const frames = z
          .array(z.string())
          .parse(await dependencies.core.send({ type: 'harness/interrupt', runId }))
        for (const frame of frames) dependencies.writeFrame?.(runId, frame)
        return frames.length > 0
      })
    },
    answerApproval(input) {
      return withExternal(layer, 'answer the Codex Approval Request', async (dependencies) => {
        const answer = answerSchema.parse(
          await dependencies.core.send({
            type: 'harness/answer',
            runId: input.runId,
            approvalId: input.approvalId,
            allow: input.allowed,
            remember: input.remembered
          })
        )
        for (const frame of answer.outgoing) dependencies.writeFrame?.(input.runId, frame)
        // Codex's installed approval response accepts only a decision. Preserve
        // its native decline, then use the ordinary durable queue for the
        // person's requested alternative. The adapter owns this fallback;
        // RunService does not need to know which Harness lacks feedback.
        if (answer.answered && !input.allowed && input.reason) {
          const continuation = input.proposal.continuation
          await dependencies.core.send({
            type: 'conversation/queue-change',
            input: {
              type: 'enqueue',
              input: {
                sessionId: input.sessionId,
                submissionId: `approval-denial:${dependencies.randomId()}`,
                text: redactCredentials(input.reason).slice(0, 2_000),
                source: 'composer',
                reviewAttachments: [],
                harness: continuation.harness,
                model: continuation.model,
                effort: continuation.effort,
                permissionMode: continuation.permissionMode,
                ...(continuation.skill ? { skill: continuation.skill } : {})
              }
            }
          })
        }
        return answer.answered
      })
    },
    terminalFact(event) {
      if (event.type === 'completed') {
        return { status: 'completed', kind: 'lifecycle', summary: 'Harness completed the turn' }
      }
      if (event.type === 'failed') {
        return { status: 'failed', kind: 'error', summary: event.summary.slice(0, 500) }
      }
      return null
    }
  }
}

function createClaudeAdapter(layer: HarnessAdapterExternalLayer): HarnessAdapter {
  return {
    id: 'claude',
    answersProtocol: false,
    servesApprovals: true,
    askedPermissionMode: (permissionMode) => CLAUDE_PERMISSION_MODES[permissionMode],
    environment: (executable) =>
      withExternal(layer, 'build the Claude environment', (dependencies) =>
        Promise.resolve(baseEnvironment(executable, dependencies.homeDirectory))
      ),
    launchEnvironment(executable, _runDirectory) {
      return withExternal(layer, 'load Claude credentials', async (dependencies) => ({
        ...baseEnvironment(executable, dependencies.homeDirectory),
        CLAUDE_CODE_OAUTH_TOKEN: await (dependencies.claudeOauthToken ?? readClaudeOauthToken)()
      }))
    },
    threadExists(checkout, threadId) {
      return withExternal(layer, 'inspect Claude Thread continuity', async (dependencies) => {
        const projectKey = resolve(checkout).replaceAll('/', '-')
        const threadPath = join(
          dependencies.homeDirectory,
          '.claude',
          'projects',
          projectKey,
          `${threadId}.jsonl`
        )
        return readFile(threadPath, 'utf8').then(
          () => true,
          () => false
        )
      })
    },
    prepare(input) {
      return withExternal(layer, 'prepare Claude', async (dependencies) => {
        await stageMcpConfiguration(dependencies, input)
        const settings = dependencies.stageSettings
          ? dependencies.stageSettings(input.permissionMode)
          : {
              permissions: {
                defaultMode: CLAUDE_PERMISSION_MODES[input.permissionMode],
                allow: [...APP_TOOLS, ...input.standingRules]
              }
            }
        const validated = claudeSettingsSchema.safeParse(settings)
        if (!validated.success) {
          throw new Error(
            `Refusing to start: this Run's settings are not valid — ${validated.error.issues[0]?.message ?? 'unknown problem'}`
          )
        }
        await writeFile(join(input.runDirectory, 'settings.json'), JSON.stringify(validated.data), {
          mode: 0o600
        })
      })
    },
    arguments(configuration, runDirectory, handoff, threadId) {
      return Effect.succeed([
        '--print',
        '--setting-sources',
        'user',
        '--settings',
        join(runDirectory, 'settings.json'),
        '--strict-mcp-config',
        '--mcp-config',
        join(runDirectory, 'mcp.json'),
        '--permission-mode',
        CLAUDE_PERMISSION_MODES[configuration.permissionMode],
        ...(configuration.permissionMode === 'ask'
          ? ['--permission-prompt-tool', APPROVAL_TOOL]
          : []),
        '--no-chrome',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--include-hook-events',
        ...(threadId ? ['--resume', threadId] : []),
        ...(configuration.model === HARNESS_DEFAULT_MODEL ? [] : ['--model', configuration.model]),
        ...(configuration.effort === null ? [] : ['--effort', configuration.effort]),
        `${configuration.skill ? `/${configuration.skill.name} ` : ''}${configuration.prompt}${handoff ? `\n\nDeterministic handoff from the Conversation so far:\n${handoff}` : ''}`
      ])
    },
    open(input) {
      return withExternal(layer, 'open the Claude protocol', async (dependencies) =>
        harnessStreamSchema.parse(
          await dependencies.core.send({
            type: 'harness/open',
            runId: input.runId,
            harness: 'claude'
          })
        )
      )
    },
    /**
     * `claude --print`, in Plan mode with no MCP servers configured. Plan mode
     * is Claude's own refusal to change anything, and under `--print` there is
     * nobody who could approve leaving it — so the request cannot touch the
     * Checkout however the model reads its instructions.
     */
    summarize(input) {
      return withExternal(layer, 'ask Claude for a summary', async (dependencies) =>
        (
          await boundedRunner(dependencies)({
            executable: input.executable,
            args: [
              '--print',
              '--output-format',
              'text',
              '--setting-sources',
              'user',
              '--strict-mcp-config',
              '--permission-mode',
              'plan',
              '--no-chrome'
            ],
            environment: {
              ...baseEnvironment(input.executable, dependencies.homeDirectory),
              CLAUDE_CODE_OAUTH_TOKEN: await (
                dependencies.claudeOauthToken ?? readClaudeOauthToken
              )()
            },
            workingDirectory: input.checkout,
            stdin: `${summaryPreamble()}\n\n${input.prompt}`,
            timeoutMs: SUMMARY_TIMEOUT_MS
          })
        ).trim()
      )
    },
    steer: () => Effect.succeed(false),
    interrupt: () => Effect.succeed(false),
    answerApproval(input) {
      return Effect.try({
        try: () => {
          const host = input.host
          if (!host?.hasOutstandingApproval(input.approvalId)) return false
          return host.resolveApproval(
            input.approvalId,
            input.allowed
              ? {
                  behavior: 'allow',
                  ...(input.remembered && input.proposal.proposed?.harness === 'claude'
                    ? {
                        sessionRule: {
                          toolName: input.proposal.proposed.toolName,
                          content: input.proposal.proposed.content
                        }
                      }
                    : {})
                }
              : {
                  behavior: 'deny',
                  message:
                    input.reason ?? 'You declined this in the app. Ask before trying it again.'
                }
          )
        },
        catch: (cause) => new HarnessAdapterError('answer the Claude Approval Request', cause)
      })
    },
    terminalFact: () => null
  }
}

const ADAPTER_FACTORIES: Record<HarnessId, (layer: HarnessAdapterExternalLayer) => HarnessAdapter> =
  {
    codex: createCodexAdapter,
    claude: createClaudeAdapter
  }

/** Selects one complete Harness implementation; callers stay Harness-agnostic after this point. */
export function createHarnessAdapter(
  harness: HarnessId,
  layer: HarnessAdapterExternalLayer
): HarnessAdapter {
  return ADAPTER_FACTORIES[harness](layer)
}
