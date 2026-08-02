import { EventEmitter } from 'node:events'
import type { SpawnOptionsWithoutStdio } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { RunProcessBroker, type SpawnedProcess } from './run-process-broker'

function fakeProcess(pid = 4242): SpawnedProcess & EventEmitter {
  const child = new EventEmitter() as SpawnedProcess & EventEmitter
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

describe('Run process broker', () => {
  it('launches without a shell in a private directory and reduced-priority process group', async () => {
    const child = fakeProcess()
    const spawn = vi.fn(
      (_file: string, _args: string[], _options: SpawnOptionsWithoutStdio) => child
    )
    const broker = new RunProcessBroker({
      spawn,
      killProcessGroup: vi.fn(),
      waitForGroupExit: vi.fn()
    })
    await broker.start({
      id: 'run-1',
      executable: '/opt/codex',
      args: ['run'],
      workingDirectory: '/work',
      runDirectory: '/private/run-1',
      environment: { LANG: 'en_US.UTF-8' }
    })
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/nice',
      ['-n', '10', '/opt/codex', 'run'],
      expect.objectContaining({
        shell: false,
        detached: true,
        cwd: '/work',
        env: { LANG: 'en_US.UTF-8', TMPDIR: '/private/run-1' }
      })
    )
  })

  it('terminates and verifies the entire process group on Stop', async () => {
    const child = fakeProcess()
    const killProcessGroup = vi.fn()
    const waitForGroupExit = vi.fn().mockResolvedValue(undefined)
    const cleanupRunDirectory = vi.fn().mockResolvedValue(undefined)
    const broker = new RunProcessBroker({
      spawn: () => child,
      killProcessGroup,
      waitForGroupExit,
      cleanupRunDirectory
    })
    await broker.start({
      id: 'run-1',
      executable: '/opt/codex',
      args: [],
      workingDirectory: '/work',
      runDirectory: '/private/run-1',
      environment: {}
    })
    await broker.stop('run-1', 'user')
    expect(killProcessGroup).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(waitForGroupExit).toHaveBeenCalledWith(4242)
    expect(cleanupRunDirectory).toHaveBeenCalledWith('/private/run-1')
    expect(broker.activeRunIds()).toEqual([])
  })

  it('blocks new Runs after supervision cannot verify cleanup', async () => {
    const child = fakeProcess()
    const broker = new RunProcessBroker({
      spawn: () => child,
      killProcessGroup: vi.fn(),
      waitForGroupExit: vi.fn().mockRejectedValue(new Error('still alive'))
    })
    await broker.start({
      id: 'run-1',
      executable: '/opt/codex',
      args: [],
      workingDirectory: '/work',
      runDirectory: '/private/run-1',
      environment: {}
    })
    await expect(broker.stop('run-1', 'core-crash')).rejects.toThrow('could not verify')
    await expect(
      broker.start({
        id: 'run-2',
        executable: '/opt/codex',
        args: [],
        workingDirectory: '/work',
        runDirectory: '/private/run-2',
        environment: {}
      })
    ).rejects.toThrow('Supervision recovery is required')
  })

  it('treats a process group disappearing during a monitor tick as a normal exit', async () => {
    const child = fakeProcess()
    const onSupervisionFailure = vi.fn()
    const countProcessGroupMembers = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Command failed: /bin/ps -o pid= -g 4242'), { code: 1 })
      )
    const broker = new RunProcessBroker({
      spawn: () => child,
      killProcessGroup: vi.fn(),
      waitForGroupExit: vi.fn().mockResolvedValue(undefined),
      countProcessGroupMembers,
      monitorIntervalMs: undefined
    })
    await broker.start({
      id: 'run-1',
      executable: '/opt/claude',
      args: [],
      workingDirectory: '/work',
      runDirectory: '/private/run-1',
      environment: {},
      onSupervisionFailure
    })
    await expect(broker.inspectLimits('run-1')).resolves.toBeUndefined()
    expect(onSupervisionFailure).not.toHaveBeenCalled()
  })

  it('verifies the process group after the Harness root exits', async () => {
    const child = fakeProcess()
    const waitForGroupExit = vi.fn().mockResolvedValue(undefined)
    const killProcessGroup = vi.fn()
    const onExit = vi.fn()
    const broker = new RunProcessBroker({
      spawn: () => child,
      killProcessGroup,
      waitForGroupExit
    })
    await broker.start({
      id: 'run-1',
      executable: '/opt/codex',
      args: [],
      workingDirectory: '/work',
      runDirectory: '/private/run-1',
      environment: {},
      onExit
    })
    child.emit('close', 0, null)
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(0, null))
    expect(waitForGroupExit).toHaveBeenCalledWith(4242)
    expect(killProcessGroup).toHaveBeenCalledWith(4242, 'SIGTERM')
  })

  it('fails supervision when natural-exit cleanup cannot be verified', async () => {
    const child = fakeProcess()
    const onExit = vi.fn()
    const onSupervisionFailure = vi.fn()
    const broker = new RunProcessBroker({
      spawn: () => child,
      killProcessGroup: vi.fn(),
      waitForGroupExit: vi.fn().mockResolvedValue(undefined),
      cleanupRunDirectory: vi.fn().mockRejectedValue(new Error('cleanup failed'))
    })
    await broker.start({
      id: 'run-1',
      executable: '/opt/codex',
      args: [],
      workingDirectory: '/work',
      runDirectory: '/private/run-1',
      environment: {},
      onExit,
      onSupervisionFailure
    })
    child.emit('close', 0, null)
    await vi.waitFor(() => expect(onSupervisionFailure).toHaveBeenCalledOnce())
    expect(onExit).not.toHaveBeenCalled()
    expect(broker.needsRecovery()).toBe(true)
  })

  it('stops the process group when combined output exceeds its limit', async () => {
    const child = fakeProcess()
    const onLimitViolation = vi.fn()
    const killProcessGroup = vi.fn()
    const broker = new RunProcessBroker({
      spawn: () => child,
      killProcessGroup,
      waitForGroupExit: vi.fn().mockResolvedValue(undefined),
      cleanupRunDirectory: vi.fn().mockResolvedValue(undefined),
      outputLimitBytes: 4
    })
    await broker.start({
      id: 'run-1',
      executable: '/opt/codex',
      args: [],
      workingDirectory: '/work',
      runDirectory: '/private/run-1',
      environment: {},
      onLimitViolation
    })
    child.stdout.emit('data', Buffer.from('12345'))
    await vi.waitFor(() => expect(broker.activeRunIds()).toEqual([]))
    expect(onLimitViolation).toHaveBeenCalledOnce()
    expect(killProcessGroup).toHaveBeenCalledWith(4242, 'SIGTERM')
  })

  it('stops a process group that exceeds the descendant limit', async () => {
    const child = fakeProcess()
    const onLimitViolation = vi.fn()
    const broker = new RunProcessBroker({
      spawn: () => child,
      killProcessGroup: vi.fn(),
      waitForGroupExit: vi.fn().mockResolvedValue(undefined),
      cleanupRunDirectory: vi.fn().mockResolvedValue(undefined),
      countProcessGroupMembers: vi.fn().mockResolvedValue(17)
    })
    await broker.start({
      id: 'run-1',
      executable: '/opt/codex',
      args: [],
      workingDirectory: '/work',
      runDirectory: '/private/run-1',
      environment: {},
      onLimitViolation
    })
    await broker.inspectLimits('run-1')
    expect(onLimitViolation).toHaveBeenCalledWith(
      'Harness process tree exceeded the 16-process Run limit'
    )
    expect(broker.activeRunIds()).toEqual([])
  })
})
