import { describe, expect, it } from 'vitest'
import { displayCommand } from './command'

describe('displayCommand', () => {
  it('drops the login shell Codex runs everything through', () => {
    expect(displayCommand("/bin/zsh -lc 'git log --oneline -15'")).toBe('git log --oneline -15')
    expect(displayCommand("bash -lc 'pnpm verify'")).toBe('pnpm verify')
    expect(displayCommand('/usr/local/bin/fish -c "ls -la"')).toBe('ls -la')
    expect(displayCommand("sh -c 'echo hi'")).toBe('echo hi')
  })

  it('leaves a command that was not wrapped exactly as it was recorded', () => {
    expect(displayCommand('git log --oneline -15')).toBe('git log --oneline -15')
    expect(displayCommand('pnpm test -- --watch')).toBe('pnpm test -- --watch')
  })

  it('restores the quotes a shell-escaped script had to hide', () => {
    // `echo 'hi'` as zsh receives it, which is the awkward `'\''` dance.
    expect(displayCommand("/bin/zsh -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'")
    expect(displayCommand('bash -lc "echo \\"hi\\""')).toBe('echo "hi"')
  })

  /*
   * The failure worth caring about: shortening a command into something that
   * would do a different thing. Anything ambiguous keeps the wrapper.
   */
  it('keeps the wrapper when the quotes do not enclose one whole script', () => {
    expect(displayCommand("zsh -lc 'first' 'second'")).toBe("zsh -lc 'first' 'second'")
    expect(displayCommand('bash -lc "one" "two"')).toBe('bash -lc "one" "two"')
    expect(displayCommand('zsh -lc git status')).toBe('zsh -lc git status')
    expect(displayCommand("zsh -lc ''")).toBe("zsh -lc ''")
  })

  it('is not fooled by a command that merely mentions a shell', () => {
    expect(displayCommand("npm run sh -c 'build'")).toBe("npm run sh -c 'build'")
    expect(displayCommand("echo 'zsh -lc \\'x\\''")).toBe("echo 'zsh -lc \\'x\\''")
  })
})
