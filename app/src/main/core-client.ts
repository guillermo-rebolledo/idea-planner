import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import {
  CONTRACT_VERSION,
  CoreError,
  coreResponseSchema,
  type CoreCommand,
  type CoreRequest
} from '@shared/contract'

const REQUEST_TIMEOUT_MS = 10_000

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Passing `env` to a utility process replaces its environment rather than
 * extending it, so the parent's is copied across first. Unset variables are
 * dropped rather than passed as the string "undefined".
 */
function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

/**
 * Main-side client for the Core utility process: spawn, correlated
 * request/response, and respawn supervision. Main never interprets product
 * behavior itself.
 */
export class CoreClient {
  private child: UtilityProcess | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private stopped = false

  /**
   * `stateDirectory` is read at spawn time rather than at construction, so it
   * can come from Electron's `app.getPath('userData')` once the app is ready
   * and still be correct for every respawn.
   */
  constructor(
    private readonly stateDirectory: () => string,
    private readonly onRespawn: () => void
  ) {}

  start(): void {
    this.stopped = false
    this.spawn()
  }

  stop(): void {
    this.stopped = true
    this.child?.kill()
    this.child = null
    this.failAllPending(new CoreError('IO_ERROR', 'Core is shutting down'))
  }

  send(command: CoreCommand): Promise<unknown> {
    const child = this.child
    if (!child) {
      return Promise.reject(new CoreError('IO_ERROR', 'Core is not running'))
    }
    const request: CoreRequest = { contractVersion: CONTRACT_VERSION, id: randomUUID(), command }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        reject(new CoreError('IO_ERROR', `Core did not answer ${command.type} in time`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(request.id, { resolve, reject, timer })
      child.postMessage(request)
    })
  }

  private spawn(): void {
    const child = utilityProcess.fork(join(__dirname, 'core.js'), [], {
      serviceName: 'app-core',
      env: { ...inheritedEnvironment(), APP_STATE_DIRECTORY: this.stateDirectory() }
    })
    this.child = child

    child.on('message', (data: unknown) => {
      const parsed = coreResponseSchema.safeParse(data)
      if (!parsed.success) return
      const entry = this.pending.get(parsed.data.id)
      if (!entry) return
      this.pending.delete(parsed.data.id)
      clearTimeout(entry.timer)
      const outcome = parsed.data.outcome
      if (outcome.ok) {
        entry.resolve(outcome.result)
      } else {
        entry.reject(new CoreError(outcome.error.code, outcome.error.message))
      }
    })

    child.on('exit', () => {
      if (this.child !== child) return
      this.child = null
      this.failAllPending(new CoreError('IO_ERROR', 'Core stopped unexpectedly'))
      if (!this.stopped) {
        this.spawn()
        this.onRespawn()
      }
    })
  }

  private failAllPending(error: CoreError): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}
