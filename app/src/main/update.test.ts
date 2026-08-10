import { describe, expect, it, vi } from 'vitest'
import type { UpdateAvailability } from '@shared/update'
import { releaseFeedUrl, releasePagePrefix, RELEASE_REPOSITORY } from './identity'
import { UpdateService } from './update'

const FEED = 'https://api.github.com/repos/owner/repo/releases/latest'
const PREFIX = 'https://github.com/owner/repo/releases/'
const RELEASE = `${PREFIX}tag/v0.2.0`

function feedAnswering(body: unknown, init: { ok?: boolean } = {}): typeof globalThis.fetch {
  return vi.fn(async () =>
    Promise.resolve({
      ok: init.ok ?? true,
      json: async () => Promise.resolve(body)
    })
  ) as unknown as typeof globalThis.fetch
}

function service(
  fetchImpl: typeof globalThis.fetch,
  onAvailable?: (availability: UpdateAvailability) => void
): UpdateService {
  return new UpdateService({
    installedVersion: '0.1.0',
    feedUrl: FEED,
    releasePagePrefix: PREFIX,
    fetchImpl,
    onAvailable
  })
}

describe('learning that a newer Argos exists', () => {
  it('knows of nothing before it has looked', () => {
    expect(service(feedAnswering({})).latest()).toEqual({ installed: '0.1.0', available: null })
  })

  it('reports the published release, and where to take it', async () => {
    const updates = service(feedAnswering({ tag_name: 'v0.2.0', html_url: RELEASE }))

    expect(await updates.check()).toEqual({
      installed: '0.1.0',
      available: { version: '0.2.0', url: RELEASE }
    })
    expect(updates.releaseUrl()).toBe(RELEASE)
  })

  it('says nothing when the published release is the one already running', async () => {
    const updates = service(feedAnswering({ tag_name: 'v0.1.0', html_url: `${PREFIX}tag/v0.1.0` }))

    expect((await updates.check()).available).toBeNull()
    expect(updates.releaseUrl()).toBeNull()
  })

  // The notice is worth having only if it arrives once. A person who has been
  // told is not told again by the next day's check.
  it('announces a version once, not on every check', async () => {
    const announced = vi.fn()
    const updates = service(feedAnswering({ tag_name: 'v0.2.0', html_url: RELEASE }), announced)

    await updates.check()
    await updates.check()

    expect(announced).toHaveBeenCalledTimes(1)
    expect(announced).toHaveBeenCalledWith({
      installed: '0.1.0',
      available: { version: '0.2.0', url: RELEASE }
    })
  })

  it('asks the feed once while a check is still in flight', async () => {
    const fetchImpl = feedAnswering({ tag_name: 'v0.2.0', html_url: RELEASE })
    const updates = service(fetchImpl)

    await Promise.all([updates.check(), updates.check()])

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

/**
 * Nobody should be told their network is down by an app they opened to write
 * code. Every one of these is a check that did not land, and every one of them
 * has to look exactly like a check that found nothing.
 */
describe('a check that fails', () => {
  it('is silent when the network is unreachable', async () => {
    const updates = service(vi.fn(async () => Promise.reject(new Error('ENOTFOUND'))))

    await expect(updates.check()).resolves.toEqual({ installed: '0.1.0', available: null })
  })

  it('is silent when the feed refuses', async () => {
    const updates = service(feedAnswering({ message: 'rate limit exceeded' }, { ok: false }))

    expect((await updates.check()).available).toBeNull()
  })

  it('is silent when the feed answers with something else entirely', async () => {
    expect((await service(feedAnswering({ nope: true })).check()).available).toBeNull()
    expect((await service(feedAnswering('<html>502</html>')).check()).available).toBeNull()
    expect(
      (await service(feedAnswering({ tag_name: 'nightly', html_url: RELEASE })).check()).available
    ).toBeNull()
  })

  // A version arriving with an address nobody in this repository chose is not
  // an update; it is a link, pointed wherever whoever sent it liked.
  it('refuses a release published somewhere this app is not', async () => {
    const updates = service(
      feedAnswering({ tag_name: 'v0.2.0', html_url: 'https://example.com/free-argos' })
    )

    expect((await updates.check()).available).toBeNull()
  })

  // A failed check is not evidence that the update it already found is gone.
  it('keeps what it already knew', async () => {
    const updates = new UpdateService({
      installedVersion: '0.1.0',
      feedUrl: FEED,
      releasePagePrefix: PREFIX,
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ tag_name: 'v0.2.0', html_url: RELEASE })
        })
        .mockRejectedValueOnce(new Error('offline'))
    })

    await updates.check()
    await updates.check()

    expect(updates.releaseUrl()).toBe(RELEASE)
  })
})

/**
 * The update configuration states the repository once and derives the rest,
 * the same way packaging takes the bundle identifier from the identity rather
 * than repeating it (ADR 0008).
 */
describe('where an update is looked for', () => {
  it('derives the feed and the release page from one repository', () => {
    expect(releaseFeedUrl()).toBe(
      `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`
    )
    expect(releasePagePrefix()).toBe(`https://github.com/${RELEASE_REPOSITORY}/releases/`)
  })
})
