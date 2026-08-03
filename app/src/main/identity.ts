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
 * Where the app keeps what it owns, keyed by the identifier rather than by the
 * displayed name. Electron would default to the name, which would mean a later
 * rename silently started the person over with an empty history.
 */
export function stateDirectory(appData: string): string {
  return join(appData, BUNDLE_ID)
}
