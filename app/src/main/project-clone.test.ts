import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChooseProjectResult, ProjectCloneEvent } from '@shared/contract'
import * as Effect from 'effect/Effect'
import { ProjectCloneService } from './project-clone'
import {
  nativeProjectCloneLayer,
  ProjectCloneProcessError,
  type ProjectCloneLaunch
} from './project-clone-native'
import {
  createMainEffectRuntime,
  nativeRunLayer,
  type MainEffectRuntime
} from './run-process-broker'

const scratch: string[] = []
const runtimes: MainEffectRuntime[] = []
const hooksDirectory = join(tmpdir(), 'argos-project-clone-empty-hooks')

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()))
  await Promise.all(scratch.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'argos-project-clone-'))
  scratch.push(path)
  return path
}

function added(root: string): ChooseProjectResult {
  return {
    status: 'added',
    project: {
      root,
      name: root.split('/').at(-1) ?? root,
      addedAt: '2026-08-09T12:00:00.000Z',
      skillsTrustedAt: null,
      skillsTrustedDigest: null,
      skillsTrustedManifest: [],
      available: true
    }
  }
}

function service(options: {
  run: (request: ProjectCloneLaunch, signal: AbortSignal) => Promise<void>
  events: ProjectCloneEvent[]
  resolveRoot?: (path: string) => Promise<{ status: 'resolved'; root: string }>
  acceptProject?: (path: string) => Promise<ChooseProjectResult>
}): ProjectCloneService {
  const runtime = createMainEffectRuntime(
    nativeRunLayer(),
    nativeProjectCloneLayer({
      reserveDestination: async (path) => {
        await mkdir(path)
        return { hooksDirectory, release: () => Promise.resolve() }
      },
      execute: (request) =>
        Effect.tryPromise({
          try: (signal) => options.run(request, signal),
          catch: (error) =>
            error instanceof ProjectCloneProcessError
              ? error
              : new ProjectCloneProcessError('clone', String(error), null)
        })
    })
  )
  runtimes.push(runtime)
  return new ProjectCloneService({
    runtime,
    hooksDirectory,
    emit: (event) => options.events.push(event),
    resolveRoot: options.resolveRoot ?? ((root) => Promise.resolve({ status: 'resolved', root })),
    acceptProject: options.acceptProject ?? ((root) => Promise.resolve(added(root)))
  })
}

async function start(
  clone: ProjectCloneService,
  input: Parameters<ProjectCloneService['start']>[0]
): Promise<{ operationId: string }> {
  const started = await clone.start(input)
  await clone.begin(started.operationId)
  return started
}

async function terminal(events: ProjectCloneEvent[]): Promise<ProjectCloneEvent> {
  for (let index = 0; index < 100; index += 1) {
    const event = events.find((entry) => entry.type !== 'progress')
    if (event) return event
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Clone did not finish')
}

describe('ProjectCloneService', () => {
  it('runs Git with discrete arguments and adds only the verified destination', async () => {
    const parent = await directory()
    const destination = join(parent, 'project')
    const events: ProjectCloneEvent[] = []
    const run = vi.fn((request: ProjectCloneLaunch) => {
      expect(request.command).toBe('git')
      expect(request.args).toEqual([
        '-c',
        `core.hooksPath=${hooksDirectory}`,
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.https.allow=always',
        '-c',
        'protocol.ssh.allow=always',
        'clone',
        '--progress',
        '--',
        'https://github.com/example/project.git',
        destination
      ])
      request.onProgress('Receiving objects: 50%')
      return Promise.resolve()
    })
    const acceptProject = vi.fn((root: string) => Promise.resolve(added(root)))
    const clone = service({ run, events, acceptProject })

    await start(clone, {
      source: 'git-url',
      url: 'https://github.com/example/project.git',
      destination
    })

    await expect(terminal(events)).resolves.toMatchObject({ type: 'completed' })
    expect(acceptProject).toHaveBeenCalledWith(destination)
    expect(events).toContainEqual(expect.objectContaining({ type: 'progress', phase: 'receiving' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'progress', phase: 'verifying' }))
  })

  it('uses GitHub CLI authentication for a GitHub repository', async () => {
    const parent = await directory()
    const destination = join(parent, 'private-project')
    const events: ProjectCloneEvent[] = []
    const run = vi.fn((request: ProjectCloneLaunch) => {
      expect(request.command).toBe('gh')
      expect(request.args).toEqual([
        'repo',
        'clone',
        'example/private-project',
        destination,
        '--no-upstream',
        '--',
        '--progress',
        '--config',
        `core.hooksPath=${hooksDirectory}`,
        '--config',
        'protocol.allow=never',
        '--config',
        'protocol.https.allow=always',
        '--config',
        'protocol.ssh.allow=always'
      ])
      return Promise.resolve()
    })
    const clone = service({ run, events })

    await start(clone, { source: 'github', repository: 'example/private-project', destination })

    await expect(terminal(events)).resolves.toMatchObject({ type: 'completed' })
  })

  it('refuses an existing destination before starting a process', async () => {
    const parent = await directory()
    const destination = join(parent, 'occupied')
    await mkdir(destination)
    const events: ProjectCloneEvent[] = []
    const run = vi.fn(() => Promise.resolve())
    const clone = service({ run, events })

    await start(clone, {
      source: 'git-url',
      url: 'https://github.com/example/project.git',
      destination
    })

    await expect(terminal(events)).resolves.toMatchObject({
      type: 'failed',
      reason: 'destination-exists',
      destination
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('retains a partial destination after failure', async () => {
    const parent = await directory()
    const destination = join(parent, 'partial')
    const events: ProjectCloneEvent[] = []
    const clone = service({
      events,
      run: async () => {
        await writeFile(join(destination, 'FETCH_HEAD'), 'partial')
        throw Object.assign(new Error('Could not resolve host: github.com'), {
          stderr: 'Could not resolve host: github.com'
        })
      }
    })

    await start(clone, {
      source: 'git-url',
      url: 'https://github.com/example/project.git',
      destination
    })

    await expect(terminal(events)).resolves.toMatchObject({ type: 'failed', reason: 'network' })
    await expect(writeFile(join(destination, 'still-here'), 'yes')).resolves.toBeUndefined()
  })

  it('reports an inactivity timeout distinctly', async () => {
    const parent = await directory()
    const destination = join(parent, 'timed-out')
    const events: ProjectCloneEvent[] = []
    const clone = service({
      events,
      run: () =>
        Promise.reject(new ProjectCloneProcessError('git', 'Clone timed out.', 'ETIMEDOUT', true))
    })

    await start(clone, {
      source: 'git-url',
      url: 'https://github.com/example/project.git',
      destination
    })

    await expect(terminal(events)).resolves.toMatchObject({ type: 'failed', reason: 'timed-out' })
  })

  it('cancels the process and leaves the destination alone', async () => {
    const parent = await directory()
    const destination = join(parent, 'cancelled')
    const events: ProjectCloneEvent[] = []
    const clone = service({
      events,
      run: (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
    })

    const started = await start(clone, {
      source: 'git-url',
      url: 'https://github.com/example/project.git',
      destination
    })
    await clone.cancel(started.operationId)

    await expect(terminal(events)).resolves.toMatchObject({ type: 'cancelled', destination })
  })

  it('reports a completed clone whose Project record could not be stored', async () => {
    const parent = await directory()
    const destination = join(parent, 'unstored')
    const events: ProjectCloneEvent[] = []
    const clone = service({
      events,
      run: () => Promise.resolve(),
      acceptProject: () => Promise.reject(new Error('state store unavailable'))
    })

    await start(clone, {
      source: 'git-url',
      url: 'https://github.com/example/project.git',
      destination
    })

    await expect(terminal(events)).resolves.toMatchObject({
      type: 'failed',
      reason: 'add-failed',
      destination
    })
  })
})
