/**
 * Records a real `codex app-server` review into the Codex review fixture.
 *
 *   pnpm codex:record-review
 *
 * A review is a detached thread rather than a Run, so it has protocol of its
 * own: `review/start` answers with the id of the thread the review runs on, and
 * everything the app reads afterwards arrives under that id. The Adapter is
 * tested against what the installed binary actually sends, exactly as the Run
 * protocol is — re-record when the supported Codex version moves, read the
 * diff, and update `app/src/core/harness/codex-review.test.ts`.
 *
 * It runs one real review against a scratch git repository, so it costs a Codex
 * request and needs the CLI signed in. The repository carries one small
 * regression on purpose, because a recording with no findings in it proves
 * nothing about reading findings. Nothing outside that scratch directory is
 * read or written.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const FIXTURE = 'app/src/core/harness/fixtures/codex-review.jsonl'

/** Protocol worth keeping: enough to prove every event the Adapter emits. */
const KEEP = new Set([
  'thread/started',
  'item/completed',
  'turn/completed',
  'thread/status/changed',
  'error'
])

/**
 * The committed code, its test, and the change the review is asked about. The
 * regression is deliberate and unmissable — the change breaks a test that is
 * already in the repository — because a recording with no findings in it
 * proves nothing about reading findings.
 */
const BEFORE = [
  'export function greet(name) {',
  '  return "hello " + name',
  '}',
  '',
  'export function greetAll(names) {',
  '  return names.map(greet)',
  '}',
  ''
].join('\n')

const AFTER = [
  'export function greet(name) {',
  '  return "hello " + name.toUpperCase()',
  '}',
  '',
  'export function greetAll(names) {',
  '  return names.map(greet)',
  '}',
  ''
].join('\n')

const TEST = [
  "import { greet, greetAll } from './greeting.js'",
  '',
  'test("greets a string", () => {',
  '  expect(greet("ada")).toBe("hello ada")',
  '})',
  '',
  'test("greets a number", () => {',
  '  expect(greet(42)).toBe("hello 42")',
  '})',
  '',
  'test("greets a list", () => {',
  '  expect(greetAll(["ada", 7])).toEqual(["hello ada", "hello 7"])',
  '})',
  ''
].join('\n')

const work = mkdtempSync(join(tmpdir(), 'codex-review-'))
const git = (...args) => execFileSync('git', args, { cwd: work, stdio: 'ignore' })
git('init', '--quiet')
writeFileSync(join(work, 'greeting.js'), BEFORE)
writeFileSync(join(work, 'greeting.test.js'), TEST)
git('add', '-A')
git(
  '-c',
  'user.email=recorder@example.com',
  '-c',
  'user.name=Recorder',
  'commit',
  '-qm',
  'greeting'
)
writeFileSync(join(work, 'greeting.js'), AFTER)

const recorded = []
let buffered = ''
let reviewThreadId = null

// The detached review thread inherits the app-server process's own working
// directory, not the seed thread's, so the process is started in the scratch
// repository rather than wherever this script was invoked from.
// A staged home, exactly as the app gives a Review one: the person's own
// `~/.codex` is never read beyond the credentials this borrows, so their MCP
// servers and settings are no part of the recording. It sits outside the
// scratch repository, or the review would find it and report on it.
const codexHome = mkdtempSync(join(tmpdir(), 'codex-review-home-'))
symlinkSync(join(homedir(), '.codex', 'auth.json'), join(codexHome, 'auth.json'))

const child = spawn('codex', ['app-server'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: work,
  env: { ...process.env, CODEX_HOME: codexHome }
})
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
          sandbox: 'read-only',
          threadSource: 'argos'
        }
      })
    }
    if (message.id === 2 && message.result) {
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'review/start',
        params: {
          threadId: message.result.thread.id,
          target: { type: 'uncommittedChanges' },
          delivery: 'detached'
        }
      })
    }
    if (message.id === 3 && message.result) reviewThreadId = message.result.reviewThreadId
    if (message.method === 'turn/completed' && message.params.threadId === reviewThreadId) finish()
  }
})

function keep(message, line) {
  // A recording is a long wait; say what is arriving so it can be watched.
  const item = message.params?.item
  console.error(`${message.method ?? `#${message.id}`} ${item?.type ?? ''}`)
  if (message.method && !KEEP.has(message.method)) return
  // Reasoning is the review thinking aloud; the Adapter reads none of it, and
  // a fixture is read by people.
  if (item?.type === 'reasoning') return
  const home = process.env.HOME ?? '~'
  recorded.push(line.split(work).join('/a-project').split(home).join('/Users/someone'))
}

function finish() {
  writeFileSync(FIXTURE, `${recorded.join('\n')}\n`)
  rmSync(work, { recursive: true, force: true })
  rmSync(codexHome, { recursive: true, force: true })
  console.log(`Recorded ${recorded.length} frames into ${FIXTURE}`)
  process.exit(0)
}

setTimeout(() => {
  console.error('Codex did not finish a review within twenty minutes')
  process.exit(1)
}, 1_200_000)

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { clientInfo: { name: 'argos', title: 'Argos', version: '0.1.0' } }
})
