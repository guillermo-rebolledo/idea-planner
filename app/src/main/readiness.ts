import { spawn } from 'node:child_process'
import { access, constants, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  PathSource,
  ProviderId,
  ProviderCapability,
  ProviderReadiness,
  ReadinessCheck,
  ReadinessCode,
  ReadinessDimension,
  ReadinessStatus,
  RemediationLink
} from '@shared/readiness'
import type { PlanningWorkflow } from '@shared/run'
import { describeProviderUpdate } from './provider-install'

/**
 * Provider and skill readiness probing. Discovery is deliberately narrow:
 * exact configured command names resolved against an explicit PATH (inherited
 * and launchctl, plus a login shell only after one-time consent) — never a
 * directory enumeration or disk scan. Probes execute fixed argument vectors
 * with `shell: false`, a minimal environment, and bounded timeouts. The app
 * never installs, upgrades, authenticates, or substitutes anything.
 */

export const SKILLS_INSTALL_COMMAND = 'npx skills@latest add mattpocock/skills'

const SKILLS_LINKS: RemediationLink[] = [
  { label: 'Matt Pocock’s skills repository', url: 'https://github.com/mattpocock/skills' },
  { label: 'Node.js (provides npm and npx)', url: 'https://nodejs.org' }
]

/** The workflows this product invokes plus their reviewed dependency closure. */
const REQUIRED_SKILLS = ['grill-me', 'grilling', 'wayfinder']

/**
 * The exact skill identity each planning workflow is allowed to invoke. A
 * workflow absent here has not been reviewed and verified, so the app refuses
 * to start a Run for it rather than reaching for a plausible directory name.
 */
export const VERIFIED_WORKFLOW_SKILLS: Partial<Record<PlanningWorkflow, string>> = {
  grilling: 'grilling',
  wayfinder: 'wayfinder'
}

/** Hosts of every remediation link, so the open-link allowlist cannot drift. */
export function readinessLinkHosts(): Set<string> {
  const links = [
    ...SKILLS_LINKS,
    ...Object.values(PROVIDER_SPECS).flatMap((spec) => [spec.installLink, spec.authLink])
  ]
  return new Set(links.map((link) => new URL(link.url).hostname))
}

type AuthProbe = { kind: 'exit-code'; args: string[] } | { kind: 'stream-init'; args: string[] }
type SandboxProbe = { kind: 'exit-code'; args: string[] } | { kind: 'host-sandbox-exec' }

export interface ProviderSpec {
  id: ProviderId
  displayName: string
  command: string
  versionArgs: string[]
  /** Versions below this fail as incompatible. */
  minimumVersion: string
  /**
   * What this app can do with the provider. `null` means no harness Adapter
   * exists for it yet, so the feature is declared unsupported rather than
   * offered and then failing.
   */
  conversation: { minimumVersion: string } | null
  /** Versions at or above this are untested: usable, with a warning. */
  untestedFrom: string
  authProbe: AuthProbe
  sandboxProbe: SandboxProbe
  /** Copyable sign-in command shown when authentication fails. Never run. */
  authRemediationCommand: string
  /** Home-relative root of the harness's documented skill location. */
  skillsRoot: string
  installLink: RemediationLink
  authLink: RemediationLink
}

export const PROVIDER_SPECS: Record<ProviderId, ProviderSpec> = {
  codex: {
    id: 'codex',
    displayName: 'Codex',
    command: 'codex',
    versionArgs: ['--version'],
    minimumVersion: '0.100.0',
    // `codex exec --json` began emitting the thread/turn/item events this
    // app's Adapter parses in 0.44.0 (openai/codex 7fc3edf, released as
    // 0.44.0 on npm); earlier versions emit a shape it cannot read. This is
    // below `minimumVersion`, so today it never binds — it is here so the
    // Adapter's real requirement is recorded and enforced when either number
    // moves.
    conversation: { minimumVersion: '0.44.0' },
    untestedFrom: '0.147.0',
    authProbe: { kind: 'exit-code', args: ['login', 'status'] },
    authRemediationCommand: 'codex login',
    // Codex's own Seatbelt runner proves the native macOS sandbox works.
    sandboxProbe: { kind: 'exit-code', args: ['sandbox', '/usr/bin/true'] },
    skillsRoot: '.agents/skills',
    installLink: { label: 'Install Codex CLI', url: 'https://developers.openai.com/codex/cli' },
    authLink: { label: 'Codex sign-in guidance', url: 'https://developers.openai.com/codex/cli' }
  },
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    command: 'claude',
    versionArgs: ['--version'],
    minimumVersion: '2.0.0',
    conversation: null,
    untestedFrom: '2.2.0',
    // Print mode emits its system init line before any API request when the
    // CLI is signed in, and exits with a sign-in error when it is not. The
    // probe never sends a message.
    authProbe: {
      kind: 'stream-init',
      args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
    },
    authRemediationCommand: 'claude /login',
    sandboxProbe: { kind: 'host-sandbox-exec' },
    skillsRoot: '.claude/skills',
    installLink: { label: 'Install Claude Code', url: 'https://code.claude.com/docs/en/overview' },
    authLink: { label: 'Claude Code sign-in guidance', url: 'https://code.claude.com/docs/en/iam' }
  }
}

export interface ProbeOptions {
  pathEntries: string[]
  /** A user-selected executable that replaces PATH resolution, never silently. */
  explicitExecutable?: string
  homeDir: string
  probeTimeoutMs?: number
  /** Host Seatbelt binary consulted for `host-sandbox-exec` probes. */
  sandboxExecPath?: string
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000
const OUTPUT_LIMIT_BYTES = 64 * 1024

type RunResult =
  | { outcome: 'exit'; code: number; stdout: string; stderr: string }
  | { outcome: 'timeout' }
  | { outcome: 'spawn-error' }

interface RunOptions {
  timeoutMs: number
  pathEntries: string[]
  homeDir: string
  /** Resolves early with `exit`-shaped success when a stdout line matches. */
  untilStdoutLine?: (line: string) => boolean
}

function runProbe(file: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      shell: false,
      env: { PATH: options.pathEntries.join(':'), HOME: options.homeDir },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const settle = (result: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve(result)
    }

    const timer = setTimeout(() => settle({ outcome: 'timeout' }), options.timeoutMs)

    child.on('error', () => settle({ outcome: 'spawn-error' }))
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(0, OUTPUT_LIMIT_BYTES)
      if (options.untilStdoutLine && stdout.split('\n').some(options.untilStdoutLine)) {
        settle({ outcome: 'exit', code: 0, stdout, stderr })
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(0, OUTPUT_LIMIT_BYTES)
    })
    child.on('close', (code) => settle({ outcome: 'exit', code: code ?? 1, stdout, stderr }))
  })
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolves only the exact command name against the given entries. */
export async function resolveExecutable(
  command: string,
  pathEntries: string[]
): Promise<string | null> {
  for (const entry of pathEntries) {
    if (!entry) continue
    const candidate = join(entry, command)
    if (await isExecutableFile(candidate)) return candidate
  }
  return null
}

function parseVersion(output: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(output)?.[0] ?? null
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

interface CheckDraft {
  status: ReadinessStatus
  code: ReadinessCode
  summary: string
  command?: string
  links?: RemediationLink[]
  missingSkills?: string[]
}

function finishCheck(dimension: ReadinessDimension, draft: CheckDraft): ReadinessCheck {
  return {
    dimension,
    status: draft.status,
    code: draft.code,
    summary: draft.summary,
    command: draft.command ?? null,
    links: draft.links ?? [],
    missingSkills: draft.missingSkills ?? []
  }
}

function notProbed(dimension: ReadinessDimension, spec: ProviderSpec): ReadinessCheck {
  return finishCheck(dimension, {
    status: 'not-probed',
    code: 'not-probed',
    summary: `Not checked because the ${spec.displayName} executable is unavailable.`
  })
}

async function probeCompatibility(
  spec: ProviderSpec,
  run: (args: string[], untilStdoutLine?: (line: string) => boolean) => Promise<RunResult>
): Promise<{ check: ReadinessCheck; version: string | null }> {
  const result = await run(spec.versionArgs)
  if (result.outcome === 'timeout') {
    return {
      version: null,
      check: finishCheck('compatibility', {
        status: 'failed',
        code: 'probe-timeout',
        summary: `${spec.displayName} did not answer its version check in time.`,
        command: `${spec.command} ${spec.versionArgs.join(' ')}`,
        links: [spec.installLink]
      })
    }
  }
  if (result.outcome === 'spawn-error' || result.code !== 0) {
    return {
      version: null,
      check: finishCheck('compatibility', {
        status: 'failed',
        code: 'probe-failed',
        summary: `${spec.displayName} could not be started for its version check.`,
        command: `${spec.command} ${spec.versionArgs.join(' ')}`,
        links: [spec.installLink]
      })
    }
  }
  const version = parseVersion(result.stdout)
  if (!version) {
    return {
      version: null,
      check: finishCheck('compatibility', {
        status: 'failed',
        code: 'version-unrecognized',
        summary: `${spec.displayName} reported a version this app does not recognize.`,
        command: `${spec.command} ${spec.versionArgs.join(' ')}`,
        links: [spec.installLink]
      })
    }
  }
  if (compareVersions(version, spec.minimumVersion) < 0) {
    return {
      version,
      check: finishCheck('compatibility', {
        status: 'failed',
        code: 'version-incompatible',
        summary: `${spec.displayName} ${version} is older than the supported minimum ${spec.minimumVersion}.`,
        links: [spec.installLink]
      })
    }
  }
  if (compareVersions(version, spec.untestedFrom) >= 0) {
    return {
      version,
      check: finishCheck('compatibility', {
        status: 'warning',
        code: 'version-untested',
        summary: `${spec.displayName} ${version} is newer than the versions this app was tested with. It stays usable.`,
        links: [spec.installLink]
      })
    }
  }
  return {
    version,
    check: finishCheck('compatibility', {
      status: 'ready',
      code: 'ready',
      summary: `${spec.displayName} ${version} is a tested, compatible version.`
    })
  }
}

async function probeAuthentication(
  spec: ProviderSpec,
  run: (args: string[], untilStdoutLine?: (line: string) => boolean) => Promise<RunResult>
): Promise<ReadinessCheck> {
  const probe = spec.authProbe
  const failure = (code: ReadinessCode, summary: string): ReadinessCheck =>
    finishCheck('authentication', {
      status: 'failed',
      code,
      summary,
      command: spec.authRemediationCommand,
      links: [spec.authLink]
    })

  if (probe.kind === 'exit-code') {
    const result = await run(probe.args)
    if (result.outcome === 'timeout') {
      return failure(
        'probe-timeout',
        `${spec.displayName} did not answer its sign-in check in time.`
      )
    }
    if (result.outcome === 'spawn-error') {
      return failure(
        'probe-failed',
        `${spec.displayName} could not be asked about its sign-in state.`
      )
    }
    if (result.code !== 0) {
      return failure('unauthenticated', `${spec.displayName} reports it is not signed in.`)
    }
  } else {
    const isInitLine = (line: string): boolean => {
      try {
        const parsed: unknown = JSON.parse(line)
        return (
          typeof parsed === 'object' &&
          parsed !== null &&
          'type' in parsed &&
          parsed.type === 'system'
        )
      } catch {
        return false
      }
    }
    const result = await run(probe.args, isInitLine)
    if (result.outcome === 'timeout') {
      return failure(
        'probe-timeout',
        `${spec.displayName} did not answer its sign-in check in time.`
      )
    }
    if (result.outcome === 'spawn-error') {
      return failure(
        'probe-failed',
        `${spec.displayName} could not be asked about its sign-in state.`
      )
    }
    if (result.code !== 0 || !result.stdout.split('\n').some(isInitLine)) {
      return failure(
        'unauthenticated',
        `${spec.displayName} exited before starting a session, which is how it reports a missing sign-in.`
      )
    }
  }
  return finishCheck('authentication', {
    status: 'ready',
    code: 'ready',
    summary: `${spec.displayName} reports it is signed in.`
  })
}

async function probeSandbox(
  spec: ProviderSpec,
  sandboxExecPath: string,
  run: (args: string[], untilStdoutLine?: (line: string) => boolean) => Promise<RunResult>
): Promise<ReadinessCheck> {
  const unavailable = (
    summary: string,
    code: ReadinessCode = 'sandbox-unavailable'
  ): ReadinessCheck =>
    finishCheck('sandbox', {
      status: 'failed',
      code,
      summary,
      links: [spec.installLink]
    })

  if (spec.sandboxProbe.kind === 'exit-code') {
    const result = await run(spec.sandboxProbe.args)
    if (result.outcome === 'timeout') {
      return unavailable(
        `${spec.displayName} did not finish its sandbox verification in time.`,
        'probe-timeout'
      )
    }
    if (result.outcome === 'spawn-error' || result.code !== 0) {
      return unavailable(`${spec.displayName} could not verify its native macOS sandbox.`)
    }
  } else if (!(await isExecutableFile(sandboxExecPath))) {
    return unavailable('The native macOS sandbox runtime is unavailable on this system.')
  }
  return finishCheck('sandbox', {
    status: 'ready',
    code: 'ready',
    summary: 'The native macOS planning sandbox is available.'
  })
}

async function probeSkills(spec: ProviderSpec, homeDir: string): Promise<ReadinessCheck> {
  const missing: string[] = []
  for (const name of REQUIRED_SKILLS) {
    // Exact documented location for this harness — never a directory walk.
    const skillFile = join(homeDir, spec.skillsRoot, name, 'SKILL.md')
    try {
      const info = await stat(skillFile)
      if (!info.isFile()) missing.push(name)
    } catch {
      missing.push(name)
    }
  }
  if (missing.length > 0) {
    return finishCheck('skills', {
      status: 'failed',
      code: 'skills-missing',
      summary: `The Matt Pocock planning skills are not installed for ${spec.displayName}. Install them yourself with the command below — this app never runs it.`,
      command: SKILLS_INSTALL_COMMAND,
      links: SKILLS_LINKS,
      missingSkills: missing
    })
  }
  return finishCheck('skills', {
    status: 'ready',
    code: 'ready',
    summary: 'Matt Pocock’s Grill Me and Wayfinder skills and their dependencies are installed.'
  })
}

export async function probeProvider(
  spec: ProviderSpec,
  options: ProbeOptions
): Promise<ProviderReadiness> {
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const sandboxExecPath = options.sandboxExecPath ?? '/usr/bin/sandbox-exec'
  const source = options.explicitExecutable ? 'explicit' : 'path'

  let executablePath: string | null = null
  let executableCheck: ReadinessCheck
  if (options.explicitExecutable) {
    if (await isExecutableFile(options.explicitExecutable)) {
      executablePath = options.explicitExecutable
      executableCheck = finishCheck('executable', {
        status: 'ready',
        code: 'ready',
        summary: `Using the executable you selected: ${options.explicitExecutable}`
      })
    } else {
      executableCheck = finishCheck('executable', {
        status: 'failed',
        code: 'selected-executable-invalid',
        summary: 'The selected file is no longer an executable program. Choose it again.',
        links: [spec.installLink]
      })
    }
  } else {
    executablePath = await resolveExecutable(spec.command, options.pathEntries)
    executableCheck = executablePath
      ? finishCheck('executable', {
          status: 'ready',
          code: 'ready',
          summary: `Found ${spec.command} at ${executablePath}`
        })
      : finishCheck('executable', {
          status: 'failed',
          code: 'executable-missing',
          summary: `The ${spec.command} command was not found on this app’s PATH. Install it, or choose the executable yourself.`,
          links: [spec.installLink]
        })
  }

  const skillsCheck = await probeSkills(spec, options.homeDir)

  let compatibilityCheck: ReadinessCheck
  let authenticationCheck: ReadinessCheck
  let sandboxCheck: ReadinessCheck
  let version: string | null = null

  if (executablePath) {
    const executable = executablePath
    const run = (args: string[], untilStdoutLine?: (line: string) => boolean): Promise<RunResult> =>
      runProbe(executable, args, {
        timeoutMs,
        pathEntries: options.pathEntries,
        homeDir: options.homeDir,
        untilStdoutLine
      })
    const compatibility = await probeCompatibility(spec, run)
    compatibilityCheck = compatibility.check
    version = compatibility.version
    authenticationCheck = await probeAuthentication(spec, run)
    sandboxCheck = await probeSandbox(spec, sandboxExecPath, run)
  } else {
    compatibilityCheck = notProbed('compatibility', spec)
    authenticationCheck = notProbed('authentication', spec)
    sandboxCheck = notProbed('sandbox', spec)
  }

  const checks = [
    executableCheck,
    compatibilityCheck,
    authenticationCheck,
    sandboxCheck,
    skillsCheck
  ]
  const available = checks.every((entry) => entry.status === 'ready' || entry.status === 'warning')
  // The command on PATH is usually a symlink, and only what it points at can
  // say how the provider was installed.
  const realExecutablePath = executablePath
    ? await realpath(executablePath).catch(() => null)
    : null
  return {
    provider: spec.id,
    displayName: spec.displayName,
    command: spec.command,
    executablePath,
    executableSource: source,
    version,
    checks,
    capabilities: {
      developIdea: describeConversationCapability(spec, {
        available,
        version,
        paths: [executablePath, realExecutablePath]
      })
    },
    checkedAt: new Date().toISOString(),
    available
  }
}

/**
 * Whether this provider can develop an Idea, and if not, what the person can
 * do about it. An unsupported provider stays visible with a reason: silently
 * omitting it looks like a bug, and looks the same as a broken install.
 */
function describeConversationCapability(
  spec: ProviderSpec,
  state: { available: boolean; version: string | null; paths: (string | null)[] }
): ProviderCapability {
  if (!spec.conversation) {
    return {
      available: false,
      summary: `Developing an Idea with ${spec.displayName} is not supported yet. Its harness Adapter arrives in a later milestone.`,
      command: null
    }
  }
  if (!state.available) {
    return {
      available: false,
      summary: `${spec.displayName} is not ready yet. Open AI Providers to see which check needs repairing.`,
      command: null
    }
  }
  const required = spec.conversation.minimumVersion
  if (state.version && compareVersions(state.version, required) < 0) {
    return {
      available: false,
      // Below this version the provider reports its work in a shape this
      // app's Adapter cannot read, so a Run would produce nothing usable.
      summary: `Developing an Idea needs ${spec.displayName} ${required} or newer. You have ${state.version}.`,
      command: describeProviderUpdate(spec.id, state.paths)
    }
  }
  return {
    available: true,
    summary: `Ready to develop an Idea with ${spec.displayName}.`,
    command: null
  }
}

export interface DiscoverOptions {
  inheritedPath: string | undefined
  loginShellConsent: boolean
  /** Injectable probes; production defaults execute launchctl and the shell. */
  probeLaunchctlPath?: () => Promise<string | null>
  probeLoginShellPath?: () => Promise<string | null>
}

function splitPath(value: string | null | undefined): string[] {
  return (value ?? '').split(':').filter((entry) => entry.length > 0)
}

const LOGIN_SHELL_TIMEOUT_MS = 5000
const LAUNCHCTL_TIMEOUT_MS = 2000
const PATH_MARKER_BEGIN = '__IDEA_PATH_BEGIN__'
const PATH_MARKER_END = '__IDEA_PATH_END__'

async function runForOutput(
  file: string,
  args: string[],
  timeoutMs: number
): Promise<string | null> {
  const result = await runProbe(file, args, {
    timeoutMs,
    pathEntries: splitPath(process.env['PATH']),
    homeDir: process.env['HOME'] ?? ''
  })
  if (result.outcome !== 'exit' || result.code !== 0) return null
  return result.stdout
}

export async function probeLaunchctlPathDefault(): Promise<string | null> {
  const output = await runForOutput('/bin/launchctl', ['getenv', 'PATH'], LAUNCHCTL_TIMEOUT_MS)
  const value = output?.trim()
  return value === undefined || value === '' ? null : value
}

/**
 * Executes the person's login shell startup files — allowed only after the
 * one-time informed consent recorded in settings. Output is fenced with fixed
 * markers so startup banners cannot be mistaken for the PATH.
 */
export async function probeLoginShellPathDefault(): Promise<string | null> {
  const shell = process.env['SHELL'] ?? '/bin/zsh'
  const capture = `printf '${PATH_MARKER_BEGIN}%s${PATH_MARKER_END}' "$PATH"`
  const output = await runForOutput(shell, ['-ilc', capture], LOGIN_SHELL_TIMEOUT_MS)
  if (!output) return null
  const begin = output.indexOf(PATH_MARKER_BEGIN)
  const end = output.indexOf(PATH_MARKER_END)
  if (begin === -1 || end === -1 || end <= begin) return null
  const value = output.slice(begin + PATH_MARKER_BEGIN.length, end).trim()
  return value === '' ? null : value
}

export interface DiscoveredPath {
  entries: string[]
  sources: PathSource[]
}

export async function discoverPathEntries(options: DiscoverOptions): Promise<DiscoveredPath> {
  const probeLaunchctl = options.probeLaunchctlPath ?? probeLaunchctlPathDefault
  const probeLoginShell = options.probeLoginShellPath ?? probeLoginShellPathDefault

  const loginShell = options.loginShellConsent ? splitPath(await probeLoginShell()) : []
  const launchctl = splitPath(await probeLaunchctl())
  const inherited = splitPath(options.inheritedPath)

  const entries: string[] = []
  const sources: PathSource[] = []
  const contributions: [PathSource, string[]][] = [
    ['login-shell', loginShell],
    ['launchctl', launchctl],
    ['inherited', inherited]
  ]
  for (const [sourceName, sourceEntries] of contributions) {
    if (sourceEntries.length === 0) continue
    sources.push(sourceName)
    for (const entry of sourceEntries) {
      if (!entries.includes(entry)) entries.push(entry)
    }
  }
  return { entries, sources }
}
