import { execFile, spawn as nodeSpawn, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { promisify } from 'node:util'

export interface SpawnedProcess {
  pid?: number
  stdout: NodeJS.EventEmitter
  stderr: NodeJS.EventEmitter
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

export interface RunLaunch {
  id: string
  executable: string
  args: string[]
  workingDirectory: string
  runDirectory: string
  environment: Record<string, string>
  sandboxProfile: string
  onBeforeCleanup?: () => Promise<void>
  /** Raw provider bytes, by stream. Main never interprets them itself. */
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  onSupervisionFailure?: () => void
  onLimitViolation?: (summary: string) => void
}

interface BrokerDeps {
  spawn: (file: string, args: string[], options: SpawnOptionsWithoutStdio) => SpawnedProcess
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void
  waitForGroupExit: (pid: number) => Promise<void>
  cleanupRunDirectory?: (path: string) => Promise<void>
  outputLimitBytes?: number
  countProcessGroupMembers?: (pid: number) => Promise<number>
  monitorIntervalMs?: number
}

interface ActiveRun {
  pid: number
  runDirectory: string
  outputBytes: number
  stopping: boolean
  launch: RunLaunch
  monitor?: NodeJS.Timeout
}

const defaultDeps: BrokerDeps = {
  // stdin is closed: a provider that reads stdin for extra input would
  // otherwise wait forever on a pipe this app never writes to.
  spawn: (file, args, options) =>
    nodeSpawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }),
  killProcessGroup: (pid, signal) => process.kill(-pid, signal),
  waitForGroupExit: async (pid) => {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      try {
        process.kill(-pid, 0)
      } catch {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('process group is still alive')
  },
  countProcessGroupMembers: async (pid) => {
    const { stdout } = await promisify(execFile)('/bin/ps', ['-o', 'pid=', '-g', String(pid)])
    return stdout.split('\n').filter((line) => line.trim()).length
  },
  monitorIntervalMs: 250
}

/** Owns exactly one detached OS process group for each active Run. */
export class RunProcessBroker {
  private readonly active = new Map<string, ActiveRun>()
  private supervisionFailed = false

  constructor(private readonly deps: BrokerDeps = defaultDeps) {}

  start(launch: RunLaunch): Promise<void> {
    if (this.supervisionFailed) {
      return Promise.reject(
        new Error('Supervision recovery is required before starting another Run')
      )
    }
    if (this.active.has(launch.id)) return Promise.resolve()
    const args = [
      '-n',
      '10',
      '/usr/bin/sandbox-exec',
      '-f',
      launch.sandboxProfile,
      launch.executable,
      ...launch.args
    ]
    const child = this.deps.spawn('/usr/bin/nice', args, {
      cwd: launch.workingDirectory,
      env: { ...launch.environment, TMPDIR: launch.runDirectory },
      shell: false,
      detached: true,
      windowsHide: true
    })
    if (!child.pid) {
      return Promise.reject(new Error('Provider process did not report a process-group id'))
    }
    const pid = child.pid
    const entry: ActiveRun = {
      pid,
      runDirectory: launch.runDirectory,
      outputBytes: 0,
      stopping: false,
      launch
    }
    this.active.set(launch.id, entry)
    if (this.deps.monitorIntervalMs !== undefined) {
      entry.monitor = setInterval(
        () => void this.inspectLimits(launch.id).catch(() => this.failSupervision(launch.id)),
        this.deps.monitorIntervalMs
      )
    }
    child.stdout.on('data', (chunk) => this.observeOutput(launch, chunk, 'stdout'))
    child.stderr.on('data', (chunk) => this.observeOutput(launch, chunk, 'stderr'))
    // `close` follows `exit` only after stdout/stderr have drained, so the
    // adapter cannot miss a final protocol frame written during shutdown.
    child.once('close', (code, signal) => {
      if (this.active.get(launch.id)?.stopping) return
      void (async () => {
        try {
          await this.terminateAndVerify(pid)
          await launch.onBeforeCleanup?.()
          await this.cleanup(launch.runDirectory)
          this.clearMonitor(launch.id)
          this.active.delete(launch.id)
          launch.onExit?.(code, signal)
        } catch {
          this.supervisionFailed = true
          launch.onSupervisionFailure?.()
        }
      })()
    })
    return Promise.resolve()
  }

  async stop(
    runId: string,
    _reason: 'user' | 'complete' | 'failure' | 'policy' | 'core-crash' | 'quit' | 'update'
  ): Promise<void> {
    const entry = this.active.get(runId)
    if (!entry) return
    entry.stopping = true
    try {
      await this.terminateAndVerify(entry.pid)
      await entry.launch.onBeforeCleanup?.()
      await this.cleanup(entry.runDirectory)
      this.clearMonitor(runId)
      this.active.delete(runId)
    } catch {
      this.supervisionFailed = true
      throw new Error('Run supervision could not verify process-group exit and private cleanup')
    }
  }

  async stopAll(reason: 'core-crash' | 'quit' | 'update'): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.stop(id, reason)))
  }

  activeRunIds(): string[] {
    return [...this.active.keys()]
  }
  needsRecovery(): boolean {
    return this.supervisionFailed
  }

  async inspectLimits(runId: string): Promise<void> {
    const entry = this.active.get(runId)
    if (!entry || entry.stopping || !this.deps.countProcessGroupMembers) return
    const count = await this.deps.countProcessGroupMembers(entry.pid).catch((error: unknown) => {
      if (isMissingProcessGroup(error)) return 0
      throw error
    })
    if (count <= 16) return
    entry.stopping = true
    entry.launch.onLimitViolation?.('Provider process tree exceeded the 16-process Run limit')
    await this.stop(runId, 'policy').catch(() => entry.launch.onSupervisionFailure?.())
  }

  private async terminateAndVerify(pid: number): Promise<void> {
    try {
      this.deps.killProcessGroup(pid, 'SIGTERM')
    } catch {
      // The group may already be gone; verification below is authoritative.
    }
    try {
      await this.deps.waitForGroupExit(pid)
      return
    } catch {
      try {
        this.deps.killProcessGroup(pid, 'SIGKILL')
      } catch {
        // Verification below still decides whether supervision succeeded.
      }
      await this.deps.waitForGroupExit(pid)
    }
  }

  private cleanup(path: string): Promise<void> {
    const cleanup =
      this.deps.cleanupRunDirectory ??
      ((target: string) => rm(target, { recursive: true, force: true }))
    return cleanup(path)
  }

  private failSupervision(runId: string): void {
    const entry = this.active.get(runId)
    if (!entry || entry.stopping) return
    entry.stopping = true
    this.supervisionFailed = true
    this.clearMonitor(runId)
    entry.launch.onSupervisionFailure?.()
  }

  private clearMonitor(runId: string): void {
    const monitor = this.active.get(runId)?.monitor
    if (monitor) clearInterval(monitor)
  }

  private observeOutput(launch: RunLaunch, chunk: unknown, stream: 'stdout' | 'stderr'): void {
    const entry = this.active.get(launch.id)
    if (!entry || entry.stopping) return
    const text =
      typeof chunk === 'string'
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : String(chunk)
    entry.outputBytes += Buffer.byteLength(text)
    if (entry.outputBytes > (this.deps.outputLimitBytes ?? 10 * 1024 * 1024)) {
      entry.stopping = true
      launch.onLimitViolation?.('Provider output exceeded the 10 MB Run limit')
      void this.stop(launch.id, 'policy').catch(() => launch.onSupervisionFailure?.())
      return
    }
    launch.onOutput?.(stream, text)
  }
}

function isMissingProcessGroup(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 1 || error.code === 'ESRCH')
  )
}
