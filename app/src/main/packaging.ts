import { sep } from 'node:path'

/**
 * What packaging does to the paths the app addresses at run time.
 *
 * A packaged build lives inside `app.asar`, an archive Electron teaches its own
 * `fs` to read through. Main never notices: every file it loads is opened by
 * that patched `fs`, so a path into the archive is a path.
 */

/**
 * Where a *child process* finds a file the app ships.
 *
 * The MCP proxy is not loaded by Main; it is handed to a child as
 * `NODE_OPTIONS=--require=…`, which Node reads before any archive support
 * exists to read it with. Files reached that way are listed under `asarUnpack`
 * in the build configuration, which leaves a real copy beside the archive, and
 * this addresses that copy. Unpackaged there is no archive in the path and
 * nothing changes.
 */
export function unpackedPath(path: string): string {
  return path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
}
