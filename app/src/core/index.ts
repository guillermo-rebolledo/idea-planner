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
const core = createCoreEffects({
  // Only Main knows where application support lives, so it passes the path in
  // when it forks this process. Core refuses to guess one (ADR 0002).
  stateDirectory: process.env['APP_STATE_DIRECTORY']
})
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
    case 'project/add':
      return core.addProject(command.root)
    case 'project/list':
      return core.listProjects()
    case 'project/remove':
      return core.removeProject(command.root)
    case 'project/trust-skills':
      return core.setProjectSkillsTrusted(command.root, command.trusted)
    case 'approval/grant':
      return core.grantStandingApproval(command.input)
    case 'approval/list':
      return core.listStandingApprovals(command.projectRoot)
    case 'approval/rules':
      return core.standingApprovalRules(command.projectRoot, command.harness)
    case 'approval/revoke':
      return core.revokeStandingApproval(command.input)
    case 'session/start':
      return core.startSession(command.input)
    case 'session/list':
      return core.listSessions()
    case 'session/list-damaged':
      return core.listDamagedSessions()
    case 'session/get':
      return core.getSession(command.sessionId)
    case 'mailbox/query':
      return core.queryMailbox(command.query)
    case 'session/set-pinned':
      return core.setSessionPinned(command.sessionId, command.pinned)
    case 'session/set-archived':
      return core.setSessionArchived(command.sessionId, command.archived)
    case 'session/rename':
      return core.renameSession(command.input.sessionId, command.input.title)
    case 'session/delete':
      return core.deleteSession(command.sessionId)
    case 'run/accept':
      return core.acceptRun(command.input)
    case 'run/list':
      return core.listRuns(command.sessionId)
    case 'run/event':
      return core.recordRunEvent(command.input)
    case 'conversation/get':
      return core.getConversation(command.sessionId)
    case 'conversation/submit':
      return core.submitConversationMessage(command.input)
    case 'conversation/queue-enqueue':
      return core.enqueueQueuedSubmission(command.input)
    case 'conversation/queue-edit':
      return core.editQueuedSubmission(command.input)
    case 'conversation/queue-move':
      return core.moveQueuedSubmission(command.input)
    case 'conversation/queue-prioritize':
      return core.prioritizeQueuedSubmission(command.input)
    case 'conversation/queue-cancel':
      return core.cancelQueuedSubmission(command.input)
    case 'conversation/queue-state':
      return core.setConversationQueuePaused(command.input)
    case 'conversation/queue-claim':
      return core.claimQueuedSubmission(command.sessionId)
    case 'conversation/queue-release':
      return core.releaseQueuedSubmission(command.input)
    case 'conversation/queue-sent':
      return core.markQueuedSubmissionSent(command.input)
    case 'conversation/begin':
      return core.beginConversationRun({
        sessionId: command.sessionId,
        runId: command.runId,
        submissionId: command.submissionId,
        harness: command.harness,
        skill: command.skill,
        model: command.model,
        restorationNote: command.restorationNote,
        // Without this the Conversation has nothing to compare the Harness's
        // reported mode against, so a Run in a mode nobody chose reads as one
        // that ran exactly as asked.
        askedPermissionMode: command.askedPermissionMode
      })
    case 'harness/open':
      return core.openHarness({
        runId: command.runId,
        harness: command.harness,
        launch: command.launch
      })
    case 'harness/answer':
      return core.answerHarnessApproval({
        runId: command.runId,
        approvalId: command.approvalId,
        allow: command.allow,
        remember: command.remember
      })
    case 'harness/interrupt':
      return core.interruptHarness(command.runId)
    case 'conversation/ingest':
      return core.ingestHarnessOutput({
        sessionId: command.sessionId,
        runId: command.runId,
        harness: command.harness,
        chunk: command.chunk
      })
    case 'conversation/apply':
      return core.applyHarnessEvent({
        sessionId: command.sessionId,
        runId: command.runId,
        event: command.event
      })
    case 'conversation/checkout-changes':
      return core.recordCheckoutChanges(command.input)
    case 'conversation/unfinished':
      return core.listUnfinishedRuns()
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
