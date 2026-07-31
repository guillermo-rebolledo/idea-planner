import type {} from 'electron'
import {
  CONTRACT_VERSION,
  CoreError,
  coreRequestSchema,
  type CoreCommand,
  type CoreResponse
} from '@shared/contract'
import { createCore } from './core'

/**
 * Entry point for the Core utility process. It owns product behavior and
 * speaks to Main exclusively through validated, correlated messages.
 */
const core = createCore()
const parentPort = process.parentPort

parentPort.on('message', (event) => {
  void handleMessage(event.data)
})

async function handleMessage(data: unknown): Promise<void> {
  const parsed = coreRequestSchema.safeParse(data)
  if (!parsed.success) {
    respond(bestEffortRequestId(data), {
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Malformed Core request' }
    })
    return
  }

  const { id, command } = parsed.data
  try {
    respond(id, { ok: true, result: await dispatch(command) })
  } catch (error) {
    const code = error instanceof CoreError ? error.code : 'IO_ERROR'
    const message = error instanceof Error ? error.message : 'Unexpected Core failure'
    respond(id, { ok: false, error: { code, message } })
  }
}

function dispatch(command: CoreCommand): Promise<unknown> {
  switch (command.type) {
    case 'library/open':
      return core.openLibrary(command.path)
    case 'idea/capture':
      return core.captureIdea(command.input)
    case 'idea/list':
      return core.listIdeas()
  }
}

function respond(id: string, outcome: CoreResponse['outcome']): void {
  const response: CoreResponse = { contractVersion: CONTRACT_VERSION, id, outcome }
  parentPort.postMessage(response)
}

function bestEffortRequestId(data: unknown): string {
  if (
    typeof data === 'object' &&
    data !== null &&
    'id' in data &&
    typeof (data as { id: unknown }).id === 'string'
  ) {
    return (data as { id: string }).id
  }
  return 'unknown'
}
