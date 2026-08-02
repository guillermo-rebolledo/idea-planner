import { describe, expect, it } from 'vitest'
import { proposeStandingApproval, ruleText } from './approval'

/**
 * A Standing Approval is a rule the Harness consults *before* it asks, so an
 * approved call never reaches this app at all. There is no interception point
 * left at runtime, which is why every question worth asking about breadth has
 * to be answered here, at the moment the rule is written.
 */

const PROJECT = '/Users/someone/dev/receipts'

function ruleFor(command: string): string | null {
  const proposed = proposeStandingApproval('Bash', { command }, PROJECT)
  return proposed ? ruleText(proposed) : null
}

describe('a command approval', () => {
  it('approves the specific command, not its whole family', () => {
    expect(ruleFor('pnpm test')).toBe('Bash(pnpm test:*)')
    expect(ruleFor('pnpm test --watch src/')).toBe('Bash(pnpm test:*)')
    expect(ruleFor('git commit -m "Fix the greeting"')).toBe('Bash(git commit:*)')
  })

  it('reaches past a word that only names another command', () => {
    // `Bash(pnpm run:*)` is every script the Project defines. The word after
    // `run` is the one that says what is actually being run.
    expect(ruleFor('pnpm run build --watch')).toBe('Bash(pnpm run build:*)')
    expect(ruleFor('cargo run --release')).toBe('Bash(cargo run:*)')
  })

  it('offers nothing for a bare program, whose family is everything it can do', () => {
    // A rule is offered only when it can name what the command is *doing*.
    // `Bash(rm:*)` is granted once from `rm -rf ./dist` and permits every
    // future `rm`; `Bash(python3:*)` is the whole machine.
    expect(ruleFor('rm -rf ./dist')).toBeNull()
    expect(ruleFor("python3 -c 'print(99)'")).toBeNull()
    expect(ruleFor('curl https://example.com')).toBeNull()
  })

  it('offers nothing for a command that runs another command', () => {
    // The runner is not stripped before matching, so `Bash(docker exec:*)`
    // permits `docker exec any-container rm -rf /`. Naming the inner command
    // means guessing past flags, containers, and images — and a guess too
    // broad here cannot be taken back at runtime.
    expect(ruleFor('docker exec receipts-db psql -c "select 1"')).toBeNull()
    expect(ruleFor('npx vitest run')).toBeNull()
  })

  it('offers nothing when a leading assignment might not be stripped', () => {
    // Only assignments of variables the Harness considers safe are stripped
    // before an allow rule is matched, and the app does not know that list. A
    // rule that never fires is a grant that goes on asking.
    expect(ruleFor('NODE_ENV=test pnpm test')).toBeNull()
    expect(ruleFor('MY_TOKEN=secret pnpm test')).toBeNull()
  })

  it('refuses a compound command, which no single rule would permit anyway', () => {
    // Every subcommand must match independently, so a rule written from the
    // first one is a rule that silently fails to apply.
    expect(ruleFor('pnpm test && pnpm lint')).toBeNull()
    expect(ruleFor('cat notes.md | grep TODO')).toBeNull()
    expect(ruleFor('pnpm build; pnpm start')).toBeNull()
    expect(ruleFor('echo $(whoami)')).toBeNull()
  })

  it('refuses a wrapper the Harness strips or never prefix-approves', () => {
    // `timeout` is stripped before matching, so a rule naming it would never
    // fire; `find -delete` and `watch` always prompt whatever is stored.
    expect(ruleFor('timeout 30 pnpm test')).toBeNull()
    expect(ruleFor('watch pnpm test')).toBeNull()
    expect(ruleFor('find . -name "*.tmp" -delete')).toBeNull()
  })

  it('refuses anything it cannot read as a plain command', () => {
    expect(ruleFor('./scripts/deploy.sh')).toBeNull()
    expect(ruleFor('  ')).toBeNull()
    expect(proposeStandingApproval('Bash', {}, PROJECT)).toBeNull()
  })
})

describe('repo-wide edit approval', () => {
  it('offers nothing for a file outside the Project it would cover', () => {
    // `Edit(//…/receipts/**)` cannot match `~/.zshrc`, so offering it here
    // would be granting "never ask again" and then being asked again.
    expect(
      proposeStandingApproval('Edit', { file_path: '/Users/someone/.zshrc' }, PROJECT)
    ).toBeNull()
  })

  it('covers the Project and is anchored at the filesystem root', () => {
    // The `/path` anchor would resolve against the staged settings file, which
    // lives outside the repository. Only `//` means what it says.
    const proposed = proposeStandingApproval(
      'Edit',
      { file_path: `${PROJECT}/src/app.ts` },
      PROJECT
    )
    expect(proposed).toEqual({
      // Claude's, because Claude proposes nothing and the app must.
      harness: 'claude',
      kind: 'edit',
      toolName: 'Edit',
      content: '//Users/someone/dev/receipts/**'
    })
    expect(proposed && ruleText(proposed)).toBe('Edit(//Users/someone/dev/receipts/**)')
  })

  it('is the same rule for every file-editing tool, because only Edit is consulted', () => {
    // A path rule written for Write or NotebookEdit is accepted and never
    // read, so all of them become one `Edit(...)` rule.
    for (const tool of ['Write', 'MultiEdit', 'NotebookEdit']) {
      const proposed = proposeStandingApproval(tool, { file_path: `${PROJECT}/a.ts` }, PROJECT)
      expect(proposed && ruleText(proposed)).toBe('Edit(//Users/someone/dev/receipts/**)')
    }
  })
})

describe('everything else', () => {
  it('offers nothing rather than a rule nobody could judge', () => {
    expect(proposeStandingApproval('WebFetch', { url: 'https://example.com' }, PROJECT)).toBeNull()
    expect(proposeStandingApproval('mcp__app__offer_response_options', {}, PROJECT)).toBeNull()
  })
})
