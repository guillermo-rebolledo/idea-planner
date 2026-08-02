import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type Core } from './core'

/**
 * Standing Approvals, observed at the Core interface: what a Project keeps,
 * what it never lends to another Project, and what a Run is told about it.
 */

let stateDir: string
let core: Core
/** Two clones of one remote: different roots, and therefore different Projects. */
let workRoot: string
let otherRoot: string

function makeCore(): Core {
  let tick = 0
  return createCore({
    stateDirectory: stateDir,
    now: () => new Date(Date.UTC(2026, 7, 2, 12, 0, tick++)),
    randomId: (() => {
      let n = 0
      return () => `test-id-${String(++n).padStart(4, '0')}`
    })()
  })
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'standing-approval-state-'))
  workRoot = await mkdtemp(join(tmpdir(), 'standing-approval-work-'))
  otherRoot = await mkdtemp(join(tmpdir(), 'standing-approval-clone-'))
  core = makeCore()
  await core.addProject(workRoot)
  await core.addProject(otherRoot)
})

afterEach(async () => {
  await Promise.all(
    [stateDir, workRoot, otherRoot].map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('granting', () => {
  it('keeps the literal rule, and keeps it after a restart', async () => {
    await core.grantStandingApproval({
      projectRoot: workRoot,
      harness: 'claude',
      kind: 'command',
      rule: 'Bash(pnpm test:*)',
      summary: 'pnpm test'
    })

    expect(await makeCore().listStandingApprovals(workRoot)).toMatchObject([
      { projectRoot: workRoot, kind: 'command', rule: 'Bash(pnpm test:*)', summary: 'pnpm test' }
    ])
  })

  it('grants the same rule once, however many times it is asked for', async () => {
    const grant = (): Promise<unknown> =>
      core.grantStandingApproval({
        projectRoot: workRoot,
        harness: 'claude',
        kind: 'command',
        rule: 'Bash(pnpm test:*)',
        summary: 'pnpm test'
      })
    await grant()
    await grant()

    expect(await core.listStandingApprovals(workRoot)).toHaveLength(1)
  })

  it('refuses a Project the app was never given', async () => {
    await expect(
      core.grantStandingApproval({
        projectRoot: join(workRoot, 'not-a-project'),
        harness: 'claude',
        kind: 'command',
        rule: 'Bash(pnpm test:*)',
        summary: 'pnpm test'
      })
    ).rejects.toThrow(/Project/)
  })
})

describe('what a Project lends to another', () => {
  it('lends nothing, including to another clone of the same remote', async () => {
    await core.grantStandingApproval({
      projectRoot: workRoot,
      harness: 'claude',
      kind: 'edit',
      rule: `Edit(/${workRoot}/**)`,
      summary: 'Every file in this Project'
    })

    expect(await core.listStandingApprovals(otherRoot)).toEqual([])
    expect(await core.standingApprovalRules(otherRoot, 'claude')).toEqual([])
  })

  it('hands a Run only the rules of the Project it works in', async () => {
    await core.grantStandingApproval({
      projectRoot: workRoot,
      harness: 'claude',
      kind: 'command',
      rule: 'Bash(pnpm test:*)',
      summary: 'pnpm test'
    })
    await core.grantStandingApproval({
      projectRoot: otherRoot,
      harness: 'claude',
      kind: 'command',
      rule: 'Bash(cargo build:*)',
      summary: 'cargo build'
    })

    expect(await core.standingApprovalRules(workRoot, 'claude')).toEqual(['Bash(pnpm test:*)'])
  })
})

describe('revoking', () => {
  it('takes the rule back, and takes back only that one', async () => {
    const kept = await core.grantStandingApproval({
      projectRoot: workRoot,
      harness: 'claude',
      kind: 'command',
      rule: 'Bash(pnpm test:*)',
      summary: 'pnpm test'
    })
    const revoked = await core.grantStandingApproval({
      projectRoot: workRoot,
      harness: 'claude',
      kind: 'command',
      rule: 'Bash(git push:*)',
      summary: 'git push'
    })

    await core.revokeStandingApproval({ projectRoot: workRoot, id: revoked.id })

    expect((await makeCore().listStandingApprovals(workRoot)).map((entry) => entry.id)).toEqual([
      kept.id
    ])
  })

  it('refuses to revoke through a Project the approval does not belong to', async () => {
    const granted = await core.grantStandingApproval({
      projectRoot: workRoot,
      harness: 'claude',
      kind: 'command',
      rule: 'Bash(pnpm test:*)',
      summary: 'pnpm test'
    })

    await expect(
      core.revokeStandingApproval({ projectRoot: otherRoot, id: granted.id })
    ).rejects.toThrow()
    expect(await core.listStandingApprovals(workRoot)).toHaveLength(1)
  })
})

describe('forgetting a Project', () => {
  it('forgets what it was allowed to do, so re-adding it starts from asking', async () => {
    await core.grantStandingApproval({
      projectRoot: workRoot,
      harness: 'claude',
      kind: 'command',
      rule: 'Bash(pnpm test:*)',
      summary: 'pnpm test'
    })

    await core.removeProject(workRoot)
    await core.addProject(workRoot)

    expect(await core.listStandingApprovals(workRoot)).toEqual([])
  })
})
