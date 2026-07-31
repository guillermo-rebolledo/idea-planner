import type {} from 'electron'
import { Effect, type Fiber } from 'effect'
import {
  CONTRACT_VERSION,
  CoreError,
  coreRequestSchema,
  type CoreCommand,
  type CoreResponse
} from '@shared/contract'
import { createCoreEffects } from './core'

/**
 * Entry point for the Core utility process. It owns product behavior and
 * speaks to Main exclusively through validated, correlated messages.
 *
 * Each request runs in its own fiber, tracked by request id: a future
 * cancellation envelope interrupts the matching fiber, which composes with
 * whatever cleanup the running work acquired.
 */
const core = createCoreEffects()
const parentPort = process.parentPort
const inFlight = new Map<string, Fiber.RuntimeFiber<void>>()

parentPort.on('message', (event) => {
  handleMessage(event.data)
})

function handleMessage(data: unknown): void {
  const parsed = coreRequestSchema.safeParse(data)
  if (!parsed.success) {
    respond(bestEffortRequestId(data), {
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Malformed Core request' }
    })
    return
  }

  const { id, command } = parsed.data
  const program = dispatch(command).pipe(
    Effect.catchAllDefect((defect) =>
      Effect.fail(
        defect instanceof CoreError
          ? defect
          : new CoreError(
              'IO_ERROR',
              defect instanceof Error ? defect.message : 'Unexpected Core failure'
            )
      )
    ),
    Effect.match({
      onSuccess: (result): CoreResponse['outcome'] => ({ ok: true, result }),
      onFailure: (error): CoreResponse['outcome'] => ({
        ok: false,
        error: { code: error.code, message: error.message }
      })
    }),
    Effect.flatMap((outcome) => Effect.sync(() => respond(id, outcome))),
    Effect.ensuring(Effect.sync(() => inFlight.delete(id)))
  )
  inFlight.set(id, Effect.runFork(program))
}

function dispatch(command: CoreCommand): Effect.Effect<unknown, CoreError> {
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
  if (typeof data === 'object' && data !== null && 'id' in data && typeof data.id === 'string') {
    return data.id
  }
  return 'unknown'
}
