import { join } from 'node:path'

/**
 * Who the app is, to a person and to the operating system.
 *
 * The name is a display string and can change. The identifier cannot: it keys
 * the application-support directory that holds every Session, Conversation and
 * Run (ADR 0002), and it is what a build is signed and notarized under.
 * Changing it after a build ships orphans a person's whole history.
 */

/** Fixed. See `.scratch/coding-agent-chat/issues/14-rename-product-to-argos.md`. */
export const BUNDLE_ID = 'com.memojiinc.argos'

/** Argos, Odysseus's hound — the one who recognised him. Not Argus. */
export const PRODUCT_NAME = 'Argos'

/**
 * Where Argos is released from, stated once.
 *
 * The update feed and the page a person is sent to take an update are both
 * derived from this, and `package.json` is tested to name the same repository,
 * so there is one fact here rather than three that can drift. The version being
 * compared against it is never restated either: it comes from the bundle, which
 * the packager wrote from the manifest.
 */
export const RELEASE_REPOSITORY = 'guillermo-rebolledo/idea-planner'

/** The newest published release, excluding drafts and prereleases. */
export function releaseFeedUrl(): string {
  return `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`
}

/**
 * The only place an update link may point. A feed is remote, and this is what
 * stops a URL that came over the network from being handed to the browser
 * because it merely arrived in the right field.
 */
export function releasePagePrefix(): string {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/`
}

/**
 * Where the app keeps what it owns, keyed by the identifier rather than by the
 * displayed name. Electron would default to the name, which would mean a later
 * rename silently started the person over with an empty history.
 */
export function stateDirectory(appData: string): string {
  return join(appData, BUNDLE_ID)
}
