import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProviderReadiness, ReadinessCheck, ReadinessDimension } from '@shared/readiness'
import { PROVIDER_SPECS, discoverPathEntries, probeProvider } from './readiness'

/**
 * The probe engine is exercised against scriptable fake executables: real
 * child processes, real PATH resolution, no filesystem scanning. Every state
 * the product must present is produced here deterministically.
 */

let binDir: string
let homeDir: string

beforeEach(async () => {
  binDir = await mkdtemp(join(tmpdir(), 'readiness-bin-'))
  homeDir = await mkdtemp(join(tmpdir(), 'readiness-home-'))
})

afterEach(async () => {
  await rm(binDir, { recursive: true, force: true })
  await rm(homeDir, { recursive: true, force: true })
})

async function fakeExecutable(name: string, script: string): Promise<string> {
  const path = join(binDir, name)
  await writeFile(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return path
}

async function installSkills(root: string, names: string[]): Promise<void> {
  for (const name of names) {
    const dir = join(homeDir, root, name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`)
  }
}

function check(readiness: ProviderReadiness, dimension: ReadinessDimension): ReadinessCheck {
  const found = readiness.checks.find((entry) => entry.dimension === dimension)
  if (!found) throw new Error(`missing ${dimension} check`)
  return found
}

const READY_CODEX_SCRIPT = `case "$1" in
  --version) echo "codex-cli 0.146.0"; exit 0;;
  login) exit 0;;
  debug) exit 0;;
esac
exit 1`

async function probeCodex(overrides?: {
  script?: string
  timeoutMs?: number
}): Promise<ProviderReadiness> {
  await fakeExecutable('codex', overrides?.script ?? READY_CODEX_SCRIPT)
  return probeProvider(PROVIDER_SPECS.codex, {
    pathEntries: [binDir],
    homeDir,
    probeTimeoutMs: overrides?.timeoutMs ?? 5000
  })
}

describe('executable discovery', () => {
  it('reports a missing executable and leaves dependent probes unprobed', async () => {
    const readiness = await probeProvider(PROVIDER_SPECS.codex, {
      pathEntries: [binDir],
      homeDir
    })

    expect(readiness.executablePath).toBeNull()
    expect(check(readiness, 'executable').code).toBe('executable-missing')
    expect(check(readiness, 'compatibility').status).toBe('not-probed')
    expect(check(readiness, 'authentication').status).toBe('not-probed')
    expect(check(readiness, 'sandbox').status).toBe('not-probed')
    // Skill discovery is filesystem-based and stays independent.
    expect(check(readiness, 'skills').code).toBe('skills-missing')
    expect(readiness.available).toBe(false)
  })

  it('resolves only the exact command name against the provided PATH entries', async () => {
    await fakeExecutable('codex-nightly', READY_CODEX_SCRIPT)
    const readiness = await probeProvider(PROVIDER_SPECS.codex, {
      pathEntries: [binDir],
      homeDir
    })
    expect(readiness.executablePath).toBeNull()
  })

  it('rejects an explicitly selected file that is not executable', async () => {
    const selected = join(binDir, 'codex')
    await writeFile(selected, 'not a binary', { mode: 0o644 })
    const readiness = await probeProvider(PROVIDER_SPECS.codex, {
      pathEntries: [],
      explicitExecutable: selected,
      homeDir
    })
    expect(check(readiness, 'executable').code).toBe('selected-executable-invalid')
    expect(readiness.executableSource).toBe('explicit')
  })

  it('still runs the native probes for an explicitly selected executable', async () => {
    const selected = await fakeExecutable('codex-anywhere', READY_CODEX_SCRIPT)
    await installSkills('.agents/skills', ['grill-me', 'grilling', 'wayfinder'])
    const readiness = await probeProvider(PROVIDER_SPECS.codex, {
      pathEntries: [],
      explicitExecutable: selected,
      homeDir
    })
    expect(readiness.executablePath).toBe(selected)
    expect(readiness.executableSource).toBe('explicit')
    expect(check(readiness, 'compatibility').status).toBe('ready')
    expect(readiness.available).toBe(true)
  })
})

describe('compatibility', () => {
  it('accepts a tested version', async () => {
    const readiness = await probeCodex()
    expect(check(readiness, 'compatibility').status).toBe('ready')
    expect(readiness.version).toBe('0.146.0')
  })

  it('fails an incompatible version below the supported minimum', async () => {
    const readiness = await probeCodex({
      script: `[ "$1" = "--version" ] && { echo "codex-cli 0.9.0"; exit 0; }; exit 0`
    })
    const compatibility = check(readiness, 'compatibility')
    expect(compatibility.status).toBe('failed')
    expect(compatibility.code).toBe('version-incompatible')
    expect(readiness.available).toBe(false)
  })

  it('warns about an untested newer version without disabling the provider', async () => {
    await installSkills('.agents/skills', ['grill-me', 'grilling', 'wayfinder'])
    const readiness = await probeCodex({
      script: `case "$1" in
        --version) echo "codex-cli 9.9.9"; exit 0;;
        *) exit 0;;
      esac`
    })
    const compatibility = check(readiness, 'compatibility')
    expect(compatibility.status).toBe('warning')
    expect(compatibility.code).toBe('version-untested')
    expect(readiness.available).toBe(true)
  })

  it('fails unrecognizable version output', async () => {
    const readiness = await probeCodex({
      script: `[ "$1" = "--version" ] && { echo "mystery build"; exit 0; }; exit 0`
    })
    expect(check(readiness, 'compatibility').code).toBe('version-unrecognized')
  })

  it('reports a bounded timeout instead of hanging', async () => {
    const readiness = await probeCodex({
      script: `[ "$1" = "--version" ] && /bin/sleep 30; exit 0`,
      timeoutMs: 400
    })
    const compatibility = check(readiness, 'compatibility')
    expect(compatibility.status).toBe('failed')
    expect(compatibility.code).toBe('probe-timeout')
  }, 15_000)
})

describe('authentication', () => {
  it('reports unauthenticated when the provider says so', async () => {
    const readiness = await probeCodex({
      script: `case "$1" in
        --version) echo "codex-cli 0.146.0"; exit 0;;
        login) echo "Not logged in" >&2; exit 1;;
        *) exit 0;;
      esac`
    })
    const authentication = check(readiness, 'authentication')
    expect(authentication.status).toBe('failed')
    expect(authentication.code).toBe('unauthenticated')
    // Other dimensions stay independently ready.
    expect(check(readiness, 'compatibility').status).toBe('ready')
    expect(check(readiness, 'sandbox').status).toBe('ready')
  })

  it('treats a Claude stream that reaches init as authenticated', async () => {
    await fakeExecutable(
      'claude',
      `case "$1" in
        --version) echo "2.1.220 (Claude Code)"; exit 0;;
        -p) echo '{"type":"system","subtype":"init"}'; /bin/sleep 30;;
      esac`
    )
    const readiness = await probeProvider(PROVIDER_SPECS.claude, {
      pathEntries: [binDir],
      homeDir,
      sandboxExecPath: join(binDir, 'claude'),
      probeTimeoutMs: 5000
    })
    expect(check(readiness, 'authentication').status).toBe('ready')
  }, 15_000)

  it('treats a Claude process that exits before init as unauthenticated', async () => {
    await fakeExecutable(
      'claude',
      `case "$1" in
        --version) echo "2.1.220 (Claude Code)"; exit 0;;
        -p) echo "Please run /login" >&2; exit 1;;
      esac`
    )
    const readiness = await probeProvider(PROVIDER_SPECS.claude, {
      pathEntries: [binDir],
      homeDir,
      sandboxExecPath: join(binDir, 'claude'),
      probeTimeoutMs: 5000
    })
    const authentication = check(readiness, 'authentication')
    expect(authentication.status).toBe('failed')
    expect(authentication.code).toBe('unauthenticated')
  })
})

describe('sandbox', () => {
  it('reports the native sandbox unavailable when the probe fails', async () => {
    const readiness = await probeCodex({
      script: `case "$1" in
        --version) echo "codex-cli 0.146.0"; exit 0;;
        debug) exit 1;;
        *) exit 0;;
      esac`
    })
    const sandbox = check(readiness, 'sandbox')
    expect(sandbox.status).toBe('failed')
    expect(sandbox.code).toBe('sandbox-unavailable')
  })

  it('checks the host sandbox binary for Claude', async () => {
    await fakeExecutable(
      'claude',
      `case "$1" in
        --version) echo "2.1.220 (Claude Code)"; exit 0;;
        -p) echo '{"type":"system","subtype":"init"}'; /bin/sleep 30;;
      esac`
    )
    const readiness = await probeProvider(PROVIDER_SPECS.claude, {
      pathEntries: [binDir],
      homeDir,
      sandboxExecPath: join(homeDir, 'no-such-sandbox-exec'),
      probeTimeoutMs: 5000
    })
    expect(check(readiness, 'sandbox').code).toBe('sandbox-unavailable')
  }, 15_000)
})

describe('skills', () => {
  it('lists exactly the missing skills with only the approved guidance', async () => {
    await installSkills('.agents/skills', ['grill-me'])
    const readiness = await probeCodex()
    const skills = check(readiness, 'skills')
    expect(skills.status).toBe('failed')
    expect(skills.code).toBe('skills-missing')
    expect(skills.missingSkills).toEqual(['grilling', 'wayfinder'])
    expect(skills.command).toBe('npx skills@latest add mattpocock/skills')
    expect(skills.links.map((link) => link.url)).toContain('https://github.com/mattpocock/skills')
  })

  it('is ready when the complete dependency closure is present', async () => {
    await installSkills('.agents/skills', ['grill-me', 'grilling', 'wayfinder'])
    const readiness = await probeCodex()
    expect(check(readiness, 'skills').status).toBe('ready')
  })
})

describe('restored readiness', () => {
  it('reports ready after the person repairs a previously failing setup', async () => {
    const before = await probeProvider(PROVIDER_SPECS.codex, {
      pathEntries: [binDir],
      homeDir
    })
    expect(before.available).toBe(false)

    await fakeExecutable('codex', READY_CODEX_SCRIPT)
    await installSkills('.agents/skills', ['grill-me', 'grilling', 'wayfinder'])

    const after = await probeProvider(PROVIDER_SPECS.codex, {
      pathEntries: [binDir],
      homeDir
    })
    expect(after.available).toBe(true)
    expect(after.checks.every((entry) => entry.status === 'ready')).toBe(true)
  })
})

describe('PATH discovery', () => {
  it('merges login-shell, launchctl, and inherited entries in that order without duplicates', async () => {
    const discovered = await discoverPathEntries({
      inheritedPath: '/usr/bin:/inherited/bin',
      loginShellConsent: true,
      probeLoginShellPath: () => Promise.resolve('/login/bin:/usr/bin'),
      probeLaunchctlPath: () => Promise.resolve('/launchctl/bin:/usr/bin')
    })
    expect(discovered.entries).toEqual([
      '/login/bin',
      '/usr/bin',
      '/launchctl/bin',
      '/inherited/bin'
    ])
    expect(discovered.sources).toEqual(['login-shell', 'launchctl', 'inherited'])
  })

  it('never consults the login shell without consent', async () => {
    let consulted = false
    const discovered = await discoverPathEntries({
      inheritedPath: '/usr/bin',
      loginShellConsent: false,
      probeLoginShellPath: () => {
        consulted = true
        return Promise.resolve('/login/bin')
      },
      probeLaunchctlPath: () => Promise.resolve(null)
    })
    expect(consulted).toBe(false)
    expect(discovered.entries).toEqual(['/usr/bin'])
    expect(discovered.sources).toEqual(['inherited'])
  })
})
