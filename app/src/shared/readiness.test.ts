import { describe, expect, it } from 'vitest'
import { gateProblem, type HarnessReadiness, type ReadinessCheck } from './readiness'

/** One passing check, so a fixture only has to spell out the failing one. */
function ready(dimension: ReadinessCheck['dimension']): ReadinessCheck {
  return {
    dimension,
    status: 'ready',
    code: 'ready',
    summary: `${dimension} is ready`,
    command: null,
    links: []
  }
}

/** A harness with every dimension ready and a Session within reach. */
function readyHarness(overrides: Partial<HarnessReadiness> = {}): HarnessReadiness {
  return {
    harness: 'claude',
    displayName: 'Claude Code',
    command: 'claude',
    executablePath: '/usr/local/bin/claude',
    executableSource: 'path',
    version: '2.1.220',
    checks: [ready('executable'), ready('compatibility'), ready('authentication'), ready('skills')],
    capabilities: {
      developSession: { available: true, summary: 'Can run a Session.', command: null }
    },
    checkedAt: '2026-08-03T00:00:00.000Z',
    available: true,
    ...overrides
  }
}

function failing(
  dimension: ReadinessCheck['dimension'],
  overrides: Partial<ReadinessCheck> = {}
): ReadinessCheck {
  return {
    dimension,
    status: 'failed',
    code: 'probe-failed',
    summary: `${dimension} failed`,
    command: null,
    links: [],
    ...overrides
  }
}

describe('gateProblem', () => {
  it('is nothing for a Harness that can run a Session', () => {
    expect(gateProblem(readyHarness())).toBeNull()
  })

  it('reads a missing executable as not installed, with its repair', () => {
    const harness = readyHarness({
      checks: [
        failing('executable', {
          code: 'executable-missing',
          summary: 'The claude command was not found on your PATH.',
          command: 'npm install -g @anthropic-ai/claude-code'
        }),
        failing('compatibility', { status: 'not-probed', code: 'not-probed' }),
        failing('authentication', { status: 'not-probed', code: 'not-probed' }),
        failing('skills', { status: 'not-probed', code: 'not-probed' })
      ],
      capabilities: {
        developSession: { available: false, summary: 'Install it first.', command: null }
      },
      available: false
    })
    expect(gateProblem(harness)).toEqual({
      severity: 'missing',
      label: 'Not installed',
      summary: 'The claude command was not found on your PATH.',
      command: 'npm install -g @anthropic-ai/claude-code'
    })
  })

  it('reads a version problem as installed but unsupported', () => {
    const harness = readyHarness({
      checks: [
        ready('executable'),
        failing('compatibility', {
          code: 'version-incompatible',
          summary: 'Version 0.1.0 is older than this app can talk to.',
          command: 'npm update -g @anthropic-ai/claude-code'
        }),
        failing('authentication', { status: 'not-probed', code: 'not-probed' }),
        ready('skills')
      ],
      capabilities: {
        developSession: { available: false, summary: 'Update it first.', command: null }
      },
      available: false
    })
    expect(gateProblem(harness)).toEqual({
      severity: 'blocked',
      label: 'Installed, version not supported',
      summary: 'Version 0.1.0 is older than this app can talk to.',
      command: 'npm update -g @anthropic-ai/claude-code'
    })
  })

  it('reads a sign-in problem as installed but signed out', () => {
    const harness = readyHarness({
      checks: [
        ready('executable'),
        ready('compatibility'),
        failing('authentication', {
          code: 'unauthenticated',
          summary: 'codex is installed but not signed in.',
          command: 'codex login'
        }),
        ready('skills')
      ],
      capabilities: {
        developSession: { available: false, summary: 'Sign in first.', command: null }
      },
      available: false
    })
    expect(gateProblem(harness)).toEqual({
      severity: 'blocked',
      label: 'Installed, not signed in',
      summary: 'codex is installed but not signed in.',
      command: 'codex login'
    })
  })

  it('falls back to the capability itself when every check passes and a Session still cannot run', () => {
    const harness = readyHarness({
      capabilities: {
        developSession: {
          available: false,
          summary: 'This Codex cannot run a Session with this app yet.',
          command: 'npm update -g @openai/codex'
        }
      }
    })
    expect(gateProblem(harness)).toEqual({
      severity: 'blocked',
      label: 'Installed, cannot run a Session yet',
      summary: 'This Codex cannot run a Session with this app yet.',
      command: 'npm update -g @openai/codex'
    })
  })

  it('never blames Skills, which gate nothing', () => {
    const harness = readyHarness({
      checks: [
        ready('executable'),
        ready('compatibility'),
        ready('authentication'),
        failing('skills', { code: 'skills-missing', summary: 'No Skills installed.' })
      ]
    })
    expect(gateProblem(harness)).toBeNull()
  })
})
