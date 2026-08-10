import { describe, expect, it } from 'vitest'
import { isNewerVersion, updateAvailabilitySchema } from './update'

/**
 * The one decision the whole update notice rests on: is the thing the feed
 * published actually newer than the thing that is running? Everything else —
 * the fetch, the menu row, the browser — is plumbing around this answer.
 */
describe('whether a published version is worth telling somebody about', () => {
  it('reads a newer release', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true)
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(true)
  })

  it('says nothing about the version already running, or an older one', () => {
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false)
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false)
  })

  it('compares numbers as numbers, not as text', () => {
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true)
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(false)
    expect(isNewerVersion('2.0.0', '10.0.0')).toBe(false)
  })

  it('takes the tag the way a release publishes it', () => {
    expect(isNewerVersion('v0.2.0', '0.1.0')).toBe(true)
    expect(isNewerVersion(' v0.2.0 ', '0.1.0')).toBe(true)
    // Build metadata is not part of the comparison, so it cannot invent one.
    expect(isNewerVersion('0.1.0+build.7', '0.1.0')).toBe(false)
  })

  // A prerelease is a smaller thing than the release it precedes. Getting this
  // backwards would offer somebody on 1.0.0 a downgrade to 1.0.0-beta.1.
  it('ranks a prerelease below the release it leads to', () => {
    expect(isNewerVersion('1.0.0-beta.1', '1.0.0')).toBe(false)
    expect(isNewerVersion('1.0.0', '1.0.0-beta.1')).toBe(true)
    expect(isNewerVersion('1.0.0-beta.2', '1.0.0-beta.1')).toBe(true)
    expect(isNewerVersion('1.0.0-beta.1', '1.0.0-beta.2')).toBe(false)
    expect(isNewerVersion('1.0.0-beta.1', '1.0.0-alpha.9')).toBe(true)
    expect(isNewerVersion('1.0.0-beta.1', '1.0.0-beta')).toBe(true)
  })

  // The feed is remote, and this answer turns into a notice with the person's
  // name on it. Something unreadable has to produce silence.
  it('refuses to call anything it cannot read newer', () => {
    expect(isNewerVersion('latest', '0.1.0')).toBe(false)
    expect(isNewerVersion('', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.2.0', 'not-a-version')).toBe(false)
    expect(isNewerVersion('<script>', '0.1.0')).toBe(false)
  })
})

describe('what the app is allowed to say about an update', () => {
  it('accepts knowing of one, and knowing of none', () => {
    expect(
      updateAvailabilitySchema.safeParse({
        installed: '0.1.0',
        available: { version: '0.2.0', url: 'https://github.com/owner/repo/releases/tag/v0.2.0' }
      }).success
    ).toBe(true)
    expect(
      updateAvailabilitySchema.safeParse({ installed: '0.1.0', available: null }).success
    ).toBe(true)
  })

  it('refuses an update with nowhere to take it', () => {
    expect(
      updateAvailabilitySchema.safeParse({
        installed: '0.1.0',
        available: { version: '0.2.0', url: 'not a url' }
      }).success
    ).toBe(false)
  })
})
