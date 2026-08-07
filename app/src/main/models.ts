import { spawn } from 'node:child_process'
// Protocol lives with the Adapter, and this is the one module that speaks
// Codex's model listing. Main owns the process; nothing here reads a frame.
// The module is pure — no Effect crosses this import (ADR 0001).
import { openModelList, readModelListLine } from './codex-model-discovery-adapter'
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

/**
 * Asks the installed Codex what it can run: this owns the process and the
 * bytes, and the Adapter beside it owns what they mean. One app-server, one
 * question, no thread and no turn — so nothing is spent against the person's
 * account.
 */
async function askCodex(executable: string): Promise<ModelOption[] | null> {
  return new Promise((resolve) => {
    const child = spawn(executable, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let settled = false
    const finish = (answer: ModelOption[] | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // The same signal readiness uses: a Harness that will not stop is not
      // going to be asked politely twice.
      child.kill('SIGKILL')
      resolve(answer)
    }
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS)
    child.once('error', () => finish(null))
    child.once('exit', () => finish(null))

    const write = (frames: string[]): void => {
      if (child.stdin.writable) for (const line of frames) child.stdin.write(line)
    }
    let buffered = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk
      // A Harness writing without newlines is not answering this question, and
      // is not allowed to grow this without end.
      if (buffered.length > MAX_ANSWER_BYTES) {
        finish(null)
        return
      }
      for (;;) {
        const boundary = buffered.indexOf('\n')
        if (boundary < 0) break
        const line = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary + 1)
        if (!line.trim()) continue
        const step = readModelListLine(line)
        write(step.outgoing)
        if (step.models) finish(step.models)
      }
    })

    write([openModelList()])
  })
}

/** An answer larger than this is not one to the question that was asked. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024
