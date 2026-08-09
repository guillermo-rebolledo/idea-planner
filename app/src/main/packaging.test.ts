import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { unpackedPath } from './packaging'

const manifestPath = join(__dirname, '../../package.json')

/** Only the packaging decisions that have to hold; the manifest holds far more. */
const buildSchema = z.object({
  appId: z.string(),
  files: z.array(z.string()),
  asarUnpack: z.array(z.string()),
  mac: z.object({
    target: z.array(z.object({ target: z.string(), arch: z.array(z.string()) })),
    hardenedRuntime: z.boolean(),
    entitlements: z.string(),
    entitlementsInherit: z.string(),
    // Present only to be asserted absent: signing identity and notarization
    // credentials are read from the environment, never from here.
    identity: z.string().optional(),
    notarize: z.unknown().optional()
  })
})

const manifestSchema = z.object({
  scripts: z.record(z.string(), z.string()),
  build: buildSchema
})

async function manifest(): Promise<z.infer<typeof manifestSchema>> {
  return manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
}

describe('what packaging does to a path', () => {
  it('sends a child process to the copy beside the archive', () => {
    expect(
      unpackedPath('/Applications/Argos.app/Contents/Resources/app.asar/out/main/proxy.js')
    ).toBe('/Applications/Argos.app/Contents/Resources/app.asar.unpacked/out/main/proxy.js')
  })

  it('leaves an unpackaged path alone', () => {
    expect(unpackedPath('/repo/app/out/main/mcp-proxy.js')).toBe('/repo/app/out/main/mcp-proxy.js')
  })
})

describe('how a build is packaged', () => {
  // One command, and what it produces is what people are asked to open: a disk
  // image to install from, and an archive of the same bundle for a later
  // update feed to serve.
  it('is produced by one command, for both Macs', async () => {
    const { scripts, build } = await manifest()

    expect(scripts['package']).toBe('electron-vite build && electron-builder --mac')
    expect(build.mac.target).toEqual([
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] }
    ])
  })

  // Notarization will not accept a build that is not hardened, and the
  // exceptions a hardened Electron needs are a security decision — they belong
  // in a file in the repository that can be read and reviewed, not in a
  // packager default nobody has seen.
  it('hardens the runtime with entitlements that live in the repository', async () => {
    const { build } = await manifest()

    expect(build.mac.hardenedRuntime).toBe(true)
    expect(build.mac.entitlements).toBe('build/entitlements.mac.plist')
    expect(build.mac.entitlementsInherit).toBe(build.mac.entitlements)

    const entitlements = await readFile(join(__dirname, '../..', build.mac.entitlements), 'utf8')
    expect(entitlements).toContain('com.apple.security.cs.allow-jit')
    // A Developer ID build is not sandboxed by Apple's mechanism; claiming the
    // entitlement without the App Store's provisioning would refuse to launch.
    expect(entitlements).not.toContain('com.apple.security.app-sandbox')
  })

  // A certificate and an Apple ID are credentials. They come from the
  // environment of whoever is building — a machine, or CI — and there is
  // nowhere in the repository for them to be named, which is what stops one
  // from being committed by accident.
  it('takes signing and notarization credentials from the environment', async () => {
    const { build } = await manifest()

    expect(build.mac.identity).toBeUndefined()
    expect(build.mac.notarize).toBeUndefined()

    const ignored = await readFile(join(__dirname, '../../.gitignore'), 'utf8')
    expect(ignored).toContain('.env*')
  })

  // The proxy is opened by a child process before Electron's archive support
  // exists, so packaging has to leave a real file for it.
  it('unpacks the file a child process opens by path', async () => {
    const { build } = await manifest()

    expect(build.asarUnpack).toContain('out/main/mcp-proxy.js')
    expect(build.files).toContain('out/**')
  })
})
