import { describe, expect, it } from 'vitest'
import { pullRequestPresentation } from './pull-request-presentation'

describe('Pull Request mailbox presentation', () => {
  it.each([
    ['draft', 'PR draft', 'text-muted-foreground'],
    ['open', 'PR open', 'text-emerald-600'],
    ['merged', 'PR merged', 'text-violet-600'],
    ['closed', 'PR closed without merging', 'text-red-600']
  ] as const)('presents %s separately from Run status', (state, label, colorClass) => {
    expect(pullRequestPresentation(state)).toEqual({ label, colorClass })
  })
})
