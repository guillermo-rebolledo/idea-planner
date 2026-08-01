import { realpath } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type PolicyRequest =
  | { kind: 'read' | 'write'; path: string; bytes?: number }
  | { kind: 'execute'; executable: string }
  | { kind: 'socket'; address: string }

export interface PolicyResult {
  decision: 'allow' | 'block' | 'stop'
  code: string
  overridable: false
  activity: { kind: 'allowed' | 'blocked'; summary: string }
}

const SECRET_NAMES =
  /(^|\/)(\.env(?!\.example$)|\.ssh|\.aws|\.config\/gh|.*credentials?.*|.*private[-_.]?key.*)(\/|$)/i
const DENIED_TREES = /(^|\/)(\.git|\.tombstones|node_modules|dist|build|coverage|\.cache)(\/|$)/
const SAFE_INSPECTION_EXECUTABLES = new Set([
  'ls',
  'find',
  'grep',
  'head',
  'sed',
  'stat',
  'tail',
  'touch',
  'wc'
])
/** Fixed, non-overridable planning authority shared by Ask and Auto modes. */
export class PlanningPolicy {
  private readonly violations = new Map<string, number>()
  private changedBytes = 0

  constructor(private readonly paths: { workingDirectory: string; planningDirectory: string }) {}

  async authorize(request: PolicyRequest): Promise<PolicyResult> {
    if (request.kind === 'execute') {
      const executable = request.executable.split('/').at(-1) ?? request.executable
      if (SAFE_INSPECTION_EXECUTABLES.has(executable)) {
        return {
          decision: 'allow',
          code: 'allowed',
          overridable: false,
          activity: { kind: 'allowed', summary: `Ran safe inspection: ${executable}` }
        }
      }
      return this.block(
        `execute:${executable}`,
        'execution-denied',
        `Blocked executable: ${executable}`
      )
    }
    if (request.kind === 'socket') {
      return this.block(
        `socket:${request.address}`,
        'local-socket',
        'Blocked local socket access',
        true
      )
    }

    const portable = request.path.replaceAll('\\', '/')
    if (isAbsolute(request.path) || portable.split('/').includes('..')) {
      return this.block(
        `path:${portable}`,
        'path-escape',
        'Blocked path outside the Working Directory',
        true
      )
    }
    if (SECRET_NAMES.test(portable)) {
      return this.block(
        `secret:${portable}`,
        'secret-path',
        'Blocked a secret or credential path',
        true
      )
    }
    if (DENIED_TREES.test(portable)) {
      return this.block(
        `tree:${portable}`,
        'protected-tree',
        `Blocked protected path: ${this.safePath(portable)}`
      )
    }
    const root = await realpath(this.paths.workingDirectory)
    const absolute = resolve(root, portable)
    const anchor = await existingAnchor(request.kind === 'write' ? dirname(absolute) : absolute)
    if (anchor === null || !isInside(root, anchor)) {
      return this.block(
        `escape:${portable}`,
        'path-escape',
        'Blocked a path that escapes the Working Directory',
        true
      )
    }
    const resolvedPortable = relative(root, anchor).replaceAll('\\', '/')
    if (SECRET_NAMES.test(resolvedPortable)) {
      return this.block(
        `secret:${resolvedPortable}`,
        'secret-path',
        'Blocked a secret or credential path',
        true
      )
    }
    if (DENIED_TREES.test(resolvedPortable)) {
      return this.block(
        `tree:${resolvedPortable}`,
        'protected-tree',
        `Blocked protected path: ${this.safePath(portable)}`
      )
    }
    if (request.kind === 'write') {
      const planningRoot = await realpath(this.paths.planningDirectory)
      if (!isInside(planningRoot, anchor)) {
        return this.block(
          `write:${portable}`,
          'source-write',
          `Blocked source write: ${this.safePath(portable)}`
        )
      }
      if ((request.bytes ?? 0) > 5 * 1024 * 1024) {
        return this.block(
          `limit:${portable}`,
          'file-limit',
          `Blocked oversized planning file: ${this.safePath(portable)}`
        )
      }
      if (this.changedBytes + (request.bytes ?? 0) > 50 * 1024 * 1024) {
        return this.block(
          'limit:run-total',
          'run-content-limit',
          'Blocked planning content beyond the 50 MB Run limit'
        )
      }
      this.changedBytes += request.bytes ?? 0
    }
    return {
      decision: 'allow',
      code: 'allowed',
      overridable: false,
      activity: {
        kind: 'allowed',
        summary: `${request.kind === 'read' ? 'Inspected' : 'Updated'} ${this.safePath(portable)}`
      }
    }
  }

  deny(key: string, code: string, summary: string, highRisk = false): PolicyResult {
    return this.block(key, code, summary, highRisk)
  }

  /** Provider containment is deliberately stricter; Main performs authorized planning writes. */
  renderSandboxProfile(paths: {
    runDirectory: string
    executable: string
    proxyExecutable: string
    proxyScript: string
    socketPath: string
  }): string {
    const q = (value: string): string => JSON.stringify(value)
    const canonical = (path: string): string => {
      try {
        return realpathSync(path)
      } catch {
        return path
      }
    }
    const workingDirectory = canonical(this.paths.workingDirectory)
    const runDirectory = canonical(paths.runDirectory)
    const socketPath = canonical(paths.socketPath)
    return `(version 1)
(deny default)
(import "system.sb")
(allow process-exec (literal ${q(paths.executable)}) (literal ${q(paths.proxyExecutable)}))
(allow process-fork)
(allow signal (target self))
(allow file-read-metadata)
(allow file-read* (subpath ${q(workingDirectory)}))
(deny file-read* (subpath ${q(join(workingDirectory, '.git'))}) (regex #"(^|/)\\.env($|/)"))
(deny file-read* (regex #"(^|/)(\\.ssh|\\.aws|credentials|private[-_.]?key)($|/)"))
(allow file-read* (literal ${q(paths.executable)}) (literal ${q(paths.proxyExecutable)}) (literal ${q(paths.proxyScript)}) (subpath ${q(runDirectory)}) (subpath "/System") (subpath "/Library/Apple") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/private/etc/ssl"))
(allow file-write* (subpath ${q(runDirectory)}))
(allow network-outbound (require-all (remote ip) (require-not (remote ip "localhost:*"))))
(allow network-outbound (remote unix-socket (path-literal ${q(socketPath)})))
`
  }

  private block(key: string, code: string, summary: string, highRisk = false): PolicyResult {
    const count = (this.violations.get(key) ?? 0) + 1
    this.violations.set(key, count)
    return {
      decision: highRisk || count >= 3 ? 'stop' : 'block',
      code,
      overridable: false,
      activity: { kind: 'blocked', summary }
    }
  }

  private safePath(path: string): string {
    return path.replace(/^\/+/, '') || '.'
  }
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

async function existingAnchor(path: string): Promise<string | null> {
  let candidate = path
  for (;;) {
    const resolved = await realpath(candidate).catch(() => null)
    if (resolved !== null) return resolved
    const parent = dirname(candidate)
    if (parent === candidate) return null
    candidate = parent
  }
}
