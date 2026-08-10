/**
 * Probes whether the installed `claude` binary can be steered mid-turn, on the
 * transport this app drives it over and on the one it would have to move to.
 *
 *   pnpm claude:probe-steer
 *
 * MEM-125 gave Codex native steering through `turn/steer` and left Claude on
 * the queue, because Claude is read rather than answered here: the app passes
 * the prompt in argv and closes stdin. Whether a correction written to stdin
 * while a turn is in flight reaches that turn, waits for it to end, or is
 * dropped is a question only the binary can answer, and designing against a
 * guess would produce exactly the fake steer MEM-125 refused to ship.
 *
 * Two arms, because the answer differs by transport and both halves matter:
 *
 *   A. today — the prompt in argv, stdin held open. Establishes what the app's
 *      own invocation does with a mid-turn write.
 *   B. stdin — `--input-format stream-json`, the prompt as a user frame.
 *      Establishes whether the running turn takes a second frame.
 *
 * Each arm runs one real turn against a scratch git repository, so the probe
 * costs two Claude requests and needs the CLI signed in. Nothing outside those
 * scratch directories is read or written. Both streams are recorded to
 * `app/src/core/harness/fixtures/claude-steer-probe.jsonl`, and the finding is
 * written up in `.scratch/research/claude-steering-on-stdin.md`.
 *
 * One deliberate deviation from a real Run in both arms: full access and no
 * setting sources, so what is measured is the protocol rather than this
 * machine's approval bridge, hooks, and plugins.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIXTURE = 'app/src/core/harness/fixtures/claude-steer-probe.jsonl'
const PROBE_FILE = 'steer-probe.txt'
/** Long enough that the correction lands while the turn is demonstrably busy. */
const HOLD_SECONDS = 12
const ARM_TIMEOUT_MS = 180_000
/** How long an arm waits after a turn ends for a second one that may follow. */
const SETTLE_MS = 10_000

const FIRST_PROMPT = [
  `Run exactly this Bash command and wait for it: sleep ${HOLD_SECONDS}`,
  `Then write the single word ORIGINAL into ${PROBE_FILE}.`,
  'Do nothing else, and say nothing but the word done.'
].join(' ')

const STEER_PROMPT = [
  `Change of plan: write the single word STEERED into ${PROBE_FILE} instead of ORIGINAL.`,
  'Follow this correction rather than the earlier instruction.'
].join(' ')

/** Everything a Run passes that is not about how the prompt gets in. */
const SHARED_ARGS = [
  '--print',
  '--setting-sources',
  '',
  '--strict-mcp-config',
  '--permission-mode',
  'bypassPermissions',
  '--no-chrome',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages'
]

const recorded = []

const arms = [
  {
    name: 'A. prompt in argv, stdin held open — the shape a Run has today',
    args: [...SHARED_ARGS, FIRST_PROMPT],
    // Both spellings, because a text-format stdin would take the first and a
    // stream-json one the second: neither should be able to say it was unread.
    correction: () => `${STEER_PROMPT}\n${JSON.stringify(userFrame(STEER_PROMPT))}\n`
  },
  {
    name: 'B. prompt on stdin as a user frame — the shape steering would need',
    args: [...SHARED_ARGS, '--input-format', 'stream-json', '--replay-user-messages'],
    opening: () => `${JSON.stringify(userFrame(FIRST_PROMPT))}\n`,
    correction: () => `${JSON.stringify(userFrame(STEER_PROMPT))}\n`
  }
]

const userFrame = (text) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
  parent_tool_use_id: null
})

const results = []
for (const arm of arms) results.push(await run(arm))

writeFileSync(FIXTURE, `${recorded.join('\n')}\n`)
console.log(`\nclaude ${version()} on ${process.platform}`)
for (const result of results) console.log(`${result.name}\n  ${result.verdict}`)
console.log(`\nRecorded ${recorded.length} lines into ${FIXTURE}`)

/** One arm: start a turn, write a correction into it, and watch what happens. */
function run(arm) {
  return new Promise((resolve) => {
    const work = mkdtempSync(join(tmpdir(), 'claude-steer-'))
    execFileSync('git', ['init', '--quiet'], { cwd: work })
    const started = Date.now()
    const since = () => Date.now() - started
    const child = spawn('claude', arm.args, { cwd: work, stdio: ['pipe', 'pipe', 'pipe'] })
    const turns = []
    const echoes = []
    let buffered = ''
    let stderr = ''
    let correctedAt = null
    let settling = null

    recorded.push(`>>> arm ${arm.name}`, `>>> claude ${arm.args.join(' ')}`)

    const keep = (line) => {
      const home = process.env.HOME ?? '~'
      recorded.push(line.split(work).join('/a-project').split(home).join('/Users/someone'))
    }

    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    child.stdout.on('data', (chunk) => {
      buffered += chunk
      for (;;) {
        const boundary = buffered.indexOf('\n')
        if (boundary < 0) break
        const line = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary + 1)
        if (!line.trim()) continue
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          continue
        }
        // Deltas and this machine's hooks say nothing about the question.
        if (frame.type === 'stream_event') continue
        if (frame.type === 'system' && String(frame.subtype).startsWith('hook_')) continue
        keep(line)
        // The CLI echoing a frame back is the binary itself saying it read it.
        if (frame.isReplay && frame.message?.content?.[0]?.text?.startsWith('Change of plan')) {
          echoes.push(since())
          recorded.push(`>>> correction echoed back at +${String(since())}ms`)
        }
        // The correction goes in while the turn is provably working: the CLI
        // has said the sleep started, and cannot yet have finished it.
        if (
          correctedAt === null &&
          frame.type === 'system' &&
          frame.subtype === 'task_started' &&
          typeof frame.tool_use_id === 'string'
        ) {
          correctedAt = since()
          recorded.push(`>>> correction written to stdin at +${String(correctedAt)}ms`)
          child.stdin.write(arm.correction())
        }
        if (frame.type === 'result') {
          turns.push({ at: since(), subtype: frame.subtype })
          recorded.push(`>>> turn ended at +${String(since())}ms (${String(frame.subtype)})`)
          // A correction the CLI held becomes a second turn, so the first
          // ending is not the end of the measurement. Waiting for a second one
          // — and closing stdin if none comes — is what tells them apart.
          if (turns.length >= 2) child.stdin.end()
          else settling = setTimeout(() => child.stdin.writable && child.stdin.end(), SETTLE_MS)
        }
      }
    })

    const finish = (code) => {
      clearTimeout(settling)
      clearTimeout(deadline)
      const probePath = join(work, PROBE_FILE)
      const written = existsSync(probePath) ? readFileSync(probePath, 'utf8').trim() : '(no file)'
      const verdict = decide(written, turns, echoes)
      recorded.push(
        `>>> ${PROBE_FILE} holds ${JSON.stringify(written)}; ${String(turns.length)} turn(s); ${String(echoes.length)} echo(es); exit ${String(code)}`,
        `>>> verdict: ${verdict}`,
        ''
      )
      if (stderr.trim()) recorded.push(`>>> stderr: ${stderr.trim().slice(0, 500)}`, '')
      rmSync(work, { recursive: true, force: true })
      resolve({ name: arm.name, verdict })
    }

    const deadline = setTimeout(() => {
      recorded.push(`>>> no ending within ${String(ARM_TIMEOUT_MS / 1_000)}s`)
      child.kill('SIGTERM')
      setTimeout(() => finish(null), 2_000)
    }, ARM_TIMEOUT_MS)

    child.once('close', finish)
    if (arm.opening) child.stdin.write(arm.opening())
  })
}

/**
 * What the three possible answers look like on the wire. The file is the
 * outcome and the turn count is the mechanism: one turn that obeyed the
 * correction is a steer, a second turn is the queue Claude already has, and
 * neither is a correction that went nowhere.
 */
function decide(written, turns, echoes) {
  const seen = `${String(turns.length)} turn(s), ${String(echoes.length)} echo(es), file ${JSON.stringify(written)}`
  if (written === 'STEERED' && turns.length === 1)
    return `steered — the running turn took it (${seen})`
  if (turns.length >= 2) return `buffered — it became a second turn, which is the queue (${seen})`
  if (written === 'ORIGINAL')
    return `ignored — the turn ran to its end on the first instruction (${seen})`
  return `inconclusive — ${seen}`
}

function version() {
  try {
    return execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}
