import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { harnessEventSchema, type HarnessEvent } from '@shared/conversation'
import { createClaudeAdapter } from './claude'

async function replay(fixture: string, chunkSize = 64): Promise<HarnessEvent[]> {
  const raw = await readFile(join(__dirname, 'fixtures', fixture), 'utf8')
  const adapter = createClaudeAdapter()
  const events: HarnessEvent[] = []
  for (let index = 0; index < raw.length; index += chunkSize) {
    events.push(...adapter.ingest(raw.slice(index, index + chunkSize)))
  }
  events.push(...adapter.flush())
  return events
}

describe('Claude harness Adapter', () => {
  it('normalizes a Wayfinder turn identically regardless of chunk boundaries', async () => {
    expect(await replay('claude-wayfinder.jsonl', 1)).toEqual(
      await replay('claude-wayfinder.jsonl', 1_000_000)
    )
  })

  it('streams one message, reports the Harness Thread and keeps transport completion separate', async () => {
    const events = await replay('claude-wayfinder.jsonl')
    expect(events).toContainEqual({
      type: 'thread-ready',
      harness: 'claude',
      threadId: 'session-claude-1',
      model: 'claude-sonnet-4-5',
      permissionMode: 'dontAsk'
    })
    expect(events.filter((event) => event.type === 'assistant-message')).toEqual([
      {
        type: 'assistant-message',
        id: 'msg_1',
        text: 'Which decision ',
        complete: false
      },
      {
        type: 'assistant-message',
        id: 'msg_1',
        text: 'Which decision should we resolve first?',
        complete: false
      },
      {
        type: 'assistant-message',
        id: 'msg_1',
        text: 'Which decision should we resolve first?',
        complete: true
      }
    ])
    expect(events).toContainEqual({ type: 'completed' })
  })

  it('normalizes retry, tool, and final Harness usage without exposing arguments', async () => {
    const events = await replay('claude-wayfinder.jsonl')
    expect(events).toContainEqual({
      type: 'retrying',
      attempt: 1,
      delayMs: 250,
      category: 'rate-limit'
    })
    expect(events).toContainEqual({
      type: 'tool',
      name: 'app.offer_response_options',
      summary: 'Called app tool offer_response_options'
    })
    expect(events).toContainEqual({
      type: 'usage',
      usage: {
        inputTokens: 120,
        outputTokens: 11,
        totalTokens: 131,
        contextWindow: null,
        contextUsed: null
      }
    })
  })

  it('accepts Claude status and rate-limit telemetry without treating it as protocol drift', async () => {
    const events = await replay('claude-wayfinder.jsonl')
    expect(
      events.some(
        (event) =>
          event.type === 'failed' && event.summary.includes('Unsupported Claude protocol event')
      )
    ).toBe(false)
  })

  it('accepts validated thinking-token telemetry without exposing hidden reasoning', () => {
    const adapter = createClaudeAdapter()
    expect(
      adapter.ingest(
        '{"type":"system","subtype":"thinking_tokens","estimated_tokens":103,"estimated_tokens_delta":53}\n'
      )
    ).toEqual([])
    expect(
      adapter.ingest('{"type":"system","subtype":"thinking_tokens","estimated_tokens":"unknown"}\n')
    ).toEqual([
      {
        type: 'failed',
        category: 'protocol',
        summary: 'Invalid Claude thinking_tokens event'
      }
    ])
  })

  it('fails visibly on unknown correctness-critical system and result events', async () => {
    const events = await replay('claude-failures.jsonl')
    expect(events).toContainEqual({
      type: 'failed',
      category: 'protocol',
      summary: 'Unsupported Claude system event: future_correctness_event'
    })
    expect(events).toContainEqual({
      type: 'failed',
      category: 'protocol',
      summary: 'Unsupported Claude result event: future_result'
    })
  })

  it('runtime-validates hook protocol events', () => {
    const adapter = createClaudeAdapter()
    expect(
      adapter.ingest('{"type":"system","subtype":"hook_started","hook_id":"hook-1"}\n')
    ).toEqual([
      {
        type: 'failed',
        category: 'protocol',
        summary: 'Invalid Claude hook_started event'
      }
    ])
  })

  it('categorizes Harness failures and redacts credentials', async () => {
    const events = await replay('claude-failures.jsonl')
    expect(events.filter((event) => event.type === 'failed').slice(0, 2)).toEqual([
      {
        type: 'failed',
        category: 'authentication',
        summary: 'Authentication failed: token=[REDACTED: credential]'
      },
      {
        type: 'failed',
        category: 'context-exhausted',
        summary: 'Maximum context window exceeded'
      }
    ])
  })

  it('emits only runtime-valid shared events', async () => {
    for (const event of [
      ...(await replay('claude-wayfinder.jsonl')),
      ...(await replay('claude-failures.jsonl'))
    ]) {
      expect(() => harnessEventSchema.parse(event)).not.toThrow()
    }
  })
})

describe('file changes', () => {
  it('reports an edit as a change with the hunks the Harness computed', async () => {
    // Recorded from claude 2.1.220 against a throwaway repository. The payload
    // that carries the diff is undocumented, so this fixture is the contract:
    // if the Harness stops sending it in this shape, this test says so rather
    // than the diffs quietly disappearing from the Conversation.
    const events = await replay('claude-edit.jsonl')

    expect(events.filter((event) => event.type === 'file-change')).toEqual([
      {
        type: 'file-change',
        path: '/tmp/a-project/greeting.ts',
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              '-export const greeting = "hello world"',
              '+export const greeting = "goodbye world"'
            ]
          }
        ]
      }
    ])
  })

  it('normalizes a file change identically regardless of chunk boundaries', async () => {
    expect(await replay('claude-edit.jsonl', 1)).toEqual(
      await replay('claude-edit.jsonl', 1_000_000)
    )
  })

  it('emits only events the shared contract accepts', async () => {
    for (const event of await replay('claude-edit.jsonl')) {
      expect(harnessEventSchema.safeParse(event).success).toBe(true)
    }
  })
})

describe('commands', () => {
  it('reports the command the Harness ran and what it printed', async () => {
    // Recorded from claude 2.1.220. Reporting only that a tool was called
    // leaves a Run that compiles or tests saying nothing about the result.
    const events = await replay('claude-command.jsonl')

    expect(events.filter((event) => event.type === 'command')).toEqual([
      {
        type: 'command',
        id: 'toolu_015hHJHQrm7DjbErN5tdKwW6',
        command: 'wc -l lines.txt',
        output: '       3 lines.txt',
        failed: false,
        running: false,
        // Claude reports only whether it errored; measuring the duration is
        // the Conversation's job, from the start it saw to this result.
        exitCode: null,
        durationMs: null
      }
    ])
  })

  it('names the file a Read tool call is reading', () => {
    const adapter = createClaudeAdapter()
    const frame = {
      type: 'assistant',
      message: {
        id: 'msg_read',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_read',
            name: 'Read',
            input: { file_path: '/a-project/hooks/useLocation.ts' }
          }
        ]
      },
      session_id: 'thread-fixture'
    }
    expect(adapter.ingest(`${JSON.stringify(frame)}\n`)).toEqual([
      {
        type: 'tool',
        name: 'Read',
        summary: 'Called Claude tool Read',
        path: '/a-project/hooks/useLocation.ts'
      }
    ])
  })

  it('does not report a command as a bare tool call as well', async () => {
    const events = await replay('claude-command.jsonl')
    expect(events.filter((event) => event.type === 'tool')).toEqual([])
  })

  it('normalizes a command identically regardless of chunk boundaries', async () => {
    expect(await replay('claude-command.jsonl', 1)).toEqual(
      await replay('claude-command.jsonl', 1_000_000)
    )
  })

  it('emits only events the shared contract accepts', async () => {
    for (const event of await replay('claude-command.jsonl')) {
      expect(harnessEventSchema.safeParse(event).success).toBe(true)
    }
  })
})

describe('the mode a Run is actually running under', () => {
  it('reports the effective permission mode from the init event', async () => {
    // Managed settings outrank command-line arguments, so what the app asked
    // for is not necessarily what is running. The Harness says which.
    const events = await replay('claude-command.jsonl')
    expect(events).toContainEqual({
      type: 'thread-ready',
      harness: 'claude',
      threadId: 'thread-fixture',
      model: 'claude-opus-5[1m]',
      permissionMode: 'bypassPermissions'
    })
  })
})

/**
 * Frames only: the recorded probe interleaves the protocol with notes about
 * when each correction was written and what the Checkout held afterwards.
 */
async function probeFrames(): Promise<string[]> {
  const raw = await readFile(join(__dirname, 'fixtures', 'claude-steer-probe.jsonl'), 'utf8')
  return raw.split('\n').filter((line) => line.startsWith('{'))
}

describe('steering a Claude Run', () => {
  it('sends what the Run is for as its first frame, and hands it over exactly once', () => {
    const adapter = createClaudeAdapter({ prompt: '/wayfinder Rename it' })
    expect(adapter.takeOutgoing().map((frame) => JSON.parse(frame) as unknown)).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '/wayfinder Rename it' }] },
        parent_tool_use_id: null
      }
    ])
    expect(adapter.takeOutgoing()).toEqual([])
  })

  it('writes a correction into the running turn and claims nothing until Claude reads it back', () => {
    const adapter = createClaudeAdapter({ prompt: 'Rename it' })
    adapter.takeOutgoing()
    expect(adapter.steer('Keep the API compatible', 'correction-1')).toBe(true)
    expect(adapter.takeOutgoing().map((frame) => JSON.parse(frame) as unknown)).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Keep the API compatible' }] },
        parent_tool_use_id: null
      }
    ])
    // Claude answers no request ids. Its echo is the acknowledgement, and
    // until it comes back nothing has been accepted.
    expect(
      adapter.ingest(
        `${JSON.stringify({
          type: 'user',
          isReplay: true,
          message: { role: 'user', content: [{ type: 'text', text: 'Keep the API compatible' }] },
          parent_tool_use_id: null
        })}\n`
      )
    ).toEqual([{ type: 'steer-accepted', submissionId: 'correction-1' }])
  })

  it('reads an echo of anything else as nothing at all', () => {
    const adapter = createClaudeAdapter({ prompt: 'Rename it' })
    adapter.takeOutgoing()
    // The Run's own prompt comes back too. It is already in the Conversation,
    // and reading it again would say the person spoke twice.
    expect(
      adapter.ingest(
        `${JSON.stringify({
          type: 'user',
          isReplay: true,
          message: { role: 'user', content: [{ type: 'text', text: 'Rename it' }] },
          parent_tool_use_id: null
        })}\n`
      )
    ).toEqual([])
  })

  it('refuses a correction once the turn it would have joined is over', () => {
    const adapter = createClaudeAdapter({ prompt: 'Rename it' })
    adapter.takeOutgoing()
    expect(
      adapter.ingest(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false })}\n`)
    ).toContainEqual({ type: 'completed' })
    // The same frame would start a second turn, which is the queue by a
    // longer road — so the caller is told no and queues it honestly.
    expect(adapter.steer('Too late', 'correction-2')).toBe(false)
    expect(adapter.takeOutgoing()).toEqual([])
  })

  it('refuses a correction from an Adapter that never launched the Run', () => {
    const adapter = createClaudeAdapter()
    expect(adapter.steer('Keep the API compatible', 'correction-1')).toBe(false)
    expect(adapter.takeOutgoing()).toEqual([])
  })

  it('reads a real steered turn back off the recorded probe', async () => {
    const frames = await probeFrames()
    const correction = frames
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .find((frame) => frame['isReplay'] === true)
    const text = (correction?.['message'] as { content: { text: string }[] } | undefined)
      ?.content[0]?.text
    if (!text) throw new Error('The recorded probe carries no echoed correction')
    const adapter = createClaudeAdapter({ prompt: 'probe' })
    adapter.takeOutgoing()
    expect(adapter.steer(text, 'correction-1')).toBe(true)
    const events = frames.flatMap((frame) => adapter.ingest(`${frame}\n`))
    // What the binary did on 2.1.226: it took the correction into the turn it
    // was already running, and that turn ended once.
    expect(events).toContainEqual({ type: 'steer-accepted', submissionId: 'correction-1' })
    // Twice, because the probe recorded both arms: the turn that ignored a
    // correction written the way a Run writes nothing, and the one that took it.
    expect(events.filter((event) => event.type === 'completed')).toHaveLength(2)
    expect(events.filter((event) => event.type === 'failed')).toEqual([])
    // The file the corrected turn wrote is a creation, which Claude reports
    // with no diff at all — read as an edit that would be protocol drift.
    expect(events).toContainEqual({
      type: 'file-change',
      path: '/private/a-project/steer-probe.txt',
      changeKind: 'added',
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+STEERED'] }]
    })
  })
})

describe('a command that never finished', () => {
  it('still reports what the Run was running when it stopped', () => {
    const adapter = createClaudeAdapter()
    adapter.ingest(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_1',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test' } }
          ]
        }
      })}\n`
    )

    // The Run was stopped before the command returned. Saying nothing would
    // leave the person guessing what it had been doing — and saying it
    // finished cleanly would claim a result that never arrived.
    expect(adapter.flush()).toContainEqual({
      type: 'command',
      id: 'toolu_1',
      command: 'pnpm test',
      output: '',
      failed: false,
      running: false,
      interrupted: true,
      exitCode: null,
      durationMs: null
    })
  })
})

describe('a command that is still running', () => {
  it('reports the command when it starts, not only when it finishes', () => {
    const adapter = createClaudeAdapter()
    adapter.ingest(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_1',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test' } }
          ]
        }
      })}\n`
    )

    // The Harness carries no partial output, so the command starting is the
    // earliest thing there is to say. Saying nothing until it finishes leaves
    // a person watching an empty Conversation while a test suite runs.
    const started = adapter.ingest(
      `${JSON.stringify({
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'toolu_1',
        description: 'Run the tests',
        task_type: 'local_bash'
      })}\n`
    )

    expect(started).toEqual([
      {
        type: 'command',
        id: 'toolu_1',
        command: 'pnpm test',
        output: '',
        failed: false,
        running: true,
        exitCode: null,
        durationMs: null
      }
    ])
  })

  describe('subagents', () => {
    it('follows one dispatched subagent from its brief to what it reported back', async () => {
      const subagents = (await replay('claude-subagent.jsonl')).filter(
        (event) => event.type === 'subagent'
      )

      expect(subagents.at(0)).toEqual({
        type: 'subagent',
        id: 'toolu_01H4ZJcREffQM8V7syGiFcKa',
        name: 'Count notes',
        role: 'Explore',
        brief: 'report how many lines notes.txt has',
        status: 'working',
        steps: null,
        durationMs: null
      })

      // While it works, what it is on now is the only thing worth saying, and
      // the Harness says it in prose already.
      expect(subagents).toContainEqual({
        type: 'subagent',
        id: 'toolu_01H4ZJcREffQM8V7syGiFcKa',
        name: 'Count notes',
        role: 'Explore',
        brief: 'report how many lines notes.txt has',
        status: 'working',
        activity: 'Running Count lines and bytes in notes.txt',
        steps: 2,
        durationMs: 7_867
      })

      const last = subagents.at(-1)
      expect(last).toMatchObject({
        type: 'subagent',
        id: 'toolu_01H4ZJcREffQM8V7syGiFcKa',
        name: 'Count notes',
        status: 'done',
        steps: 3,
        durationMs: 12_430
      })
      expect(last?.type === 'subagent' && last.result).toContain('has **2 lines**')
    })

    it('keeps a subagent’s own work out of the Run’s record', async () => {
      const events = await replay('claude-subagent.jsonl')

      // The fixture's subagent runs two commands and reads a file. They are
      // its work, not the Run's, and the Run's own record must not claim them.
      expect(events.filter((event) => event.type === 'command')).toEqual([])
      expect(events.filter((event) => event.type === 'tool')).toEqual([])
      // Nor does the subagent's prose become the Run's prose: only the Run's
      // own closing message is an assistant message here.
      expect(
        events.filter((event) => event.type === 'assistant-message').map((event) => event.text)
      ).toEqual(['notes.txt has **2 lines** (`alpha`, `beta`).'])
    })

    it('reports no protocol failure for a Run that dispatched subagents', async () => {
      expect(
        (await replay('claude-subagent.jsonl')).filter((event) => event.type === 'failed')
      ).toEqual([])
    })

    it('leaves a subagent the Run never finished as interrupted rather than done', () => {
      const adapter = createClaudeAdapter()
      adapter.ingest(
        `${JSON.stringify({
          type: 'system',
          subtype: 'task_started',
          task_id: 'task-9',
          tool_use_id: 'toolu_9',
          description: 'Sweep the fixtures',
          subagent_type: 'Explore',
          task_type: 'local_agent',
          prompt: 'check the recorded fixture'
        })}\n`
      )

      expect(adapter.flush()).toEqual([
        {
          type: 'subagent',
          id: 'toolu_9',
          name: 'Sweep the fixtures',
          role: 'Explore',
          brief: 'check the recorded fixture',
          status: 'interrupted',
          steps: null,
          durationMs: null
        }
      ])
    })
  })
})

/**
 * The two ways Claude keeps a checklist. Hand-written frames rather than a
 * recording: no fixture in this directory contains either tool — the recorded
 * turns were too short to earn one — and `claude-subagent.jsonl` shows why
 * both matter, since its `system/init` lists the Task tools and no
 * `TodoWrite`. `TodoWrite` has been off by default since claude 2.1.142, and
 * this app's supported band straddles that version.
 */
describe('the plan', () => {
  function assistant(content: unknown[]): string {
    return `${JSON.stringify({
      type: 'assistant',
      message: { id: 'msg_plan', role: 'assistant', content }
    })}\n`
  }

  function toolResult(toolUseId: string, result: unknown): string {
    return `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
      tool_use_result: result
    })}\n`
  }

  describe('as TodoWrite writes it', () => {
    it('reads the whole list, keeping the phrasing for the step in flight', () => {
      const adapter = createClaudeAdapter()
      const [plan] = adapter.ingest(
        assistant([
          {
            type: 'tool_use',
            id: 'toolu_todo',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Map the seams', status: 'completed', activeForm: 'Mapping the seams' },
                {
                  content: 'Normalise both Harnesses',
                  status: 'in_progress',
                  activeForm: 'Normalising both Harnesses'
                },
                {
                  content: 'Record a fixture',
                  status: 'pending',
                  activeForm: 'Recording a fixture'
                }
              ]
            }
          }
        ])
      )
      expect(plan).toEqual({
        type: 'plan',
        // Only Codex says why a plan changed.
        explanation: null,
        steps: [
          { step: 'Map the seams', activeForm: 'Mapping the seams', status: 'completed' },
          {
            step: 'Normalise both Harnesses',
            activeForm: 'Normalising both Harnesses',
            status: 'in-progress'
          },
          { step: 'Record a fixture', activeForm: 'Recording a fixture', status: 'pending' }
        ]
      })
    })

    it('replaces the list rather than adding to it, because that is what the tool does', () => {
      const adapter = createClaudeAdapter()
      adapter.ingest(
        assistant([
          {
            type: 'tool_use',
            id: 'toolu_a',
            name: 'TodoWrite',
            input: { todos: [{ content: 'First shape', status: 'in_progress' }] }
          }
        ])
      )
      const [plan] = adapter.ingest(
        assistant([
          {
            type: 'tool_use',
            id: 'toolu_b',
            name: 'TodoWrite',
            input: { todos: [{ content: 'Second shape', status: 'in_progress' }] }
          }
        ])
      )
      expect(plan).toMatchObject({ steps: [{ step: 'Second shape', status: 'in-progress' }] })
    })

    it('says nothing for an empty list, and never reports the call as a tool step', () => {
      const adapter = createClaudeAdapter()
      const events = adapter.ingest(
        assistant([
          { type: 'tool_use', id: 'toolu_empty', name: 'TodoWrite', input: { todos: [] } }
        ])
      )
      expect(events).toEqual([])
    })
  })

  describe('as the Task tools write it', () => {
    /** A create, then the result frame that is the only place its id appears. */
    function create(toolUseId: string, subject: string, taskId: string): string[] {
      return [
        assistant([
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'TaskCreate',
            input: { subject, activeForm: `${subject}…` }
          }
        ]),
        toolResult(toolUseId, { task: { id: taskId, subject } })
      ]
    }

    it('assembles a list from calls that each describe only a change', () => {
      const adapter = createClaudeAdapter()
      let plan: HarnessEvent | undefined
      for (const line of [
        ...create('toolu_1', 'Map the seams', 'task-1'),
        ...create('toolu_2', 'Record a fixture', 'task-2')
      ]) {
        plan = adapter.ingest(line).at(-1) ?? plan
      }
      expect(plan).toMatchObject({
        type: 'plan',
        steps: [
          { step: 'Map the seams', activeForm: 'Map the seams…', status: 'pending' },
          { step: 'Record a fixture', activeForm: 'Record a fixture…', status: 'pending' }
        ]
      })
    })

    it('moves a step by the id its result frame gave it', () => {
      const adapter = createClaudeAdapter()
      for (const line of create('toolu_1', 'Map the seams', 'task-1')) adapter.ingest(line)
      const [plan] = adapter.ingest(
        assistant([
          {
            type: 'tool_use',
            id: 'toolu_move',
            name: 'TaskUpdate',
            input: { taskId: 'task-1', status: 'in_progress' }
          }
        ])
      )
      expect(plan).toMatchObject({ steps: [{ step: 'Map the seams', status: 'in-progress' }] })
    })

    it('reads the raw keys the model emits, which the CLI only repairs after streaming', () => {
      const adapter = createClaudeAdapter()
      for (const line of create('toolu_1', 'Map the seams', 'task-1')) adapter.ingest(line)
      const [plan] = adapter.ingest(
        assistant([
          {
            type: 'tool_use',
            id: 'toolu_snake',
            name: 'TaskUpdate',
            // `task_id` and `active_form` as the model wrote them.
            input: { task_id: 'task-1', status: 'completed', active_form: 'Mapping the seams' }
          }
        ])
      )
      expect(plan).toMatchObject({
        steps: [{ step: 'Map the seams', activeForm: 'Mapping the seams', status: 'completed' }]
      })
    })

    it('drops a deleted step rather than leaving it on the plan', () => {
      const adapter = createClaudeAdapter()
      for (const line of [
        ...create('toolu_1', 'Map the seams', 'task-1'),
        ...create('toolu_2', 'Record a fixture', 'task-2')
      ]) {
        adapter.ingest(line)
      }
      const [plan] = adapter.ingest(
        assistant([
          {
            type: 'tool_use',
            id: 'toolu_del',
            name: 'TaskUpdate',
            input: { taskId: 'task-1', status: 'deleted' }
          }
        ])
      )
      expect(plan).toMatchObject({ steps: [{ step: 'Record a fixture' }] })
    })

    it('ignores an update naming a task it never saw created', () => {
      const adapter = createClaudeAdapter()
      expect(
        adapter.ingest(
          assistant([
            {
              type: 'tool_use',
              id: 'toolu_orphan',
              name: 'TaskUpdate',
              input: { taskId: 'task-nobody-saw', status: 'completed' }
            }
          ])
        )
      ).toEqual([])
    })
  })

  it('reads a context Claude compacted for itself, rather than failing on it', () => {
    const adapter = createClaudeAdapter()
    const events = adapter.ingest(
      `${JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        session_id: 'thread-1',
        compact_metadata: { trigger: 'auto', pre_tokens: 180_000 }
      })}\n`
    )
    expect(events).toMatchObject([{ type: 'context-compacted' }])
    expect(events.filter((event) => event.type === 'failed')).toEqual([])
    expect(harnessEventSchema.safeParse(events[0]).success).toBe(true)
  })

  it('is a normalized event either way, and never a tool step of its own', () => {
    const adapter = createClaudeAdapter()
    const events = adapter.ingest(
      assistant([
        {
          type: 'tool_use',
          id: 'toolu_todo',
          name: 'TodoWrite',
          input: { todos: [{ content: 'Only step', status: 'in_progress' }] }
        }
      ])
    )
    expect(events.map((event) => event.type)).toEqual(['plan'])
    expect(harnessEventSchema.safeParse(events[0]).success).toBe(true)
  })
})
