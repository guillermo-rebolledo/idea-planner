import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { safeGitHubDetail } from './github'

const INACTIVITY_TIMEOUT_MS = 10 * 60_000
const MAX_PROGRESS_DETAIL = 500

export interface ProjectCloneLaunch {
  command: string
  args: string[]
  cwd: string
  onProgress: (detail: string) => void
}

export interface ProjectCloneReservation {
  hooksDirectory: string
  release: () => Promise<void>
}

export class ProjectCloneProcessError extends Error {
  readonly _tag = 'ProjectCloneProcessError'

  constructor(
    readonly command: string,
    readonly stderr: string,
    readonly code: number | string | null,
    readonly timedOut = false
  ) {
    super(stderr || `${command} exited unsuccessfully`)
  }
}

export interface NativeProjectCloneServices {
  operationId: () => string
  isDirectory: (path: string) => Promise<boolean>
  reserveDestination: (path: string, hooksParent: string) => Promise<ProjectCloneReservation>
  execute: (launch: ProjectCloneLaunch) => Effect.Effect<unknown, ProjectCloneProcessError>
}

export class NativeProjectClone extends Context.Tag('main/NativeProjectClone')<
  NativeProjectClone,
  NativeProjectCloneServices
>() {}

const defaults: NativeProjectCloneServices = {
  operationId: randomUUID,
  isDirectory: async (path) => (await stat(path)).isDirectory(),
  reserveDestination: async (path, hooksParent) => {
    await mkdir(hooksParent, { recursive: true, mode: 0o700 })
    const hooksDirectory = await mkdtemp(join(hooksParent, 'operation-'))
    try {
      await chmod(hooksDirectory, 0o700)
      // mkdir is the reservation: only the process that creates this exact
      // final directory may hand it to Git. Git accepts an existing empty
      // destination, while any competing creator receives EEXIST.
      await mkdir(path)
    } catch (error) {
      await rm(hooksDirectory, { recursive: true, force: true })
      throw error
    }
    return {
      hooksDirectory,
      release: () => rm(hooksDirectory, { recursive: true, force: true })
    }
  },
  execute: (launch) =>
    Effect.async<unknown, ProjectCloneProcessError>((resume, signal) => {
      let stderr = ''
      let settled = false
      let timedOut = false
      const child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32'
      })
      let escalation: NodeJS.Timeout | undefined
      const terminate = (signal: NodeJS.Signals): void => {
        try {
          if (process.platform !== 'win32' && child.pid !== undefined)
            process.kill(-child.pid, signal)
          else child.kill(signal)
        } catch {
          try {
            child.kill(signal)
          } catch {
            // The process already exited between observation and termination.
          }
        }
      }

      const resetTimeout = (): NodeJS.Timeout =>
        setTimeout(() => {
          timedOut = true
          escalation = setTimeout(() => terminate('SIGKILL'), 2_000)
          terminate('SIGTERM')
        }, INACTIVITY_TIMEOUT_MS)
      let inactivity = resetTimeout()
      child.stderr.on('data', (chunk: Buffer) => {
        clearTimeout(inactivity)
        inactivity = resetTimeout()
        const text = chunk.toString('utf8')
        stderr = `${stderr}${text}`.slice(-8_000)
        const detail = text
          .split(/[\r\n]/u)
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1)
        if (detail) launch.onProgress(safeGitHubDetail(detail).slice(0, MAX_PROGRESS_DETAIL))
      })

      const finish = (effect: Effect.Effect<unknown, ProjectCloneProcessError>): void => {
        if (settled) return
        settled = true
        clearTimeout(inactivity)
        if (escalation) clearTimeout(escalation)
        resume(effect)
      }
      child.once('error', (error) => {
        const code = 'code' in error && typeof error.code === 'string' ? error.code : null
        finish(Effect.fail(new ProjectCloneProcessError(launch.command, error.message, code)))
      })
      child.once('close', (code) => {
        if (signal.aborted) return
        if (timedOut) {
          finish(
            Effect.fail(
              new ProjectCloneProcessError(launch.command, 'Clone timed out.', 'ETIMEDOUT', true)
            )
          )
        } else if (code === 0) finish(Effect.succeed(undefined))
        else finish(Effect.fail(new ProjectCloneProcessError(launch.command, stderr, code)))
      })

      return Effect.async<unknown>((finished) => {
        if (settled) {
          finished(Effect.succeed(undefined))
          return
        }
        const force = setTimeout(() => terminate('SIGKILL'), 2_000)
        const deadline = setTimeout(() => {
          settled = true
          clearTimeout(inactivity)
          finished(Effect.succeed(undefined))
        }, 5_000)
        const exited = (): void => {
          if (settled) return
          settled = true
          clearTimeout(inactivity)
          clearTimeout(force)
          clearTimeout(deadline)
          finished(Effect.succeed(undefined))
        }
        child.once('close', exited)
        child.once('error', exited)
        terminate('SIGTERM')
      })
    })
}

export function nativeProjectCloneLayer(
  overrides: Partial<NativeProjectCloneServices> = {}
): Layer.Layer<NativeProjectClone> {
  return Layer.succeed(NativeProjectClone, { ...defaults, ...overrides })
}
