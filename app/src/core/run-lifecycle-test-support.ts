import type { CheckoutChange, HarnessFailureCategory } from '@shared/conversation'
import type { TerminalRunObservation, TerminalRunStatus } from '@shared/run-lifecycle'
import type { Core } from './core'

export interface FinishRunInput {
  sessionId: string
  runId: string
  outcome: TerminalRunStatus
  category: HarnessFailureCategory | null
  summary: string
}

function terminalObservation(input: FinishRunInput): TerminalRunObservation {
  switch (input.outcome) {
    case 'completed':
      return { type: 'harness-completed', kind: 'lifecycle', summary: input.summary }
    case 'failed':
      return {
        type: 'harness-failed',
        kind: 'error',
        summary: input.summary,
        category: input.category
      }
    case 'stopped':
      return { type: 'person-stopped', kind: 'lifecycle', summary: input.summary }
    case 'policy-violation':
      return { type: 'policy-violation', kind: 'blocked', summary: input.summary }
    case 'supervision-failed':
      return { type: 'supervision-failed', kind: 'error', summary: input.summary }
  }
}

export async function finishRunLifecycle(
  core: Core,
  input: FinishRunInput,
  changes?: CheckoutChange[]
): Promise<void> {
  await core.completeRunLifecycle({
    sessionId: input.sessionId,
    runId: input.runId,
    observation: terminalObservation(input),
    checkoutObservation: changes ? { status: 'observed', changes } : { status: 'unavailable' }
  })
}
