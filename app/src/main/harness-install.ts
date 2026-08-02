import type { HarnessId } from '@shared/readiness'

/**
 * How a Harness was installed, read from the path it already resolved to.
 *
 * The app never installs or upgrades anything. It only shows the command the
 * person can run themselves — and a command that does not match their
 * installation is worse than none, because it appears to succeed while
 * changing nothing.
 */

interface HarnessPackage {
  /** The npm package name, used by every JavaScript package manager. */
  npm: string
  /** The Homebrew formula, when the Harness has one. */
  homebrew: string | null
}

const HARNESS_PACKAGES: Record<HarnessId, HarnessPackage> = {
  codex: { npm: '@openai/codex', homebrew: 'codex' },
  claude: { npm: '@anthropic-ai/claude-code', homebrew: null }
}

/**
 * Ordered deliberately: a global npm, pnpm, or Bun install can sit *inside* a
 * Homebrew prefix, because Homebrew supplies the Node that owns it. Matching
 * the prefix first would tell those people to run `brew upgrade`, which
 * reports success and updates nothing.
 */
const INSTALLERS: {
  matches: (path: string) => boolean
  command: (harness: HarnessPackage) => string | null
}[] = [
  {
    matches: (path) => path.includes('/.bun/bin/'),
    command: (pkg) => `bun i -g ${pkg.npm}@latest`
  },
  {
    matches: (path) =>
      ['/.local/share/pnpm/', '/library/pnpm/', '/pnpm/global/'].some((marker) =>
        path.includes(marker)
      ),
    command: (pkg) => `pnpm add -g ${pkg.npm}@latest`
  },
  {
    // Only global layouts. A project-local `node_modules/.bin/` entry is a
    // different binary, and `npm install -g` would not touch it.
    matches: (path) =>
      ['/lib/node_modules/', '/npm/node_modules/'].some((marker) => path.includes(marker)),
    command: (pkg) => `npm install -g ${pkg.npm}@latest`
  },
  {
    matches: (path) =>
      ['/cellar/', '/caskroom/'].some((marker) => path.includes(marker)) ||
      path.startsWith('/opt/homebrew/bin/') ||
      path.startsWith('/usr/local/bin/'),
    command: (pkg) => (pkg.homebrew ? `brew upgrade ${pkg.homebrew}` : null)
  }
]

/**
 * The exact command that updates this Harness, or null when the app cannot
 * tell. Never executed — it is shown for the person to run.
 *
 * Every known path for the Harness is considered, because the command on
 * PATH is usually a symlink: `/opt/homebrew/bin/codex` looks like a Homebrew
 * install and is very often a global npm one. Only the real path tells them
 * apart, and offering `brew upgrade` for an npm install is the exact failure
 * this module exists to avoid.
 */
export function describeHarnessUpdate(
  harness: HarnessId,
  paths: readonly (string | null)[]
): string | null {
  const candidates = paths
    .filter((path): path is string => Boolean(path))
    .map((path) => path.toLowerCase())
  const pkg = HARNESS_PACKAGES[harness]
  for (const installer of INSTALLERS) {
    if (candidates.some((path) => installer.matches(path))) return installer.command(pkg)
  }
  return null
}
