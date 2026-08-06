import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const REDIRECTING = new Set([
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE'
])

/** Test Git never follows repository pointers staged by a concurrent test. */
export function testGit(command: string, args: string[], options: { cwd?: string } = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !REDIRECTING.has(name))
  )
  return execute(command, args, { ...options, env })
}

/** A real repository whose two branches change the same file differently. */
export async function conflictingRepository(
  root: string,
  filename = 'conflict.txt'
): Promise<void> {
  await testGit('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root })
  await writeFile(join(root, filename), 'base\n')
  await commitAll(root, 'base')
  await testGit('git', ['checkout', '--quiet', '-b', 'side'], { cwd: root })
  await writeFile(join(root, filename), 'side\n')
  await commitAll(root, 'side')
  await testGit('git', ['checkout', '--quiet', 'main'], { cwd: root })
  await writeFile(join(root, filename), 'main\n')
  await commitAll(root, 'main')
}

async function commitAll(root: string, message: string): Promise<void> {
  await testGit('git', ['add', '-A'], { cwd: root })
  await testGit(
    'git',
    ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '--quiet', '-m', message],
    { cwd: root }
  )
}
