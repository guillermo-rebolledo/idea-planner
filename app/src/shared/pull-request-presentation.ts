import type { PullRequestState } from './pull-request'

export function pullRequestPresentation(state: PullRequestState): {
  label: string
  colorClass: string
} {
  const presentations = {
    draft: { label: 'PR draft', colorClass: 'text-muted-foreground' },
    open: { label: 'PR open', colorClass: 'text-emerald-600' },
    merged: { label: 'PR merged', colorClass: 'text-violet-600' },
    closed: { label: 'PR closed without merging', colorClass: 'text-red-600' }
  } as const
  return presentations[state]
}
