import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyUsage, type ConversationSnapshot } from '@shared/conversation'
import { ToolHost } from './tool-host'

let root: string
let socketPath: string
let host: ToolHost
let socket: Socket
let nextId = 0
const onActivity = vi.fn()
const onStop = vi.fn()
const onChoices = vi.fn()
const onApproval = vi.fn()
const readConversation = vi.fn<() => Promise<ConversationSnapshot>>()

const conversation: ConversationSnapshot = {
  sessionId: 'current-session',
  journalPosition: 0,
  entries: [
    {
      kind: 'file-change',
      id: 'file-change:run-1:1',
      at: '2026-08-06T12:00:00.000Z',
      runId: 'run-1',
      path: 'src/first.ts',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
      changeKind: 'changed',
      shortened: false,
      source: 'harness',
      added: 1,
      removed: 1
    },
    {
      kind: 'file-change',
      id: 'file-change:run-2:1',
      at: '2026-08-06T12:01:00.000Z',
      runId: 'run-2',
      path: 'src/first.ts',
      hunks: [{ oldStart: 2, oldLines: 0, newStart: 2, newLines: 1, lines: ['+again'] }],
      changeKind: 'changed',
      shortened: true,
      source: 'checkout',
      added: 1,
      removed: 0
    }
  ],
  usage: { run: null, session: emptyUsage() },
  recovery: null,
  harnessThreads: {},
  changedFiles: [
    {
      path: 'src/first.ts',
      changes: 2,
      added: 2,
      removed: 1,
      changeKind: 'changed',
      shortened: true,
      reported: true,
      restored: false
    }
  ],
  activeRunId: 'run-2',
  pendingApprovalIds: [],
  queue: { paused: true, items: [], outcome: null }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'app-tools-'))
  socketPath = join(root, 'app.sock')
  onActivity.mockReset()
  onStop.mockReset()
  onChoices.mockReset()
  onApproval.mockReset()
  readConversation.mockReset()
  readConversation.mockResolvedValue(conversation)
  host = new ToolHost({
    socketPath,
    capabilityToken: 'test-capability',
    servesApprovals: true,
    callbacks: { onActivity, onStop, onChoices, onApproval, readConversation }
  })
  await host.start()
  socket = createConnection(socketPath)
  await new Promise<void>((resolve) => socket.once('connect', resolve))
  socket.write(`${JSON.stringify({ appCapability: 'test-capability' })}\n`)
})

afterEach(async () => {
  socket.destroy()
  await host.close()
  await rm(root, { recursive: true, force: true })
})

describe('the model-visible tool surface', () => {
  it('advertises the response options tool and the approval tool, and nothing else', async () => {
    const listed = await list()
    expect(listed.map((entry) => entry.name)).toEqual([
      'offer_response_options',
      'session_diff',
      'approval_request'
    ])
    expect(listed[1]).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    })
  })

  it('returns the recorded Files-panel summary field-for-field without patch text', async () => {
    const response = JSON.parse(await callText('session_diff', { mode: 'summary' })) as {
      files: unknown[]
      truncation: { truncated: boolean; omitted: number; total: number }
    }

    expect(response.files).toEqual(conversation.changedFiles)
    expect(response.truncation).toMatchObject({ truncated: false, omitted: 0, total: 1 })
    expect(JSON.stringify(response)).not.toContain('hunks')
    expect(readConversation).toHaveBeenCalledOnce()
  })

  it('returns one recorded path in Files-panel order, including shortened status', async () => {
    const response = JSON.parse(
      await callText('session_diff', { mode: 'file', path: 'src/first.ts' })
    ) as { changes: unknown[]; truncation: { truncated: boolean } }

    expect(response.changes).toEqual(conversation.entries)
    expect(response.changes).toMatchObject([{ shortened: false }, { shortened: true }])
    expect(response.truncation.truncated).toBe(false)
  })

  it('rejects unrecorded paths and inputs that try to select another Session', async () => {
    await expect(
      call('session_diff', { mode: 'file', path: 'package.json' })
    ).resolves.toMatchObject({ result: { isError: true } })
    await expect(
      call('session_diff', { mode: 'summary', sessionId: 'another-session' })
    ).resolves.toMatchObject({ result: { isError: true } })
  })

  it('bounds large responses by omitting whole recorded changes and says exactly what it omitted', async () => {
    const firstChange = conversation.entries[0] as Extract<
      ConversationSnapshot['entries'][number],
      { kind: 'file-change' }
    >
    const largeEntries = Array.from({ length: 20 }, (_, index) => ({
      ...firstChange,
      id: `file-change:run-1:${String(index + 1)}`,
      hunks: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: [`+${'x'.repeat(8_000)}`]
        }
      ]
    }))
    readConversation.mockResolvedValueOnce({ ...conversation, entries: largeEntries })

    const text = await callText('session_diff', { mode: 'file', path: 'src/first.ts' })
    const response = JSON.parse(text) as {
      changes: unknown[]
      truncation: { truncated: boolean; returned: number; omitted: number; total: number }
    }
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1_024)
    expect(response.truncation).toMatchObject({
      truncated: true,
      returned: response.changes.length,
      omitted: 20 - response.changes.length,
      total: 20
    })
  })

  it('records only bounded activity summaries, never returned patches', async () => {
    await callText('session_diff', { mode: 'file', path: 'src/first.ts' })

    expect(onActivity).toHaveBeenCalledWith(
      'allowed',
      'Read 2 recorded changes for one Session file'
    )
    expect(JSON.stringify(onActivity.mock.calls)).not.toContain('-old')
    expect(JSON.stringify(onActivity.mock.calls)).not.toContain('+new')
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

  it('holds the Harness on an approval until the person answers it', async () => {
    const answer = callWithoutWaiting('approval_request', approvalArguments())

    await vi.waitFor(() => {
      expect(onApproval).toHaveBeenCalledWith({
        id: 'toolu_01VTmheSC7ib3hzCWY7Ezb9Y',
        tool: 'Bash',
        input: { command: 'pnpm test', description: 'Run the unit tests' }
      })
    })
    // Still outstanding: nothing has been decided, so nothing has been said.
    expect(await Promise.race([answer, Promise.resolve('unanswered')])).toBe('unanswered')

    expect(host.resolveApproval('toolu_01VTmheSC7ib3hzCWY7Ezb9Y', { behavior: 'allow' })).toBe(true)
    // The Harness's own decision shape: an allow carries the input back.
    expect(JSON.parse(await answer)).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'pnpm test', description: 'Run the unit tests' }
    })
  })

  it('returns the person’s message to the agent when they decline', async () => {
    const answer = callWithoutWaiting('approval_request', approvalArguments())
    await vi.waitFor(() => expect(onApproval).toHaveBeenCalled())

    host.resolveApproval('toolu_01VTmheSC7ib3hzCWY7Ezb9Y', {
      behavior: 'deny',
      message: 'Run the unit tests instead'
    })

    expect(JSON.parse(await answer)).toEqual({
      behavior: 'deny',
      message: 'Run the unit tests instead'
    })
  })

  it('declines what is still outstanding when the Run ends, rather than hanging the Harness', async () => {
    const answer = callWithoutWaiting('approval_request', approvalArguments())
    await vi.waitFor(() => expect(onApproval).toHaveBeenCalled())

    await host.close()

    expect(JSON.parse(await answer)).toMatchObject({ behavior: 'deny' })
  })

  it('refuses a tool the host no longer serves', async () => {
    await expect(call('read_file', { path: 'README.md' })).resolves.toMatchObject({
      result: { isError: true }
    })
  })
})

describe('a Run that does not ask', () => {
  beforeEach(async () => {
    socket.destroy()
    await host.close()
    host = new ToolHost({
      socketPath,
      capabilityToken: 'test-capability',
      servesApprovals: false,
      callbacks: { onActivity, onStop, onChoices, onApproval, readConversation }
    })
    await host.start()
    socket = createConnection(socketPath)
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.write(`${JSON.stringify({ appCapability: 'test-capability' })}\n`)
  })

  it('never offers the approval tool, and refuses it if the model reaches for it', async () => {
    // Nothing routes permission through this host in Full access, so answering
    // such a call would block a Run nobody asked to block.
    expect((await list()).map((entry) => entry.name)).toEqual([
      'offer_response_options',
      'session_diff'
    ])
    await expect(call('approval_request', approvalArguments())).resolves.toMatchObject({
      result: { isError: true }
    })
    expect(onApproval).not.toHaveBeenCalled()
  })
})

async function list(): Promise<{ name: string; annotations?: Record<string, unknown> }[]> {
  const id = ++nextId
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })}\n`)
  const response = (await readResponse()) as {
    result?: { tools?: { name: string; annotations?: Record<string, unknown> }[] }
  }
  return response.result?.tools ?? []
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = ++nextId
  socket.write(
    `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`
  )
  return await readResponse()
}

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const response = await call(name, args)
  return (
    (response as { result?: { content?: { text?: string }[] } }).result?.content?.[0]?.text ?? ''
  )
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

/**
 * A tool call whose answer is not waited for. An approval blocks in the host
 * until the person answers it, so the test has to be able to send one and
 * still be running.
 */
function callWithoutWaiting(name: string, args: Record<string, unknown>): Promise<string> {
  const id = ++nextId
  const response = readResponse().then((raw) => {
    const result = (raw as { result?: { content?: { text?: string }[] } }).result
    return result?.content?.[0]?.text ?? ''
  })
  socket.write(
    `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`
  )
  return response
}

/** What Claude Code sends when it asks, as captured on the wire. */
function approvalArguments(): Record<string, unknown> {
  return {
    tool_name: 'Bash',
    input: { command: 'pnpm test', description: 'Run the unit tests' },
    tool_use_id: 'toolu_01VTmheSC7ib3hzCWY7Ezb9Y'
  }
}
