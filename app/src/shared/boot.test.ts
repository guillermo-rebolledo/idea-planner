import { describe, expect, it } from 'vitest'
import { bootStateSchema, CONTRACT_VERSION } from './contract'

/**
 * The handshake between the halves of the app.
 *
 * Main, Preload and the Renderer are built together and speak one contract,
 * but they do not have to be *running* together: `electron-vite dev` reloads
 * the Renderer on save and leaves Main as it was, so a contract changed in a
 * session leaves two halves of different builds talking to each other. What
 * comes back is then a shape the Renderer was never written for, and the way
 * that shows up is a screen that goes black with nothing said.
 *
 * So the boot state carries the version, and disagreeing about it is a thing
 * the Renderer can see before it acts on anything else.
 */
describe('the boot handshake', () => {
  const boot = {
    contractVersion: CONTRACT_VERSION,
    appVersion: '0.1.0',
    theme: { preference: 'system', resolved: 'dark' }
  }

  it('accepts a boot state from this build', () => {
    expect(bootStateSchema.safeParse(boot).success).toBe(true)
  })

  it('refuses one from another build, rather than reading it as this one', () => {
    expect(
      bootStateSchema.safeParse({ ...boot, contractVersion: CONTRACT_VERSION - 1 }).success
    ).toBe(false)
    expect(
      bootStateSchema.safeParse({ ...boot, contractVersion: CONTRACT_VERSION + 1 }).success
    ).toBe(false)
  })
})
