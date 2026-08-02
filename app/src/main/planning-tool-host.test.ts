import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanningToolHost } from './planning-tool-host'

let root: string
let socketPath: string
let host: PlanningToolHost
let socket: Socket
let nextId = 0
const onActivity = vi.fn()
const onStop = vi.fn()
const onChoices = vi.fn()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'planning-tools-'))
  socketPath = join(root, 'planning.sock')
  onActivity.mockReset()
  onStop.mockReset()
  onChoices.mockReset()
  host = new PlanningToolHost({
    socketPath,
    capabilityToken: 'test-capability',
    callbacks: { onActivity, onStop, onChoices }
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

describe('the model-visible tool surface', () => {
  it('advertises exactly one tool: structured response options', async () => {
    const listed = await list()
    expect(listed.map((entry) => entry.name)).toEqual(['offer_response_options'])
  })

  it('offers structured choices and hands them to the Run', async () => {
    const response = await call('offer_response_options', {
      question: 'Which harness should this Run use?',
      options: [
        { label: 'Claude Code', value: 'claude' },
        { label: 'Codex', value: 'codex' }
      ]
    })
    expect(JSON.stringify(response)).not.toContain('isError')
    expect(onChoices).toHaveBeenCalledWith('Which harness should this Run use?', [
      { label: 'Claude Code', value: 'claude' },
      { label: 'Codex', value: 'codex' }
    ])
  })

  it('refuses a tool the host no longer serves', async () => {
    await expect(call('read_file', { path: 'README.md' })).resolves.toMatchObject({
      result: { isError: true }
    })
  })
})

async function list(): Promise<{ name: string }[]> {
  const id = ++nextId
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })}\n`)
  const response = (await readResponse()) as { result?: { tools?: { name: string }[] } }
  return response.result?.tools ?? []
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = ++nextId
  socket.write(
    `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`
  )
  return await readResponse()
}

async function readResponse(): Promise<Record<string, unknown>> {
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
