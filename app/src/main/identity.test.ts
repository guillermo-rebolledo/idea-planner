import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  BUNDLE_ID,
  PRODUCT_NAME,
  RELEASE_REPOSITORY,
  releaseFeedUrl,
  releasePagePrefix,
  stateDirectory
} from './identity'

/** Only the fields the identity depends on; the manifest holds far more. */
const manifestSchema = z.object({
  productName: z.string(),
  repository: z.object({ type: z.literal('git'), url: z.string() }),
  build: z.object({ appId: z.string() })
})

describe('who the app is', () => {
  it('keeps its state under the identifier, not under the name it displays', () => {
    expect(stateDirectory('/Users/someone/Library/Application Support')).toBe(
      '/Users/someone/Library/Application Support/com.memojiinc.argos'
    )
  })

  // The identifier is the one string here that cannot change after a build
  // ships: it keys the application-support directory every Session,
  // Conversation and Run lives in (ADR 0002), and it is what code signing and
  // notarization are issued against. Packaging reads the manifest, the app
  // reads this module, and they cannot be allowed to drift apart.
  it('is the identity a build is packaged, signed and notarized under', async () => {
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(join(__dirname, '../../package.json'), 'utf8'))
    )

    expect(manifest.build.appId).toBe(BUNDLE_ID)
    expect(manifest.productName).toBe(PRODUCT_NAME)
    // Argos, the hound. Not Argus.
    expect(PRODUCT_NAME).toBe('Argos')
  })

  // Where releases come from is identity too: it is the one thing an update
  // check trusts to tell a person their copy is old, and the one address they
  // are sent to install from. Stated once here, named once in the manifest,
  // and everything an update does is derived from it (MEM-131).
  it('is released from one repository, which the update check inherits', async () => {
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(join(__dirname, '../../package.json'), 'utf8'))
    )

    expect(manifest.repository.url).toBe(`git+https://github.com/${RELEASE_REPOSITORY}.git`)
    expect(releaseFeedUrl()).toContain(RELEASE_REPOSITORY)
    expect(releasePagePrefix()).toContain(RELEASE_REPOSITORY)
    // Both are https, and the page is under github.com itself — not the API —
    // because a person opening it is meant to arrive at something readable.
    expect(new URL(releaseFeedUrl()).protocol).toBe('https:')
    expect(new URL(releasePagePrefix()).host).toBe('github.com')
  })
})
