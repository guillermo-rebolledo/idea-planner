import { describe, expect, it } from 'vitest'
import { describeHarnessUpdate } from './harness-install'

/**
 * Telling someone how to update a Harness is only useful if the command
 * matches how they actually installed it. A plausible-but-wrong command is
 * worse than none, because it appears to succeed and changes nothing.
 */

describe('describing how to update a Harness', () => {
  it('offers the package manager that owns the resolved path', () => {
    expect(describeHarnessUpdate('codex', ['/Users/x/.bun/bin/codex'])).toBe(
      'bun i -g @openai/codex@latest'
    )
    expect(describeHarnessUpdate('codex', ['/Users/x/Library/pnpm/codex'])).toBe(
      'pnpm add -g @openai/codex@latest'
    )
    expect(
      describeHarnessUpdate('claude', [
        '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'
      ])
    ).toBe('npm install -g @anthropic-ai/claude-code@latest')
  })

  it('reads a Homebrew installation as Homebrew', () => {
    expect(describeHarnessUpdate('codex', ['/opt/homebrew/Cellar/codex/0.146.0/bin/codex'])).toBe(
      'brew upgrade codex'
    )
  })

  it('follows the symlink rather than trusting the prefix that hosts it', () => {
    // This is the common case: a global npm install whose command sits in
    // Homebrew's bin. `brew upgrade` there reports success and changes
    // nothing, so the real path has to win.
    expect(
      describeHarnessUpdate('codex', [
        '/opt/homebrew/bin/codex',
        '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js'
      ])
    ).toBe('npm install -g @openai/codex@latest')
  })

  it('does not offer a global command for a project-local install', () => {
    expect(describeHarnessUpdate('codex', ['/Users/x/dev/app/node_modules/.bin/codex'])).toBeNull()
  })

  it('offers nothing when the installation is not recognizable', () => {
    expect(describeHarnessUpdate('codex', ['/Users/x/dev/my-fork/target/release/codex'])).toBeNull()
  })

  it('offers nothing when the Harness was never resolved', () => {
    expect(describeHarnessUpdate('codex', [null])).toBeNull()
  })
})
