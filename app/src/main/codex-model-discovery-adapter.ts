import { z } from 'zod'
import type { ModelOption } from '@shared/model'

/**
 * Asking Codex what it can run, in Codex's own protocol.
 *
 * It lives beside the Adapter because that is where protocol belongs: nothing
 * outside translates a raw Harness frame, so there is one place a moved field
 * or a renamed method has to be fixed. Main owns the process and the bytes;
 * this owns what the bytes mean.
 *
 * `model/list` costs nothing against the person's account — it is answered
 * before any thread or turn exists.
 */

/** The frame that opens the conversation. Nothing is asked until it answers. */
export function openModelList(): string {
  return frame({
    jsonrpc: '2.0',
    id: INITIALIZE,
    method: 'initialize',
    // The contract asks for both; the binary accepts the pair, and naming
    // capabilities as none is truer than leaving it out.
    params: {
      clientInfo: { name: 'argos', title: 'Argos', version: '0.1.0' },
      capabilities: null
    }
  })
}

/**
 * One line Codex wrote, and what to do about it: more to say, an answer, or
 * neither. Framing lines out of the stream is transport and stays with the
 * process; deciding what they mean is this.
 */
export function readModelListLine(line: string): {
  outgoing: string[]
  models: ModelOption[] | null
} {
  const nothing = { outgoing: [], models: null }
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return nothing
  }
  if ((record as { id?: unknown }).id === INITIALIZE) {
    return {
      outgoing: [
        frame({ jsonrpc: '2.0', method: 'initialized', params: {} }),
        frame({
          jsonrpc: '2.0',
          id: LIST,
          method: 'model/list',
          params: {}
        })
      ],
      models: null
    }
  }
  const answer = answerSchema.safeParse(record)
  if (!answer.success || answer.data.id !== LIST) return nothing
  return {
    outgoing: [],
    models: answer.data.result.data
      // `hidden` is Codex's own word for what it keeps out of its picker, and
      // this app is not the place to overrule it.
      .filter((model) => !model.hidden)
      .map((model) => ({
        id: model.id,
        name: model.displayName ?? model.id,
        description: model.description ?? '',
        efforts: model.supportedReasoningEfforts.map((effort) => ({
          id: effort.reasoningEffort,
          name: label(effort.reasoningEffort)
        })),
        defaultEffort: model.defaultReasoningEffort ?? null
      }))
  }
}

const INITIALIZE = 1
const LIST = 2

type ModelDiscoveryRequest =
  | {
      jsonrpc: '2.0'
      id: typeof INITIALIZE
      method: 'initialize'
      params: {
        clientInfo: { name: string; title: string; version: string }
        capabilities: null
      }
    }
  | { jsonrpc: '2.0'; method: 'initialized'; params: Record<string, never> }
  | { jsonrpc: '2.0'; id: typeof LIST; method: 'model/list'; params: Record<string, never> }

/**
 * Only the fields the picker reads, validated because they arrive over a pipe.
 * It is deliberately local to the Codex model-discovery adapter. Runtime zod
 * validation keeps a changed Harness response from emptying the picker with
 * partially trusted data.
 */
const codexModelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).optional(),
  description: z.string().optional(),
  hidden: z.boolean().default(false),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string().min(1) })).default([]),
  defaultReasoningEffort: z.string().optional()
})

const answerSchema = z.object({
  id: z.number(),
  result: z.object({ data: z.array(codexModelSchema) })
})

function frame(message: ModelDiscoveryRequest): string {
  return `${JSON.stringify(message)}\n`
}

/** Codex names its levels in one word; this is that word, for a button. */
function label(effort: string): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}
