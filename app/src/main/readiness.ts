import { spawn } from 'node:child_process'
import { access, constants, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isGating } from '@shared/readiness'
import type {
  PathSource,
  HarnessId,
  HarnessCapability,
  HarnessReadiness,
  ReadinessCheck,
  ReadinessCode,
  ReadinessDimension,
  ReadinessStatus,
  RemediationLink
} from '@shared/readiness'
import { describeHarnessUpdate } from './harness-install'
import { discoverGlobalSkills } from './skills'

/**
 * Harness and skill readiness probing. Discovery is deliberately narrow:
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

/** Hosts of every remediation link, so the open-link allowlist cannot drift. */
export function readinessLinkHosts(): Set<string> {
  const links = [
    ...SKILLS_LINKS,
    ...Object.values(HARNESS_SPECS).flatMap((spec) => [spec.installLink, spec.authLink])
  ]
  return new Set(links.map((link) => new URL(link.url).hostname))
}

type AuthProbe = { kind: 'exit-code'; args: string[] } | { kind: 'stream-init'; args: string[] }

export interface HarnessSpec {
  id: HarnessId
  displayName: string
  command: string
  versionArgs: string[]
  /** Versions below this fail as incompatible. */
  minimumVersion: string
  /**
   * What this app can do with the Harness. `null` means no harness Adapter
   * exists for it yet, so the feature is declared unsupported rather than
   * offered and then failing.
   */
  conversation: { minimumVersion: string } | null
  /** Native mid-Run delivery; null means the honest fallback is the queue. */
  steering: { minimumVersion: string } | null
  /** Versions at or above this are untested: usable, with a warning. */
  untestedFrom: string
  authProbe: AuthProbe
  /** Copyable sign-in command shown when authentication fails. Never run. */
  authRemediationCommand: string
  /** Copyable install command shown when the executable is missing. Never run. */
  installCommand: string
  /** Home-relative root of the harness's documented skill location. */
  skillsRoot: string
  installLink: RemediationLink
  authLink: RemediationLink
}

export const HARNESS_SPECS: Record<HarnessId, HarnessSpec> = {
  codex: {
    id: 'codex',
    displayName: 'Codex',
    command: 'codex',
    versionArgs: ['--version'],
    minimumVersion: '0.100.0',
    // The app-server protocol, whose bindings are generated from the installed
    // binary. Below this version those bindings were never checked against
    // what the Harness sends, and a protocol the app misreads is a Run that
    // reports nothing.
    conversation: { minimumVersion: '0.146.0' },
    steering: { minimumVersion: '0.146.0' },
    untestedFrom: '0.147.0',
    authProbe: { kind: 'exit-code', args: ['login', 'status'] },
    authRemediationCommand: 'codex login',
    installCommand: 'npm install -g @openai/codex',
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
    // Stream JSON partial messages, hook events, and effort selection are the
    // protocol surface the Claude Adapter and Wayfinder bridge require.
    conversation: { minimumVersion: '2.1.0' },
    // Claude has no steering method to call: a Run's prompt goes in as a user
    // frame on stdin, and a second frame written while the turn is in flight is
    // folded into that same turn. Measured against 2.1.226 and recorded in
    // `.scratch/research/claude-steering-on-stdin.md`; below the version that
    // was probed the composer keeps saying queue, because nothing here has
    // watched an older binary do it.
    steering: { minimumVersion: '2.1.226' },
    untestedFrom: '2.2.0',
    // Print mode emits its system init line before any API request when the
    // CLI is signed in, and exits with a sign-in error when it is not. The
    // probe never sends a message.
    authProbe: {
      kind: 'stream-init',
      args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
    },
    authRemediationCommand: 'claude /login',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
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
}

function finishCheck(dimension: ReadinessDimension, draft: CheckDraft): ReadinessCheck {
  return {
    dimension,
    status: draft.status,
    code: draft.code,
    summary: draft.summary,
    command: draft.command ?? null,
    links: draft.links ?? []
  }
}

function notProbed(dimension: ReadinessDimension, spec: HarnessSpec): ReadinessCheck {
  return finishCheck(dimension, {
    status: 'not-probed',
    code: 'not-probed',
    summary: `Not checked because the ${spec.displayName} executable is unavailable.`
  })
}

async function probeCompatibility(
  spec: HarnessSpec,
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
  spec: HarnessSpec,
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

/**
 * How many Skills this Harness would find, and nothing more. There is no
 * required set: Skills are optional, a Harness that works is not made unusable
 * by an empty directory, and which ones exist is discovery's answer rather
 * than a list this file keeps.
 */
async function probeSkills(spec: HarnessSpec, homeDir: string): Promise<ReadinessCheck> {
  // Readiness is about this machine, so only the global directory is counted:
  // a Project's own Skills belong to that Project and are trusted there.
  const installed = (await discoverGlobalSkills(homeDir, spec.id)).length
  if (installed === 0) {
    return finishCheck('skills', {
      status: 'warning',
      code: 'skills-missing',
      summary: `No Skills are installed for ${spec.displayName}, so a Run cannot be asked to work to one. Everything else still works. Install some yourself with the command below — this app never runs it.`,
      command: SKILLS_INSTALL_COMMAND,
      links: SKILLS_LINKS
    })
  }
  return finishCheck('skills', {
    status: 'ready',
    code: 'ready',
    summary: `${installed === 1 ? '1 Skill is' : `${installed} Skills are`} installed for ${spec.displayName}. Type / in the composer to work to one.`
  })
}

export async function probeHarness(
  spec: HarnessSpec,
  options: ProbeOptions
): Promise<HarnessReadiness> {
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
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
          command: spec.installCommand,
          links: [spec.installLink]
        })
  }

  const skillsCheck = await probeSkills(spec, options.homeDir)

  let compatibilityCheck: ReadinessCheck
  let authenticationCheck: ReadinessCheck
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
  } else {
    compatibilityCheck = notProbed('compatibility', spec)
    authenticationCheck = notProbed('authentication', spec)
  }

  // Being there, being a version this app can talk to, and being signed in.
  // Nothing else decides whether a Harness can be used: the app stopped using
  // macOS Seatbelt itself in ticket 02, and gating on a facility only the
  // Harness uses made this app refuse a Harness over its own business.
  const checks = [executableCheck, compatibilityCheck, authenticationCheck, skillsCheck]
  const available = checks
    .filter((entry) => isGating(entry.dimension))
    .every((entry) => entry.status === 'ready' || entry.status === 'warning')
  // The command on PATH is usually a symlink, and only what it points at can
  // say how the Harness was installed.
  const realExecutablePath = executablePath
    ? await realpath(executablePath).catch(() => null)
    : null
  return {
    harness: spec.id,
    displayName: spec.displayName,
    command: spec.command,
    executablePath,
    executableSource: source,
    version,
    checks,
    capabilities: {
      developSession: describeConversationCapability(spec, {
        available,
        version,
        paths: [executablePath, realExecutablePath]
      }),
      steerRun: describeSteeringCapability(spec, { available, version })
    },
    checkedAt: new Date().toISOString(),
    available
  }
}

function describeSteeringCapability(
  spec: HarnessSpec,
  state: { available: boolean; version: string | null }
): HarnessCapability {
  if (!spec.steering) {
    return {
      available: false,
      summary: `${spec.displayName} messages sent during a Run wait in the queue.`,
      command: null
    }
  }
  const available =
    state.available &&
    state.version !== null &&
    compareVersions(state.version, spec.steering.minimumVersion) >= 0
  return {
    available,
    summary: available
      ? `${spec.displayName} can receive a message in the Run already in progress.`
      : `${spec.displayName} messages sent during this Run wait in the queue.`,
    command: null
  }
}

/**
 * Whether this Harness can develop a Session, and if not, what the person can
 * do about it. An unsupported Harness stays visible with a reason: silently
 * omitting it looks like a bug, and looks the same as a broken install.
 */
function describeConversationCapability(
  spec: HarnessSpec,
  state: { available: boolean; version: string | null; paths: (string | null)[] }
): HarnessCapability {
  if (!spec.conversation) {
    return {
      available: false,
      summary: `This app cannot run a Session with ${spec.displayName} yet. Support for it arrives in a later milestone.`,
      command: null
    }
  }
  if (!state.available) {
    return {
      available: false,
      summary: `${spec.displayName} is not ready yet. The checks below say what needs repairing.`,
      command: null
    }
  }
  const required = spec.conversation.minimumVersion
  if (state.version && compareVersions(state.version, required) < 0) {
    return {
      available: false,
      // Below this version the Harness reports its work in a shape this
      // app's Adapter cannot read, so a Run would produce nothing usable.
      summary: `Developing a Session needs ${spec.displayName} ${required} or newer. You have ${state.version}.`,
      command: describeHarnessUpdate(spec.id, state.paths)
    }
  }
  return {
    available: true,
    summary: `This app can run a Session with ${spec.displayName}.`,
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
const PATH_MARKER_BEGIN = '__APP_PATH_BEGIN__'
const PATH_MARKER_END = '__APP_PATH_END__'

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
