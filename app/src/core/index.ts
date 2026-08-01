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

process.once('beforeExit', () => {
  void Effect.runPromise(core.shutdown)
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
    case 'idea/open':
      return core.openIdea(command.relativePath)
    case 'idea/list':
      return core.listIdeas()
    case 'mailbox/query':
      return core.queryMailbox(command.query)
    case 'idea/set-pinned':
      return core.setIdeaPinned(command.relativePath, command.pinned)
    case 'idea/set-archived':
      return core.setIdeaArchived(command.relativePath, command.archived)
    case 'idea/delete-preview':
      return core.previewDeleteIdea(command.relativePath)
    case 'idea/reconcile':
      return core.reconcileIdea(command.input)
    case 'idea/reconciliation-latest':
      return core.latestReconciliation(command.relativePath)
    case 'idea/locate':
      return core.locateIdea(
        command.relativePath,
        command.selectedDirectory,
        command.expectedIdeaId
      )
    case 'idea/restore-version':
      return core.restoreManagedVersion(command.input)
    case 'idea/resolve-conflict':
      return core.resolveManagedConflict(command.input)
    case 'idea/resolve-duplicate':
      return core.resolveDuplicateManagedDocument(command.input)
    case 'run/reconciliation-end':
      return core.endRunReconciliation(command.relativePath, command.runId)
    case 'reference/add':
      return core.addReferenceAttachment({
        relativePath: command.relativePath,
        messageId: command.messageId,
        sourcePath: command.sourcePath
      })
    case 'reference/list':
      return core.listReferenceAttachments(command.relativePath)
    case 'reference/keep':
      return core.keepReferenceWithIdea(command.input)
    case 'reference/continue-without':
      return core.continueWithoutReference(command.input)
    case 'reference/locate':
      return core.locateReferenceAttachment(command.input)
    case 'reference/prepare-context':
      return core.prepareReferenceContext(command)
    case 'reference/remove-context':
      return core.removeReferenceContext(command.contextId)
    case 'run/accept':
      return core.acceptRun(command.input)
    case 'run/list':
      return core.listRuns(command.relativePath)
    case 'run/event':
      return core.recordRunEvent(command.input)
    case 'conversation/get':
      return core.getConversation(command.relativePath)
    case 'conversation/submit':
      return core.submitConversationMessage(command.input)
    case 'conversation/begin':
      return core.beginConversationRun({
        relativePath: command.relativePath,
        runId: command.runId,
        submissionId: command.submissionId,
        provider: command.provider,
        workflow: command.workflow,
        model: command.model,
        restorationNote: command.restorationNote
      })
    case 'conversation/ingest':
      return core.ingestProviderOutput({
        relativePath: command.relativePath,
        runId: command.runId,
        provider: command.provider,
        chunk: command.chunk
      })
    case 'conversation/apply':
      return core.applyHarnessEvent({
        relativePath: command.relativePath,
        runId: command.runId,
        event: command.event
      })
    case 'conversation/finalize':
      return core.finalizeConversationRun(command.input)
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
