import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, stat } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { PlanningPolicy, type PolicyResult } from './planning-policy'

interface PlanningToolHostCallbacks {
  onActivity(
    kind: 'allowed' | 'blocked' | 'error' | 'output',
    summary: string
  ): void | Promise<void>
  onStop(summary: string): void
  /** Structured answers the provider offered for the current question. */
  onChoices?(question: string, options: { label: string; value: string }[]): void
}

interface RpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: unknown
}

const callSchema = z.object({
  name: z.enum([
    'read_file',
    'list_directory',
    'search_text',
    'write_planning_file',
    'rename_planning_file',
    'delete_planning_file',
    'offer_response_options'
  ]),
  arguments: z.record(z.unknown()).default({})
})

const choiceArgumentsSchema = z.object({
  question: z.string().max(2_000).default(''),
  options: z
    .array(z.object({ label: z.string().min(1).max(200), value: z.string().min(1).max(2_000) }))
    .min(1)
    .max(12)
})

const TOOL_DEFINITIONS = [
  tool(
    'read_file',
    'Read one UTF-8 file inside the Idea',
    {
      path: { type: 'string' }
    },
    ['path']
  ),
  tool('list_directory', 'List one directory inside the Idea', {
    path: { type: 'string', default: '.' }
  }),
  tool(
    'search_text',
    'Search UTF-8 files inside the Idea for literal text',
    {
      path: { type: 'string', default: '.' },
      query: { type: 'string' }
    },
    ['query']
  ),
  tool(
    'write_planning_file',
    'Write one UTF-8 file in the managed planning directory',
    {
      path: { type: 'string' },
      content: { type: 'string' }
    },
    ['path', 'content']
  ),
  tool(
    'rename_planning_file',
    'Rename one file within the managed planning directory',
    { from: { type: 'string' }, to: { type: 'string' } },
    ['from', 'to']
  ),
  tool(
    'delete_planning_file',
    'Remove one planning file while retaining a reversible tombstone',
    { path: { type: 'string' } },
    ['path']
  ),
  tool(
    'offer_response_options',
    'Offer the person structured answers to the current question. They may always write their own instead.',
    {
      question: { type: 'string' },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, value: { type: 'string' } },
          required: ['label', 'value']
        }
      }
    },
    ['question', 'options']
  )
]

/** Main-owned, capability-socket MCP host: the only model-visible operation boundary. */
export class PlanningToolHost {
  private server: Server | undefined
  private stopping = false
  private outputBytes = 0
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: {
      socketPath: string
      workingDirectory: string
      planningDirectory: string
      capabilityToken: string
      callbacks: PlanningToolHostCallbacks
      operationLimitMs?: number
      beforeOperation?: () => Promise<void>
      beforeMutation?: () => Promise<void>
      beforeIdentityCheck?: () => Promise<void>
    }
  ) {}

  async start(): Promise<void> {
    const policy = new PlanningPolicy({
      workingDirectory: this.options.workingDirectory,
      planningDirectory: this.options.planningDirectory
    })
    this.server = createServer((socket) => this.accept(socket, policy))
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(this.options.socketPath, () => resolve())
    })
  }

  async close(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve, reject) =>
      this.server?.close((error) => (error ? reject(error) : resolve()))
    )
    this.server = undefined
  }

  private accept(socket: Socket, policy: PlanningPolicy): void {
    socket.setEncoding('utf8')
    let pending = ''
    let authenticated = false
    socket.on('data', (chunk: string) => {
      pending += chunk
      for (;;) {
        const boundary = pending.indexOf('\n')
        if (boundary < 0) break
        const line = pending.slice(0, boundary)
        pending = pending.slice(boundary + 1)
        if (!line.trim()) continue
        if (!authenticated) {
          authenticated = this.isAuthenticated(line)
          if (!authenticated) socket.destroy()
          continue
        }
        this.operationQueue = this.operationQueue
          .then(() => this.handleLine(socket, policy, line))
          .catch(() => undefined)
      }
    })
  }

  private isAuthenticated(line: string): boolean {
    try {
      return (
        z.object({ planningCapability: z.string() }).parse(JSON.parse(line)).planningCapability ===
        this.options.capabilityToken
      )
    } catch {
      return false
    }
  }

  private async handleLine(socket: Socket, policy: PlanningPolicy, line: string): Promise<void> {
    let request: RpcRequest
    try {
      request = z
        .object({
          jsonrpc: z.literal('2.0'),
          id: z.union([z.string(), z.number()]).optional(),
          method: z.string(),
          params: z.unknown().optional()
        })
        .parse(JSON.parse(line))
    } catch {
      this.respond(socket, null, undefined, { code: -32700, message: 'Invalid request' })
      return
    }
    if (request.id === undefined) return
    if (request.method === 'initialize') {
      this.respond(socket, request.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'idea-development-planning', version: '1.0.0' }
      })
      return
    }
    if (request.method === 'tools/list') {
      this.respond(socket, request.id, { tools: TOOL_DEFINITIONS })
      return
    }
    if (request.method !== 'tools/call') {
      this.respond(socket, request.id, undefined, { code: -32601, message: 'Method not found' })
      return
    }
    const parsed = callSchema.safeParse(request.params)
    if (!parsed.success) {
      const summary = 'Blocked unsupported planning operation'
      await this.options.callbacks.onActivity('blocked', summary)
      if (!this.stopping) {
        this.stopping = true
        this.options.callbacks.onStop(summary)
      }
      this.respond(socket, request.id, toolError('Invalid planning tool input'))
      return
    }
    await this.options.callbacks.onActivity(
      'output',
      `Planning operation started: ${parsed.data.name}`
    )
    try {
      const result = await this.withDeadline((signal) =>
        this.call(policy, parsed.data.name, parsed.data.arguments, signal)
      )
      this.outputBytes += Buffer.byteLength(result.text)
      if (this.outputBytes > 10 * 1024 * 1024) throw new OutputLimitError()
      await this.options.callbacks.onActivity(
        result.policy.activity.kind,
        result.policy.activity.summary
      )
      if (result.policy.decision === 'stop' && !this.stopping) {
        this.stopping = true
        this.options.callbacks.onStop(result.policy.activity.summary)
      }
      this.respond(
        socket,
        request.id,
        result.policy.decision === 'allow'
          ? toolText(result.text)
          : toolError(result.policy.activity.summary)
      )
    } catch (error) {
      const summary =
        error instanceof OperationTimeoutError
          ? 'Planning operation exceeded the 60-second wall limit'
          : error instanceof OutputLimitError
            ? 'Planning tool output exceeded the 10 MB Run limit'
            : 'Planning operation failed safely'
      await this.options.callbacks.onActivity('blocked', summary)
      if (!this.stopping) {
        this.stopping = true
        this.options.callbacks.onStop(summary)
      }
      this.respond(socket, request.id, toolError(summary))
    }
  }

  private async call(
    policy: PlanningPolicy,
    name: z.infer<typeof callSchema>['name'],
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<{ policy: PolicyResult; text: string }> {
    await this.options.beforeOperation?.()
    signal.throwIfAborted()
    if (name === 'offer_response_options') {
      // Offering answers touches nothing: no path, no process, no new
      // authority. This host is the only place that sees the arguments, so it
      // is what tells the Conversation about them.
      const offered = choiceArgumentsSchema.safeParse(args)
      if (!offered.success) {
        // Options the app cannot read are not a menu it can trust; the person
        // keeps answering by typing.
        return {
          policy: policy.deny(
            'offer_response_options',
            'unreadable-choices',
            'Blocked unreadable Suggested Responses'
          ),
          text: ''
        }
      }
      this.options.callbacks.onChoices?.(offered.data.question, offered.data.options)
      return {
        policy: {
          decision: 'allow',
          code: 'allowed',
          overridable: false,
          activity: { kind: 'allowed', summary: 'Offered Suggested Responses' }
        },
        text: 'offered'
      }
    }
    if (name === 'read_file') {
      const path = requiredString(args['path'])
      const decision = await policy.authorize({ kind: 'read', path })
      if (decision.decision !== 'allow') return { policy: decision, text: '' }
      if (await this.isTombstoned(path)) {
        return {
          policy: policy.deny(
            `tombstoned:${path}`,
            'tombstoned',
            `Blocked deleted planning file: ${path}`
          ),
          text: ''
        }
      }
      const content = await this.readVerified(path, async () => {
        const verified = await policy.authorize({ kind: 'read', path })
        if (verified.decision !== 'allow') {
          throw new Error('Readable path identity changed during the authorized operation')
        }
      })
      return { policy: decision, text: content }
    }
    if (name === 'list_directory') {
      const path = optionalString(args['path']) ?? '.'
      const decision = await policy.authorize({ kind: 'read', path })
      if (decision.decision !== 'allow') return { policy: decision, text: '' }
      const entries = await readdir(join(this.options.workingDirectory, path), {
        withFileTypes: true
      })
      const visible: typeof entries = []
      for (const entry of entries) {
        const childPath = join(path, entry.name)
        if (await this.isTombstoned(childPath)) continue
        const childDecision = await policy.authorize({
          kind: 'read',
          path: childPath
        })
        if (childDecision.decision === 'allow') visible.push(entry)
      }
      return {
        policy: decision,
        text: visible
          .map((entry) => `${entry.isDirectory() ? 'directory' : 'file'}\t${entry.name}`)
          .join('\n')
      }
    }
    if (name === 'search_text') {
      const path = optionalString(args['path']) ?? '.'
      const query = requiredString(args['query'])
      const decision = await policy.authorize({ kind: 'read', path })
      if (decision.decision !== 'allow') return { policy: decision, text: '' }
      return {
        policy: decision,
        text: await searchText(
          join(this.options.workingDirectory, path),
          query,
          this.options.workingDirectory,
          policy,
          signal,
          (candidate) => this.isTombstoned(candidate)
        )
      }
    }
    if (name === 'rename_planning_file') {
      const from = requiredString(args['from'])
      const to = requiredString(args['to'])
      const sourceDecision = await policy.authorize({ kind: 'write', path: from, bytes: 0 })
      if (sourceDecision.decision !== 'allow') return { policy: sourceDecision, text: '' }
      const destinationDecision = await policy.authorize({ kind: 'write', path: to, bytes: 0 })
      if (destinationDecision.decision !== 'allow') {
        return { policy: destinationDecision, text: '' }
      }
      await this.options.beforeMutation?.()
      signal.throwIfAborted()
      const content = await this.readVerified(from)
      const contentDecision = await policy.authorize({
        kind: 'write',
        path: to,
        bytes: Buffer.byteLength(content)
      })
      if (contentDecision.decision !== 'allow') {
        return { policy: contentDecision, text: '' }
      }
      const destination = join(this.options.workingDirectory, to)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      let destinationHandle
      try {
        destinationHandle = await open(
          destination,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600
        )
      } catch (error) {
        if (!isAlreadyExists(error)) throw error
        return {
          policy: policy.deny(
            `rename-collision:${to}`,
            'rename-collision',
            `Blocked rename over an existing planning file: ${to}`
          ),
          text: ''
        }
      }
      try {
        await this.verifyPlanningHandle(destinationHandle, destination)
        await destinationHandle.writeFile(content, 'utf8')
      } finally {
        await destinationHandle.close()
      }
      await this.createTombstone(from)
      return { policy: contentDecision, text: 'Planning file renamed' }
    }
    if (name === 'delete_planning_file') {
      const path = requiredString(args['path'])
      const decision = await policy.authorize({ kind: 'write', path, bytes: 0 })
      if (decision.decision !== 'allow') return { policy: decision, text: '' }
      await this.options.beforeMutation?.()
      signal.throwIfAborted()
      await this.readVerified(path)
      const retained = await this.createTombstone(path)
      return {
        policy: decision,
        text: `Planning file retained behind tombstone: ${relative(this.options.workingDirectory, retained)}`
      }
    }
    const path = requiredString(args['path'])
    const content = requiredString(args['content'])
    const decision = await policy.authorize({
      kind: 'write',
      path,
      bytes: Buffer.byteLength(content)
    })
    if (decision.decision !== 'allow') return { policy: decision, text: '' }
    await this.options.beforeMutation?.()
    signal.throwIfAborted()
    const absolute = join(this.options.workingDirectory, path)
    await mkdir(dirname(absolute), { recursive: true, mode: 0o700 })
    const handle = await open(
      absolute,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600
    )
    try {
      await this.verifyPlanningHandle(handle, absolute)
      await handle.truncate(0)
      await handle.writeFile(content, 'utf8')
    } finally {
      await handle.close()
    }
    return { policy: decision, text: 'Planning file updated' }
  }

  private async readVerified(path: string, verify?: () => Promise<void>): Promise<string> {
    const absolute = join(this.options.workingDirectory, path)
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      await (verify ? verify() : this.verifyPlanningPath(absolute))
      await this.verifyHandleIdentity(handle, absolute)
      return await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  }

  private async createTombstone(path: string): Promise<string> {
    const tombstones = join(this.options.planningDirectory, '.tombstones')
    await mkdir(tombstones, { recursive: true, mode: 0o700 })
    const marker = this.tombstonePath(path)
    let handle
    try {
      handle = await open(
        marker,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
    } catch (error) {
      if (isAlreadyExists(error)) return marker
      throw error
    }
    try {
      await this.verifyPlanningHandle(handle, marker)
      await handle.writeFile(JSON.stringify({ path, retainedAt: new Date().toISOString() }), 'utf8')
    } finally {
      await handle.close()
    }
    return marker
  }

  private async isTombstoned(path: string): Promise<boolean> {
    return await open(this.tombstonePath(path), constants.O_RDONLY | constants.O_NOFOLLOW)
      .then(async (handle) => {
        try {
          await this.verifyPlanningPath(this.tombstonePath(path))
          return true
        } finally {
          await handle.close()
        }
      })
      .catch(() => false)
  }

  private tombstonePath(path: string): string {
    const key = createHash('sha256').update(path.replaceAll('\\', '/')).digest('hex')
    return join(this.options.planningDirectory, '.tombstones', `${key}-${basename(path)}.json`)
  }

  private async verifyPlanningPath(path: string): Promise<void> {
    const [planningRoot, candidate] = await Promise.all([
      realpath(this.options.planningDirectory),
      realpath(path)
    ])
    const portable = relative(planningRoot, candidate)
    if (
      portable === '' ||
      (!portable.startsWith(`..${sep}`) && portable !== '..' && !isAbsolute(portable))
    ) {
      return
    }
    throw new Error('Planning path identity changed during the authorized operation')
  }

  private async verifyPlanningHandle(
    handle: Awaited<ReturnType<typeof open>>,
    path: string
  ): Promise<void> {
    await this.options.beforeIdentityCheck?.()
    await this.verifyPlanningPath(path)
    await this.verifyHandleIdentity(handle, path)
  }

  private async verifyHandleIdentity(
    handle: Awaited<ReturnType<typeof open>>,
    path: string
  ): Promise<void> {
    const [opened, named] = await Promise.all([handle.stat(), stat(path)])
    if (opened.dev !== named.dev || opened.ino !== named.ino) {
      throw new Error('Opened file identity changed during the authorized operation')
    }
  }

  private withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
        reject(new OperationTimeoutError())
      }, this.options.operationLimitMs ?? 60_000)
      void operation(controller.signal).then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error('Planning operation failed'))
        }
      )
    })
  }

  private respond(
    socket: Socket,
    id: string | number | null,
    result?: unknown,
    error?: { code: number; message: string }
  ): void {
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) })}\n`)
  }
}

class OperationTimeoutError extends Error {}
class OutputLimitError extends Error {}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return { name, description, inputSchema: { type: 'object', properties, required } }
}

function toolText(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }] }
}

function toolError(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true }
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid string')
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function searchText(
  root: string,
  query: string,
  workingDirectory: string,
  policy: PlanningPolicy,
  signal: AbortSignal,
  isTombstoned: (path: string) => Promise<boolean>
): Promise<string> {
  const results: string[] = []
  const visit = async (path: string): Promise<void> => {
    signal.throwIfAborted()
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return
    if (metadata.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry))
      return
    }
    if (!metadata.isFile() || metadata.size > 5 * 1024 * 1024) return
    const portable = relative(workingDirectory, path)
    if (await isTombstoned(portable)) return
    const decision = await policy.authorize({ kind: 'read', path: portable })
    if (decision.decision !== 'allow') return
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
    if (!handle) return
    let content: string
    try {
      const verified = await policy.authorize({ kind: 'read', path: portable })
      if (verified.decision !== 'allow') return
      const [opened, named] = await Promise.all([handle.stat(), stat(path)])
      if (opened.dev !== named.dev || opened.ino !== named.ino) return
      content = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
    for (const [index, line] of content.split('\n').entries()) {
      if (line.includes(query)) {
        results.push(`${portable}:${index + 1}:${line.slice(0, 500)}`)
      }
      if (Buffer.byteLength(results.join('\n')) > 10 * 1024 * 1024) return
    }
  }
  await visit(root)
  return results.join('\n')
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}
