import { execFile, spawn as nodeSpawn, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as ExecutionStrategy from 'effect/ExecutionStrategy'
import * as Exit from 'effect/Exit'
import * as FiberId from 'effect/FiberId'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Scope from 'effect/Scope'
import { nativeProjectCloneLayer } from './project-clone-native'
import type { NativeProjectClone } from './project-clone-native'

export interface SpawnedProcess {
  pid?: number
  stdout: NodeJS.EventEmitter
  stderr: NodeJS.EventEmitter
  /** Present only for a Harness this app has to answer. */
  stdin?: { write(chunk: string): unknown; end?(): unknown } | null
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

export interface RunLaunch {
  id: string
  executable: string
  args: string[]
  workingDirectory: string
  runDirectory: string
  environment: Record<string, string>
  /**
   * True for a Harness the app answers. Everything else keeps stdin closed:
   * one that reads it for extra input would otherwise wait forever on a pipe
   * nothing writes to.
   */
  answersProtocol?: boolean
  onBeforeCleanup?: () => Promise<void>
  /** Raw Harness bytes, by stream. Main never interprets them itself. */
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  onSupervisionFailure?: () => void
  onLimitViolation?: (summary: string) => void
}

export interface NativeRunServices {
  spawn: (file: string, args: string[], options: SpawnOptionsWithoutStdio) => SpawnedProcess
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void
  waitForGroupExit: (pid: number) => Promise<void>
  cleanupRunDirectory: (path: string) => Promise<void>
  outputLimitBytes: number
  countProcessGroupMembers: (pid: number) => Promise<number>
  monitorIntervalMs: number | undefined
  setMonitor: (inspect: () => void, intervalMs: number) => unknown
  clearMonitor: (monitor: unknown) => void
}

export type NativeRunOverrides = Pick<
  NativeRunServices,
  'spawn' | 'killProcessGroup' | 'waitForGroupExit'
> &
  Partial<Omit<NativeRunServices, 'spawn' | 'killProcessGroup' | 'waitForGroupExit'>>

interface ActiveRun {
  process: SpawnedProcess
  pid: number
  runDirectory: string
  outputBytes: number
  outputLimitBytes: number
  stopping: boolean
  launch: RunLaunch
  scope: Scope.CloseableScope
  monitor?: { handle: unknown; clear: (monitor: unknown) => void }
}

const defaultDeps: NativeRunServices = {
  // stdin is a pipe because one Harness is a conversation: Codex speaks the
  // app-server protocol and has to be answered. It is closed again for every
  // Harness that is only read.
  spawn: (file, args, options) =>
    nodeSpawn(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }),
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
  cleanupRunDirectory: (path) => rm(path, { recursive: true, force: true }),
  outputLimitBytes: 10 * 1024 * 1024,
  monitorIntervalMs: 250,
  setMonitor: (inspect, intervalMs) => setInterval(inspect, intervalMs),
  clearMonitor: (monitor) => clearInterval(monitor as NodeJS.Timeout)
}

export class NativeRun extends Context.Tag('main/NativeRun')<NativeRun, NativeRunServices>() {}

class RunSupervisionError extends Error {
  readonly _tag = 'RunSupervisionError'

  constructor(message: string, cause: unknown) {
    super(message, { cause })
  }
}

interface RunScopeOwnerService {
  fork(): Effect.Effect<Scope.CloseableScope>
}

class RunScopeOwner extends Context.Tag('main/RunScopeOwner')<
  RunScopeOwner,
  RunScopeOwnerService
>() {}

type MainRuntimeServices = NativeRun | RunScopeOwner | NativeProjectClone

/**
 * Main's one Effect runtime. Its root Scope follows Electron, and every Run
 * receives a child Scope so runtime disposal releases any Run still alive.
 */
export class MainEffectRuntime {
  constructor(
    private readonly runtime: ManagedRuntime.ManagedRuntime<MainRuntimeServices, never>
  ) {}

  runPromise<A, E>(effect: Effect.Effect<A, E, MainRuntimeServices>): Promise<A> {
    return this.runtime.runPromise(effect)
  }

  dispose(): Promise<void> {
    return this.runtime.dispose()
  }
}

/** A replaceable native layer: production defaults or deterministic test services. */
export function nativeRunLayer(
  overrides: NativeRunOverrides = defaultDeps
): Layer.Layer<NativeRun> {
  const native: NativeRunServices = { ...defaultDeps, ...overrides }
  return Layer.succeed(NativeRun, native)
}

/** Builds Main's runtime from the native layer selected at composition time. */
export function createMainEffectRuntime(
  native: Layer.Layer<NativeRun> = nativeRunLayer(),
  projectClone: Layer.Layer<NativeProjectClone> = nativeProjectCloneLayer()
): MainEffectRuntime {
  const scopes = Layer.scoped(
    RunScopeOwner,
    Effect.map(Effect.scope, (root) => ({
      fork: () => Scope.fork(root, ExecutionStrategy.sequential)
    }))
  )
  return new MainEffectRuntime(ManagedRuntime.make(Layer.mergeAll(native, scopes, projectClone)))
}

/** Owns exactly one detached OS process group for each active Run. */
export class RunProcessBroker {
  private readonly active = new Map<string, ActiveRun>()
  private supervisionFailed = false
  private readonly runtime: MainEffectRuntime

  constructor(runtimeOrDeps: MainEffectRuntime | NativeRunOverrides = defaultDeps) {
    this.runtime =
      runtimeOrDeps instanceof MainEffectRuntime
        ? runtimeOrDeps
        : createMainEffectRuntime(nativeRunLayer(runtimeOrDeps))
  }

  start(launch: RunLaunch): Promise<void> {
    if (this.supervisionFailed) {
      return Promise.reject(
        new Error('Supervision recovery is required before starting another Run')
      )
    }
    if (this.active.has(launch.id)) return Promise.resolve()
    const acquire = (native: NativeRunServices, scope: Scope.CloseableScope) =>
      Effect.acquireRelease(
        Effect.try({
          try: () => this.launch(native, scope, launch),
          catch: (cause) =>
            new RunSupervisionError('The Harness process could not be started', cause)
        }),
        (active) => this.release(native, active)
      )
    const observe = (entry: ActiveRun): void => this.observe(entry)
    return this.runtime.runPromise(
      Effect.gen(function* () {
        const native = yield* NativeRun
        const scopeOwner = yield* RunScopeOwner
        const scope = yield* scopeOwner.fork()
        const entry = yield* Scope.extend(acquire(native, scope), scope)
        observe(entry)
      })
    )
  }

  async stop(
    runId: string,
    _reason: 'user' | 'complete' | 'failure' | 'policy' | 'core-crash' | 'quit' | 'update'
  ): Promise<void> {
    const entry = this.active.get(runId)
    if (!entry) return
    entry.stopping = true
    try {
      await this.runtime.runPromise(Scope.close(entry.scope, Exit.interrupt(FiberId.none)))
    } catch {
      this.supervisionFailed = true
      throw new Error('Run supervision could not verify process-group exit and private cleanup')
    }
  }

  async stopAll(reason: 'core-crash' | 'quit' | 'update'): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.stop(id, reason)))
  }

  /**
   * Answers a Harness that is waiting to be answered. Silent when the Run has
   * already ended: a frame written to a dead process is not a failure of this
   * app, and the Run's own ending is what the person is told about.
   */
  write(runId: string, frame: string): void {
    const entry = this.active.get(runId)
    if (!entry || entry.stopping) return
    entry.process.stdin?.write(`${frame}\n`)
  }

  activeRunIds(): string[] {
    return [...this.active.keys()]
  }
  needsRecovery(): boolean {
    return this.supervisionFailed
  }

  async inspectLimits(runId: string): Promise<void> {
    const entry = this.active.get(runId)
    if (!entry || entry.stopping) return
    const count = await this.runtime.runPromise(
      Effect.gen(function* () {
        const native = yield* NativeRun
        return yield* Effect.tryPromise({
          try: () => native.countProcessGroupMembers(entry.pid),
          catch: (cause) => new RunSupervisionError('Could not inspect the process group', cause)
        }).pipe(Effect.catchIf(isMissingProcessGroupError, () => Effect.succeed(0)))
      })
    )
    if (count <= 16) return
    entry.stopping = true
    entry.launch.onLimitViolation?.('Harness process tree exceeded the 16-process Run limit')
    await this.stop(runId, 'policy').catch(() => entry.launch.onSupervisionFailure?.())
  }

  private launch(
    native: NativeRunServices,
    scope: Scope.CloseableScope,
    launch: RunLaunch
  ): ActiveRun {
    const args = ['-n', '10', launch.executable, ...launch.args]
    const child = native.spawn('/usr/bin/nice', args, {
      cwd: launch.workingDirectory,
      env: { ...launch.environment, TMPDIR: launch.runDirectory },
      shell: false,
      detached: true,
      windowsHide: true
    })
    if (!child.pid) throw new Error('The Harness process did not report a process-group id')
    const entry: ActiveRun = {
      process: child,
      pid: child.pid,
      runDirectory: launch.runDirectory,
      outputBytes: 0,
      outputLimitBytes: native.outputLimitBytes,
      stopping: false,
      launch,
      scope
    }
    this.active.set(launch.id, entry)
    if (native.monitorIntervalMs !== undefined) {
      entry.monitor = {
        handle: native.setMonitor(
          () => void this.inspectLimits(launch.id).catch(() => this.failSupervision(launch.id)),
          native.monitorIntervalMs
        ),
        clear: native.clearMonitor
      }
    }
    return entry
  }

  private observe(entry: ActiveRun): void {
    const { launch, process: child } = entry
    if (!launch.answersProtocol) child.stdin?.end?.()
    child.stdout.on('data', (chunk) => this.observeOutput(launch, chunk, 'stdout'))
    child.stderr.on('data', (chunk) => this.observeOutput(launch, chunk, 'stderr'))
    // `close` follows `exit` only after stdout/stderr have drained, so the
    // adapter cannot miss a final protocol frame written during shutdown.
    child.once('close', (code, signal) => {
      if (this.active.get(launch.id)?.stopping) return
      void this.runtime
        .runPromise(Scope.close(entry.scope, Exit.succeed(undefined)))
        .then(() => launch.onExit?.(code, signal))
        .catch(() => {
          this.supervisionFailed = true
          launch.onSupervisionFailure?.()
        })
    })
  }

  private release(native: NativeRunServices, entry: ActiveRun): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      entry.stopping = true
      this.clearMonitor(entry.launch.id)
      yield* Effect.tryPromise({
        try: () => this.terminateAndVerify(native, entry.pid),
        catch: (cause) => new RunSupervisionError('Could not stop the process group', cause)
      })
      if (entry.launch.onBeforeCleanup) {
        yield* Effect.tryPromise({
          try: entry.launch.onBeforeCleanup,
          catch: (cause) => new RunSupervisionError('Could not close the Run capability', cause)
        })
      }
      yield* Effect.tryPromise({
        try: () => native.cleanupRunDirectory(entry.runDirectory),
        catch: (cause) => new RunSupervisionError('Could not remove the Run directory', cause)
      })
      this.active.delete(entry.launch.id)
    }).pipe(Effect.orDie)
  }

  private async terminateAndVerify(native: NativeRunServices, pid: number): Promise<void> {
    try {
      native.killProcessGroup(pid, 'SIGTERM')
    } catch {
      // The group may already be gone; verification below is authoritative.
    }
    try {
      await native.waitForGroupExit(pid)
      return
    } catch {
      try {
        native.killProcessGroup(pid, 'SIGKILL')
      } catch {
        // Verification below still decides whether supervision succeeded.
      }
      await native.waitForGroupExit(pid)
    }
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
    if (monitor) monitor.clear(monitor.handle)
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
    if (entry.outputBytes > entry.outputLimitBytes) {
      entry.stopping = true
      launch.onLimitViolation?.('Harness output exceeded the 10 MB Run limit')
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

function isMissingProcessGroupError(error: RunSupervisionError): boolean {
  return isMissingProcessGroup(error.cause)
}
