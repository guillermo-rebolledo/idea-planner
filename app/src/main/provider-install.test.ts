import { describe, expect, it } from 'vitest'
import { describeProviderUpdate } from './provider-install'

/**
 * Telling someone how to update a provider is only useful if the command
 * matches how they actually installed it. A plausible-but-wrong command is
 * worse than none, because it appears to succeed and changes nothing.
 */

describe('describing how to update a provider', () => {
  it('offers the package manager that owns the resolved path', () => {
    expect(describeProviderUpdate('codex', ['/Users/x/.bun/bin/codex'])).toBe(
      'bun i -g @openai/codex@latest'
    )
    expect(describeProviderUpdate('codex', ['/Users/x/Library/pnpm/codex'])).toBe(
      'pnpm add -g @openai/codex@latest'
    )
    expect(
      describeProviderUpdate('claude', [
        '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'
      ])
    ).toBe('npm install -g @anthropic-ai/claude-code@latest')
  })

  it('reads a Homebrew installation as Homebrew', () => {
    expect(describeProviderUpdate('codex', ['/opt/homebrew/Cellar/codex/0.146.0/bin/codex'])).toBe(
      'brew upgrade codex'
    )
  })

  it('follows the symlink rather than trusting the prefix that hosts it', () => {
    // This is the common case: a global npm install whose command sits in
    // Homebrew's bin. `brew upgrade` there reports success and changes
    // nothing, so the real path has to win.
    expect(
      describeProviderUpdate('codex', [
        '/opt/homebrew/bin/codex',
        '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js'
      ])
    ).toBe('npm install -g @openai/codex@latest')
  })

  it('does not offer a global command for a project-local install', () => {
    expect(describeProviderUpdate('codex', ['/Users/x/dev/app/node_modules/.bin/codex'])).toBeNull()
  })

  it('offers nothing when the installation is not recognizable', () => {
    expect(
      describeProviderUpdate('codex', ['/Users/x/dev/my-fork/target/release/codex'])
    ).toBeNull()
  })

  it('offers nothing when the provider was never resolved', () => {
    expect(describeProviderUpdate('codex', [null])).toBeNull()
  })
})
