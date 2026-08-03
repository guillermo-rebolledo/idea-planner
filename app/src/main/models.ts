import { spawn } from 'node:child_process'
import { z } from 'zod'
import type { HarnessId } from '@shared/readiness'
import {
  CLAUDE_DEFAULT_EFFORT,
  CLAUDE_EFFORTS,
  CLAUDE_MODEL_ALIASES,
  type ModelCatalog,
  type ModelGroup,
  type ModelOption
} from '@shared/model'

/**
 * What each usable Harness can be asked for.
 *
 * Codex is asked. Its app-server answers `model/list` with the models it would
 * offer and the reasoning efforts each one supports — which differ per model —
 * so the list cannot go stale under this app. Claude Code enumerates nothing,
 * so what it offers is what its own `--model` help documents (ticket 13).
 *
 * A Harness that cannot answer contributes no group at all. An empty group
 * would say the Harness has no models, which is a different thing from this
 * app not having been able to ask.
 */

export interface HarnessToAsk {
  harness: HarnessId
  displayName: string
  executablePath: string
}

/** How long the app-server is given to answer before the question is dropped. */
const PROBE_TIMEOUT_MS = 10_000

export async function discoverModels(harnesses: HarnessToAsk[]): Promise<ModelCatalog> {
  const groups = await Promise.all(harnesses.map((harness) => describe(harness)))
  return { groups: groups.filter((group): group is ModelGroup => group !== null) }
}

async function describe(harness: HarnessToAsk): Promise<ModelGroup | null> {
  if (harness.harness === 'claude') {
    return {
      harness: 'claude',
      displayName: harness.displayName,
      source: 'documented',
      models: CLAUDE_MODEL_ALIASES.map((alias) => ({
        ...alias,
        efforts: CLAUDE_EFFORTS,
        defaultEffort: CLAUDE_DEFAULT_EFFORT
      }))
    }
  }
  const models = await askCodex(harness.executablePath)
  if (models === null || models.length === 0) return null
  return { harness: harness.harness, displayName: harness.displayName, source: 'probed', models }
}

/** Only what the picker needs; the rest of Codex's model record is its own. */
const codexModelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).optional(),
  description: z.string().optional(),
  hidden: z.boolean().default(false),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string().min(1) })).default([]),
  defaultReasoningEffort: z.string().optional()
})

const codexAnswerSchema = z.object({
  id: z.number(),
  result: z.object({ data: z.array(codexModelSchema) })
})

/**
 * Asks the installed Codex what it can run. This starts an app-server, asks
 * one question and stops it: no thread, no turn, and so no request against the
 * person's account.
 */
async function askCodex(executable: string): Promise<ModelOption[] | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (answer: ModelOption[] | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGTERM')
      resolve(answer)
    }
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS)
    const child = spawn(executable, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
    child.once('error', () => finish(null))
    child.once('exit', () => finish(null))

    const send = (message: unknown): void => {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`)
    }
    let buffered = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk
      for (;;) {
        const boundary = buffered.indexOf('\n')
        if (boundary < 0) break
        const line = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary + 1)
        if (!line.trim()) continue
        let frame: unknown
        try {
          frame = JSON.parse(line)
        } catch {
          continue
        }
        if ((frame as { id?: number }).id === INITIALIZE) {
          send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          send({ jsonrpc: '2.0', id: LIST, method: 'model/list', params: {} })
          continue
        }
        const answer = codexAnswerSchema.safeParse(frame)
        if (answer.success && answer.data.id === LIST) {
          finish(
            answer.data.result.data
              // Hidden is Codex's own word for what it keeps out of its
              // picker, and this app is not the place to overrule it.
              .filter((model) => !model.hidden)
              .map((model) => ({
                id: model.id,
                name: model.displayName ?? model.id,
                description: model.description ?? '',
                efforts: model.supportedReasoningEfforts.map((effort) => ({
                  id: effort.reasoningEffort,
                  name: name(effort.reasoningEffort)
                })),
                defaultEffort: model.defaultReasoningEffort ?? null
              }))
          )
        }
      }
    })

    send({
      jsonrpc: '2.0',
      id: INITIALIZE,
      method: 'initialize',
      params: { clientInfo: { name: 'argos', title: 'Argos', version: '0.1.0' } }
    })
  })
}

const INITIALIZE = 1
const LIST = 2

/** Codex names its levels in one word; this is the same word, for a button. */
function name(effort: string): string {
  if (effort === 'medium') return 'Med'
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}
