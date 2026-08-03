import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BUNDLE_ID, PRODUCT_NAME, stateDirectory } from './identity'

/** Only the two fields the identity depends on; the manifest holds far more. */
const manifestSchema = z.object({
  productName: z.string(),
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
})
