/**
 * Records a real `codex app-server` session into the Codex contract fixture.
 *
 *   pnpm codex:record
 *
 * The Adapter is tested against what the installed binary actually sends
 * rather than against its documentation — the two have already been found to
 * disagree on enum spellings. Re-record when the supported Codex version
 * moves, read the diff, and update `app/src/core/harness/codex.test.ts`.
 *
 * It runs one real turn against a scratch git repository, so it costs a Codex
 * request and needs the CLI signed in. Nothing outside that scratch directory
 * is read or written.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIXTURE = 'app/src/core/harness/fixtures/codex-app-server.jsonl'

/** Protocol worth keeping: enough to prove every event the Adapter emits. */
const KEEP = new Set([
  'thread/started',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'turn/diff/updated',
  'thread/tokenUsage/updated',
  'turn/completed',
  'thread/status/changed',
  'mcpServer/startupStatus/updated',
  'hook/started',
  'hook/completed',
  'account/rateLimits/updated',
  'remoteControl/status/changed'
])

const work = mkdtempSync(join(tmpdir(), 'codex-record-'))
execFileSync('git', ['init', '--quiet'], { cwd: work })
writeFileSync(join(work, 'greeting.txt'), 'hello world\nsecond line\n')

const recorded = []
let deltas = 0
let buffered = ''
let threadId = null
let turnId = null
let steerSent = false

const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] })
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)

child.stdout.on('data', (chunk) => {
  buffered += chunk
  for (;;) {
    const boundary = buffered.indexOf('\n')
    if (boundary < 0) break
    const line = buffered.slice(0, boundary)
    buffered = buffered.slice(boundary + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    keep(message, line)
    if (message.id === 1 && message.result) {
      send({ jsonrpc: '2.0', method: 'initialized', params: {} })
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'thread/start',
        params: {
          cwd: work,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          config: { model_reasoning_effort: 'low' },
          developerInstructions: 'Be terse.',
          threadSource: 'argos'
        }
      })
    }
    if (message.id === 2 && message.result) {
      threadId = message.result.thread.id
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'turn/start',
        params: {
          threadId: message.result.thread.id,
          input: [
            {
              type: 'text',
              text: "Change 'hello world' to 'goodbye world' in greeting.txt, then run 'wc -l greeting.txt'. Nothing else.",
              text_elements: []
            }
          ]
        }
      })
    }
    if (message.id === 3 && message.result) {
      turnId = message.result.turn.id
    }
    if (
      !steerSent &&
      turnId &&
      message.method === 'item/started' &&
      message.params?.item?.type === 'userMessage'
    ) {
      steerSent = true
      send({
        jsonrpc: '2.0',
        id: 5,
        method: 'turn/steer',
        params: {
          threadId,
          expectedTurnId: turnId,
          input: [
            {
              type: 'text',
              text: 'Keep the existing second line unchanged.',
              text_elements: []
            }
          ]
        }
      })
    }
    if (message.method === 'turn/completed') finish()
  }
})

function keep(message, line) {
  if (message.method === 'item/agentMessage/delta' && ++deltas > 3) return
  if (message.method && !KEEP.has(message.method)) return
  // A fixture is read by people: neutralise this machine's paths.
  const home = process.env.HOME ?? '~'
  recorded.push(line.split(work).join('/a-project').split(home).join('/Users/someone'))
}

function finish() {
  writeFileSync(FIXTURE, `${recorded.join('\n')}\n`)
  rmSync(work, { recursive: true, force: true })
  console.log(`Recorded ${recorded.length} frames into ${FIXTURE}`)
  process.exit(0)
}

setTimeout(() => {
  console.error('Codex did not finish a turn within two minutes')
  process.exit(1)
}, 120_000)

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { clientInfo: { name: 'argos', title: 'Argos', version: '0.1.0' } }
})
