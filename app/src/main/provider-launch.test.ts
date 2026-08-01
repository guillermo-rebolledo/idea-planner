import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import electron from 'electron'
import { PlanningPolicy } from './planning-policy'
import { mergeProviderLaunches, resolveProviderLaunch } from './provider-launch'

/**
 * Outside an Electron process the `electron` package's export is the path to
 * the bundled binary, which is what this app launches as its planning proxy.
 */
const electronBinary = electron as unknown as string

/**
 * Starting a real provider. The command on PATH is typically a symlink to a
 * script that names an interpreter, and the package ships native helpers — so
 * a profile that allows only the literal command name denies the launch.
 */

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

/** A provider laid out the way a Node-based CLI actually installs. */
async function installFakeProvider(): Promise<{ root: string; command: string }> {
  const root = await mkdtemp(join(tmpdir(), 'provider-launch-'))
  temporaryDirectories.push(root)
  const packageDir = join(root, 'lib', 'node_modules', 'demo-cli')
  await mkdir(join(packageDir, 'bin'), { recursive: true })
  await mkdir(join(root, 'bin'), { recursive: true })
  await writeFile(join(packageDir, 'package.json'), '{"name":"demo-cli"}')
  const script = join(packageDir, 'bin', 'demo.js')
  await writeFile(script, '#!/usr/bin/env node\nprocess.stdout.write("ok")\n')
  await chmod(script, 0o755)
  const command = join(root, 'bin', 'demo')
  await symlink(script, command)
  return { root, command }
}

describe('resolving a provider launch', () => {
  it('follows the command symlink and includes the interpreter it names', async () => {
    const { command } = await installFakeProvider()
    const launch = await resolveProviderLaunch(command)
    expect(launch.executables[0]).toMatch(/demo\.js$/)
    expect(launch.executables).toContain('/usr/bin/env')
    expect(launch.executables.some((path) => path.endsWith('node'))).toBe(true)
  })

  it('includes the provider’s own package tree, which may ship native helpers', async () => {
    const { command } = await installFakeProvider()
    const launch = await resolveProviderLaunch(command)
    expect(launch.executableTrees.some((tree) => tree.endsWith('demo-cli'))).toBe(true)
  })

  it('reads a versioned package-manager layout as its whole prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-cellar-'))
    temporaryDirectories.push(root)
    const binary = join(root, 'Cellar', 'demo', '1.2.3', 'bin', 'demo')
    await mkdir(join(binary, '..'), { recursive: true })
    await writeFile(binary, '')
    const launch = await resolveProviderLaunch(binary)
    // Its libraries and configuration live beside Cellar, not inside it.
    expect(launch.readRoots).toContain(await realish(root))
  })

  it('reads a macOS bundle as the bundle, where its frameworks live', async () => {
    const launch = await resolveProviderLaunch(electronBinary)
    expect(launch.readRoots.some((root) => root.endsWith('.app'))).toBe(true)
  })

  it('never offers the filesystem root as a readable tree', async () => {
    const launch = await resolveProviderLaunch('/usr/bin/true')
    expect(launch.readRoots).not.toContain('/')
  })
})

describe.skipIf(process.platform !== 'darwin')('the generated profile', () => {
  it('starts a symlinked provider that runs through an interpreter', async () => {
    const { root, command } = await installFakeProvider()
    const runDirectory = join(root, 'run')
    const planningDirectory = join(root, 'work', '.scratch')
    await mkdir(runDirectory, { recursive: true })
    await mkdir(planningDirectory, { recursive: true })
    const profile = join(runDirectory, 'planning.sb')
    await writeFile(
      profile,
      new PlanningPolicy({
        workingDirectory: join(root, 'work'),
        planningDirectory
      }).renderSandboxProfile({
        runDirectory,
        launch: await resolveProviderLaunch(command),
        proxyScript: join(root, 'proxy.js'),
        socketPath: join(runDirectory, 'planning.sock')
      })
    )
    await expect(
      promisify(execFile)('/usr/bin/sandbox-exec', ['-f', profile, command])
    ).resolves.toMatchObject({ stdout: 'ok' })
  })

  it('starts the planning proxy, which is this app’s own bundled runtime', async () => {
    // The proxy is the Electron binary run as Node. Admitting only its
    // executable leaves it unable to load its own framework, which macOS
    // reports to the person as an unexplained "cannot be opened" alert.
    const { root, command } = await installFakeProvider()
    const runDirectory = join(root, 'run')
    await mkdir(join(root, 'work', '.scratch'), { recursive: true })
    await mkdir(runDirectory, { recursive: true })
    const script = join(root, 'proxy.js')
    await writeFile(script, 'process.stdout.write("proxy-ok")\n')
    const profile = join(runDirectory, 'planning.sb')
    await writeFile(
      profile,
      new PlanningPolicy({
        workingDirectory: join(root, 'work'),
        planningDirectory: join(root, 'work', '.scratch')
      }).renderSandboxProfile({
        runDirectory,
        launch: mergeProviderLaunches(
          await resolveProviderLaunch(command),
          await resolveProviderLaunch(electronBinary)
        ),
        proxyScript: script,
        socketPath: join(runDirectory, 'planning.sock')
      })
    )
    await expect(
      promisify(execFile)('/usr/bin/sandbox-exec', ['-f', profile, electronBinary, script], {
        env: { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin:/bin', HOME: process.env['HOME'] ?? '' }
      })
    ).resolves.toMatchObject({ stdout: 'proxy-ok' })
  })

  it('still refuses to write inside the Working Directory', async () => {
    const { root, command } = await installFakeProvider()
    const workingDirectory = join(root, 'work')
    const runDirectory = join(root, 'run')
    await mkdir(join(workingDirectory, '.scratch'), { recursive: true })
    await mkdir(runDirectory, { recursive: true })
    const profile = join(runDirectory, 'planning.sb')
    await writeFile(
      profile,
      new PlanningPolicy({
        workingDirectory,
        planningDirectory: join(workingDirectory, '.scratch')
      }).renderSandboxProfile({
        runDirectory,
        launch: {
          ...(await resolveProviderLaunch(command)),
          executables: [...(await resolveProviderLaunch(command)).executables, '/usr/bin/touch']
        },
        proxyScript: join(root, 'proxy.js'),
        socketPath: join(runDirectory, 'planning.sock')
      })
    )
    await expect(
      promisify(execFile)('/usr/bin/sandbox-exec', [
        '-f',
        profile,
        '/usr/bin/touch',
        join(workingDirectory, 'source.ts')
      ])
    ).rejects.toBeDefined()
  })
})

async function realish(path: string): Promise<string> {
  const { realpath } = await import('node:fs/promises')
  return await realpath(path).catch(() => path)
}
