import { describe, expect, it } from 'vitest'
import {
  createPullRequestInputSchema,
  pullRequestSchema,
  preparePullRequestResultSchema
} from './pull-request'
import { mailboxSessionSchema } from './contract'

describe('the pull request contract', () => {
  it('keeps remote state separate from Session status and rejects unsafe drafts', () => {
    expect(
      pullRequestSchema.parse({
        number: 42,
        url: 'https://github.com/example/argos/pull/42',
        title: 'Publish the Session',
        state: 'merged'
      })
    ).toEqual({
      number: 42,
      url: 'https://github.com/example/argos/pull/42',
      title: 'Publish the Session',
      state: 'merged'
    })
    expect(
      createPullRequestInputSchema.safeParse({
        sessionId: 'session-1',
        baseBranch: 'main',
        title: '',
        body: '## Summary\n\n- Changed it'
      }).success
    ).toBe(false)
  })

  it('names local Checkout refusal instead of presenting a draft', () => {
    expect(
      preparePullRequestResultSchema.parse({ status: 'unavailable', reason: 'local-checkout' })
    ).toEqual({ status: 'unavailable', reason: 'local-checkout' })
  })

  it('defaults the mailbox adornment for Sessions written before the integration', () => {
    const parsed = mailboxSessionSchema.parse({
      id: 'session-1',
      projectRoot: '/project',
      title: 'A Session',
      createdAt: '2026-08-07T12:00:00.000Z',
      updatedAt: '2026-08-07T12:00:00.000Z',
      dormant: false,
      status: 'idle'
    })
    expect(parsed.pullRequest).toBeNull()
  })
})
