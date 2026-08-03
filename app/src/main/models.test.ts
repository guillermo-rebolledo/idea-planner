import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverModels } from './models'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'models-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A Codex that answers `model/list` the way the installed one does. */
const ANSWERING_CODEX = `#!/usr/bin/env node
const models = [
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    description: 'The default',
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' }
    ],
    defaultReasoningEffort: 'medium'
  },
  {
    id: 'gpt-5.4-mini',
    displayName: 'GPT-5.4-Mini',
    description: 'A smaller one',
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
    defaultReasoningEffort: 'low'
  },
  { id: 'internal-only', displayName: 'Internal', hidden: true, isDefault: false,
    supportedReasoningEfforts: [], defaultReasoningEffort: 'low' }
]
let buffered = ''
process.stdin.on('data', (chunk) => {
  buffered += chunk
  for (;;) {
    const boundary = buffered.indexOf('\\n')
    if (boundary < 0) break
    const line = buffered.slice(0, boundary)
    buffered = buffered.slice(boundary + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n')
    }
    if (message.method === 'model/list') {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { data: models, nextCursor: null } }) + '\\n'
      )
    }
  }
})
`

async function installCodex(script: string): Promise<string> {
  const path = join(root, 'codex')
  await writeFile(path, script, { mode: 0o755 })
  return path
}

describe('what a Harness can be asked for', () => {
  it('asks Codex itself, and takes the efforts each model says it supports', async () => {
    const catalog = await discoverModels([
      {
        harness: 'codex',
        displayName: 'Codex',
        executablePath: await installCodex(ANSWERING_CODEX)
      }
    ])

    expect(catalog.groups).toHaveLength(1)
    const [group] = catalog.groups
    expect(group).toMatchObject({ harness: 'codex', displayName: 'Codex', source: 'probed' })
    expect(group?.models).toMatchObject([
      {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6-Sol',
        efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
        defaultEffort: 'medium'
      },
      // Its own answer: this model supports one level, and offering three
      // would offer what the Harness would refuse.
      { id: 'gpt-5.4-mini', efforts: [{ id: 'low' }], defaultEffort: 'low' }
    ])
  })

  it('leaves out models Codex hides from its own picker', async () => {
    const catalog = await discoverModels([
      {
        harness: 'codex',
        displayName: 'Codex',
        executablePath: await installCodex(ANSWERING_CODEX)
      }
    ])

    expect(catalog.groups[0]?.models.map((model) => model.id)).not.toContain('internal-only')
  })

  it('offers Claude Code what its own help documents, because it enumerates nothing', async () => {
    const catalog = await discoverModels([
      { harness: 'claude', displayName: 'Claude Code', executablePath: join(root, 'claude') }
    ])

    const [group] = catalog.groups
    expect(group).toMatchObject({ harness: 'claude', source: 'documented' })
    expect(group?.models.map((model) => model.id)).toEqual([
      'default',
      'fable',
      'opus',
      'sonnet',
      'haiku'
    ])
    // Claude takes an effort alongside any model, so every one of them offers
    // the same levels.
    expect(group?.models.every((model) => model.efforts.length === 3)).toBe(true)
  })

  it('offers no group for a Harness that cannot answer, rather than an empty one', async () => {
    const catalog = await discoverModels([
      {
        harness: 'codex',
        displayName: 'Codex',
        executablePath: await installCodex('#!/bin/sh\nexit 1\n')
      }
    ])

    expect(catalog.groups).toEqual([])
  })
})
