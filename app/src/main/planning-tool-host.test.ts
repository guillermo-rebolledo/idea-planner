import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanningToolHost } from './planning-tool-host'

let root: string
let planning: string
let socketPath: string
let host: PlanningToolHost
let socket: Socket
let nextId = 0
const onActivity = vi.fn()
const onStop = vi.fn()
const onWorkflowCompletion = vi.fn()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'planning-tools-'))
  planning = join(root, '.scratch', 'idea')
  socketPath = join(root, 'planning.sock')
  await mkdir(planning, { recursive: true })
  await writeFile(join(root, 'README.md'), 'safe text')
  await writeFile(join(root, '.env'), 'SECRET=value')
  onActivity.mockReset()
  onStop.mockReset()
  onWorkflowCompletion.mockReset()
  host = new PlanningToolHost({
    socketPath,
    capabilityToken: 'test-capability',
    workingDirectory: root,
    planningDirectory: planning,
    callbacks: { onActivity, onStop, onWorkflowCompletion }
  })
  await host.start()
  socket = createConnection(socketPath)
  await new Promise<void>((resolve) => socket.once('connect', resolve))
  socket.write(`${JSON.stringify({ planningCapability: 'test-capability' })}\n`)
})

afterEach(async () => {
  socket.destroy()
  await host.close()
  await rm(root, { recursive: true, force: true })
})

describe('planning tool host', () => {
  it('exposes workflow completion as an explicit authority-free signal', async () => {
    await expect(call('suggest_workflow_completion', {})).resolves.toMatchObject({
      result: { content: [{ text: 'suggested' }] }
    })
    expect(onWorkflowCompletion).toHaveBeenCalledOnce()
  })
  it('is the production policy seam for safe reads and managed planning writes', async () => {
    const read = await call('read_file', { path: 'README.md' })
    const write = await call('write_planning_file', {
      path: '.scratch/idea/spec.md',
      content: '# Plan'
    })
    expect(JSON.stringify(read)).not.toContain('isError')
    expect(JSON.stringify(write)).not.toContain('isError')
    await expect(readFile(join(planning, 'spec.md'), 'utf8')).resolves.toBe('# Plan')
    expect(onActivity).toHaveBeenCalledWith('allowed', 'Inspected README.md')
    expect(onActivity).toHaveBeenCalledWith('allowed', 'Updated .scratch/idea/spec.md')
  })

  it('blocks secrets and stops the Run on a high-risk request', async () => {
    await expect(call('read_file', { path: '.env' })).resolves.toMatchObject({
      result: { isError: true }
    })
    expect(onActivity).toHaveBeenCalledWith('blocked', 'Blocked a secret or credential path')
    expect(onStop).toHaveBeenCalledOnce()
  })

  it('does not reveal protected descendants through list or search tools', async () => {
    const listed = await call('list_directory', { path: '.' })
    const searched = await call('search_text', { path: '.', query: 'SECRET=value' })
    expect(JSON.stringify(listed)).not.toContain('.env')
    expect(JSON.stringify(searched)).not.toContain('SECRET=value')
  })

  it('stops after the third repeated non-overridable source write', async () => {
    for (let index = 0; index < 3; index++) {
      await call('write_planning_file', { path: 'src.ts', content: String(index) })
    }
    expect(onStop).toHaveBeenCalledOnce()
    await expect(readFile(join(root, 'src.ts'), 'utf8')).rejects.toBeDefined()
  })

  it('mediates planning-file rename and delete operations', async () => {
    await writeFile(join(planning, 'draft.md'), 'draft')
    await call('rename_planning_file', {
      from: '.scratch/idea/draft.md',
      to: '.scratch/idea/renamed.md'
    })
    const renamedSource = await call('read_file', { path: '.scratch/idea/draft.md' })
    expect(JSON.stringify(renamedSource)).toContain('isError')
    await expect(readFile(join(planning, 'renamed.md'), 'utf8')).resolves.toBe('draft')
    await call('delete_planning_file', { path: '.scratch/idea/renamed.md' })
    const deletedRead = await call('read_file', { path: '.scratch/idea/renamed.md' })
    expect(JSON.stringify(deletedRead)).toContain('isError')
    await expect(readFile(join(planning, 'renamed.md'), 'utf8')).resolves.toBe('draft')
    const tombstones = await readdir(join(planning, '.tombstones'))
    expect(tombstones).toHaveLength(2)
    const markers = await Promise.all(
      tombstones.map((name) => readFile(join(planning, '.tombstones', name), 'utf8'))
    )
    expect(markers.join('\n')).toContain('.scratch/idea/renamed.md')
  })

  it('blocks rename collisions without overwriting either planning file', async () => {
    await Promise.all([
      writeFile(join(planning, 'one.md'), 'one'),
      writeFile(join(planning, 'two.md'), 'two')
    ])
    const response = await call('rename_planning_file', {
      from: '.scratch/idea/one.md',
      to: '.scratch/idea/two.md'
    })
    expect(JSON.stringify(response)).toContain('isError')
    await expect(readFile(join(planning, 'one.md'), 'utf8')).resolves.toBe('one')
    await expect(readFile(join(planning, 'two.md'), 'utf8')).resolves.toBe('two')
  })

  it('applies planning content limits to renamed bytes', async () => {
    await writeFile(join(planning, 'oversized.md'), 'x'.repeat(5 * 1024 * 1024 + 1))
    const response = await call('rename_planning_file', {
      from: '.scratch/idea/oversized.md',
      to: '.scratch/idea/copied.md'
    })
    expect(JSON.stringify(response)).toContain('isError')
    await expect(readFile(join(planning, 'copied.md'), 'utf8')).rejects.toBeDefined()
  })

  it('fails closed if an authorized parent is swapped before mutation', async () => {
    socket.destroy()
    await host.close()
    const parent = join(planning, 'parent')
    const originalParent = join(planning, 'original-parent')
    const source = join(root, 'src')
    await Promise.all([mkdir(parent), mkdir(source)])
    await Promise.all([
      writeFile(join(parent, 'valuable.md'), 'safe planning content'),
      writeFile(join(source, 'valuable.md'), 'do not truncate')
    ])
    let swapped = false
    socketPath = join(root, 'swap.sock')
    host = new PlanningToolHost({
      socketPath,
      capabilityToken: 'test-capability',
      workingDirectory: root,
      planningDirectory: planning,
      beforeMutation: async () => {
        if (swapped) return
        swapped = true
        await rename(parent, originalParent)
        await symlink(source, parent)
      },
      beforeIdentityCheck: async () => {
        await rm(parent)
        await rename(originalParent, parent)
      },
      callbacks: { onActivity, onStop }
    })
    await host.start()
    socket = createConnection(socketPath)
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.write(`${JSON.stringify({ planningCapability: 'test-capability' })}\n`)

    await expect(
      call('write_planning_file', {
        path: '.scratch/idea/parent/valuable.md',
        content: 'attacker content'
      })
    ).resolves.toMatchObject({ result: { isError: true } })
    await expect(readFile(join(source, 'valuable.md'), 'utf8')).resolves.toBe('do not truncate')
    await expect(readFile(join(parent, 'valuable.md'), 'utf8')).resolves.toBe(
      'safe planning content'
    )
    expect(onStop).toHaveBeenCalledWith('Planning operation failed safely')
  })

  it('stops an individual tool operation at its wall-time limit', async () => {
    socket.destroy()
    await host.close()
    socketPath = join(root, 'timeout.sock')
    host = new PlanningToolHost({
      socketPath,
      capabilityToken: 'test-capability',
      workingDirectory: root,
      planningDirectory: planning,
      operationLimitMs: 1,
      beforeOperation: () => new Promise((resolve) => setTimeout(resolve, 20)),
      callbacks: { onActivity, onStop }
    })
    await host.start()
    socket = createConnection(socketPath)
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.write(`${JSON.stringify({ planningCapability: 'test-capability' })}\n`)

    await expect(call('read_file', { path: 'README.md' })).resolves.toMatchObject({
      result: { isError: true }
    })
    expect(onStop).toHaveBeenCalledWith('Planning operation exceeded the 60-second wall limit')
  })
})

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = ++nextId
  socket.write(
    `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`
  )
  return await new Promise((resolve) => {
    let pending = ''
    const onData = (chunk: Buffer): void => {
      pending += chunk.toString('utf8')
      const boundary = pending.indexOf('\n')
      if (boundary < 0) return
      socket.off('data', onData)
      resolve(JSON.parse(pending.slice(0, boundary)) as Record<string, unknown>)
    }
    socket.on('data', onData)
  })
}
