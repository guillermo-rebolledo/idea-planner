import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PlanningPolicy } from './planning-policy'

let workingDirectory: string
let planningDirectory: string
let policy: PlanningPolicy

beforeEach(async () => {
  workingDirectory = await mkdtemp(join(tmpdir(), 'planning-policy-'))
  planningDirectory = join(workingDirectory, '.scratch', 'idea')
  await mkdir(planningDirectory, { recursive: true })
  policy = new PlanningPolicy({ workingDirectory, planningDirectory })
})

afterEach(async () => rm(workingDirectory, { recursive: true, force: true }))

describe('planning policy', () => {
  it('allows safe reads and managed planning writes', async () => {
    await writeFile(join(workingDirectory, 'README.md'), 'safe')
    await expect(policy.authorize({ kind: 'read', path: 'README.md' })).resolves.toMatchObject({
      decision: 'allow'
    })
    await expect(
      policy.authorize({ kind: 'write', path: '.scratch/idea/spec.md', bytes: 100 })
    ).resolves.toMatchObject({ decision: 'allow' })
    await expect(
      policy.authorize({ kind: 'execute', executable: '/bin/ls' })
    ).resolves.toMatchObject({
      decision: 'allow'
    })
  })

  it.each([
    ['read', '.git/config', 'block'],
    ['read', '.env', 'stop'],
    ['write', 'src/index.ts', 'block'],
    ['execute', 'git', 'block'],
    ['execute', 'pnpm', 'block'],
    ['socket', 'localhost:3000', 'stop']
  ] as const)(
    'blocks %s access to %s without an override',
    async (kind, target, expectedDecision) => {
      const result = await policy.authorize(
        kind === 'execute'
          ? { kind, executable: target }
          : kind === 'socket'
            ? { kind, address: target }
            : { kind, path: target }
      )
      expect(result).toMatchObject({ decision: expectedDecision, overridable: false })
      expect(result.activity.summary).not.toContain(workingDirectory)
    }
  )

  it('blocks a symlink escape and stops immediately as a high-risk violation', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'))
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(workingDirectory, 'linked'))
    const result = await policy.authorize({ kind: 'read', path: 'linked/secret.txt' })
    expect(result).toMatchObject({ decision: 'stop', code: 'path-escape' })
    await rm(outside, { recursive: true, force: true })
  })

  it('blocks symlink aliases to protected and source paths inside the Idea', async () => {
    await mkdir(join(workingDirectory, '.git'), { recursive: true })
    await writeFile(join(workingDirectory, '.git', 'config'), 'private')
    await mkdir(join(workingDirectory, 'src'), { recursive: true })
    await symlink(join(workingDirectory, '.git'), join(workingDirectory, 'git-alias'))
    await symlink(join(workingDirectory, 'src'), join(planningDirectory, 'source-alias'))

    await expect(
      policy.authorize({ kind: 'read', path: 'git-alias/config' })
    ).resolves.toMatchObject({ decision: 'block', code: 'protected-tree' })
    await expect(
      policy.authorize({ kind: 'write', path: '.scratch/idea/source-alias/index.ts', bytes: 1 })
    ).resolves.toMatchObject({ decision: 'block', code: 'source-write' })
  })

  it('stops on the third repeated non-overridable violation', async () => {
    const first = await policy.authorize({ kind: 'execute', executable: 'node' })
    const second = await policy.authorize({ kind: 'execute', executable: 'node' })
    const third = await policy.authorize({ kind: 'execute', executable: 'node' })
    expect(first.decision).toBe('block')
    expect(second.decision).toBe('block')
    expect(third.decision).toBe('stop')
  })

  it('blocks changed planning content beyond the per-Run limit', async () => {
    for (let index = 0; index < 10; index++) {
      await expect(
        policy.authorize({
          kind: 'write',
          path: `.scratch/idea/part-${index}.md`,
          bytes: 5 * 1024 * 1024
        })
      ).resolves.toMatchObject({ decision: 'allow' })
    }
    await expect(
      policy.authorize({ kind: 'write', path: '.scratch/idea/overflow.md', bytes: 1 })
    ).resolves.toMatchObject({ decision: 'block', code: 'run-content-limit' })
  })
})
