import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MailboxCoreQuery, MailboxProject, MailboxSnapshot } from '@shared/contract'
import { createCore, type Core } from './core'
import { finishRunLifecycle } from './run-lifecycle-test-support'

const DAY_MS = 24 * 60 * 60 * 1000

let stateDir: string
let projectRoot: string
let now: Date
let core: Core

function makeCore(): Core {
  let n = 0
  return createCore({
    stateDirectory: stateDir,
    now: () => now,
    randomId: () => `mailbox-id-${String(++n).padStart(4, '0')}`
  })
}

function query(overrides: Partial<MailboxCoreQuery> = {}): MailboxCoreQuery {
  return { search: '', view: 'active', dormantAfterDays: 14, ...overrides }
}

/** The Session titles one Project group holds, or [] when it is absent. */
function titles(groups: MailboxProject[], root: string): string[] {
  return (groups.find((group) => group.root === root)?.sessions ?? []).map(
    (session) => session.title
  )
}

/** Every title in the snapshot's project groups, in presented order. */
function projectTitles(snapshot: MailboxSnapshot): string[] {
  return snapshot.projects.flatMap((group) => group.sessions.map((session) => session.title))
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'session-mailbox-state-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'session-mailbox-project-'))
  now = new Date('2026-07-31T12:00:00.000Z')
  core = makeCore()
  await core.addProject(projectRoot)
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

/** A Session is started by a message; its title is derived from it. */
async function start(message: string) {
  return core.startSession({ projectRoot, message })
}

describe('project grouping', () => {
  it('nests Sessions under the Project that owns them', async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), 'session-mailbox-other-'))
    await core.addProject(otherRoot)
    await start('Here at home')
    now = new Date(now.getTime() + 1000)
    await core.startSession({ projectRoot: otherRoot, message: 'Elsewhere entirely' })

    const snapshot = await core.queryMailbox(query())
    expect(snapshot.matched).toBe(2)
    expect(titles(snapshot.projects, projectRoot)).toEqual(['Here at home'])
    expect(titles(snapshot.projects, otherRoot)).toEqual(['Elsewhere entirely'])
    await rm(otherRoot, { recursive: true, force: true })
  })

  it('lists a Project with no Sessions at all: it is still somewhere to start one', async () => {
    const snapshot = await core.queryMailbox(query())
    expect(snapshot.projects).toEqual([
      expect.objectContaining({ root: projectRoot, sessions: [] })
    ])
  })

  it('keeps a Session whose Project was removed, under an unavailable group named by its root', async () => {
    await start('Orphaned but not lost')
    await core.removeProject(projectRoot)

    const snapshot = await core.queryMailbox(query())
    const orphanGroup = snapshot.projects.find((group) => group.root === projectRoot)
    expect(orphanGroup).toMatchObject({
      name: basename(projectRoot),
      available: false
    })
    expect(titles(snapshot.projects, projectRoot)).toEqual(['Orphaned but not lost'])
  })
})

describe('pinning', () => {
  it('lifts pinned Sessions into the pinned groups, still under their Project', async () => {
    const pinnedSession = await start('Pinned older Session')
    now = new Date(now.getTime() + DAY_MS)
    await start('Newer unpinned Session')

    const updated = await core.setSessionPinned(pinnedSession.id, true)
    expect(updated.pinned).toBe(true)

    const snapshot = await core.queryMailbox(query())
    expect(titles(snapshot.pinned, projectRoot)).toEqual(['Pinned older Session'])
    // Lifted, not copied: the project group no longer lists it.
    expect(titles(snapshot.projects, projectRoot)).toEqual(['Newer unpinned Session'])
  })

  it('survives a restart', async () => {
    const session = await start('Stays pinned')
    await core.setSessionPinned(session.id, true)

    const snapshot = await makeCore().queryMailbox(query())
    expect(titles(snapshot.pinned, projectRoot)).toEqual(['Stays pinned'])
  })

  it('unpins reversibly', async () => {
    const session = await start('Toggle pin')
    await core.setSessionPinned(session.id, true)
    const unpinned = await core.setSessionPinned(session.id, false)
    expect(unpinned.pinned).toBe(false)
    const snapshot = await core.queryMailbox(query())
    expect(snapshot.pinned).toEqual([])
    expect(titles(snapshot.projects, projectRoot)).toEqual(['Toggle pin'])
  })

  it('marks a pinned Session Dormant after the configured threshold without moving it', async () => {
    const dormantSession = await start('Sleepy pinned Session')
    await core.setSessionPinned(dormantSession.id, true)
    now = new Date(now.getTime() + 20 * DAY_MS)
    await start('Fresh unpinned Session')

    const snapshot = await core.queryMailbox(query({ dormantAfterDays: 14 }))
    expect(snapshot.pinned[0]?.sessions[0]).toMatchObject({
      title: 'Sleepy pinned Session',
      dormant: true
    })

    const relaxed = await core.queryMailbox(query({ dormantAfterDays: 30 }))
    expect(relaxed.pinned[0]?.sessions[0]?.dormant).toBe(false)
  })

  it('refuses to pin a Session that does not exist', async () => {
    await expect(core.setSessionPinned('never-started', true)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND'
    })
  })
})

describe('archiving', () => {
  it('archives reversibly, without touching the Project', async () => {
    const session = await start('Archivable Session')
    const before = await readdir(projectRoot)

    const archived = await core.setSessionArchived(session.id, true)
    expect(archived.archivedAt).toBe(now.toISOString())
    expect(await readdir(projectRoot)).toEqual(before)

    const active = await core.queryMailbox(query())
    expect(active.matched).toBe(0)
    expect(active.archivedTotal).toBe(1)
    const archivedView = await core.queryMailbox(query({ view: 'archived' }))
    expect(titles(archivedView.projects, projectRoot)).toEqual(['Archivable Session'])

    const restored = await core.setSessionArchived(session.id, false)
    expect(restored.archivedAt).toBeNull()
    const activeAgain = await core.queryMailbox(query())
    expect(titles(activeAgain.projects, projectRoot)).toEqual(['Archivable Session'])
    expect(activeAgain.archivedTotal).toBe(0)
  })

  it('keeps archive state across restarts', async () => {
    const session = await start('Stays archived')
    await core.setSessionArchived(session.id, true)

    const reborn = makeCore()
    const active = await reborn.queryMailbox(query())
    expect(active.total).toBe(0)
    const archivedView = await reborn.queryMailbox(query({ view: 'archived' }))
    expect(titles(archivedView.projects, projectRoot)).toEqual(['Stays archived'])
  })

  it('leaves Projects with nothing archived out of the archived view', async () => {
    await start('Never archived')
    const archivedView = await core.queryMailbox(query({ view: 'archived' }))
    expect(archivedView.projects).toEqual([])
  })
})

describe('renaming', () => {
  it('replaces the derived title with the given one, durably', async () => {
    const session = await start('What the first message suggested')

    const renamed = await core.renameSession(session.id, 'My own words')
    expect(renamed.title).toBe('My own words')

    const snapshot = await makeCore().queryMailbox(query())
    expect(titles(snapshot.projects, projectRoot)).toEqual(['My own words'])
  })

  it('trims, and refuses a title that is only whitespace', async () => {
    const session = await start('Renameable')
    const renamed = await core.renameSession(session.id, '  Tidy  ')
    expect(renamed.title).toBe('Tidy')
    await expect(core.renameSession(session.id, '   ')).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
  })

  it('refuses to rename a Session that does not exist', async () => {
    await expect(core.renameSession('never-started', 'Ghost')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND'
    })
  })
})

describe('search', () => {
  beforeEach(async () => {
    await start('Offline recipe planner')
    now = new Date(now.getTime() + 1000)
    await start('Community tool library')
  })

  it('matches Session titles, term by term', async () => {
    const oneTerm = await core.queryMailbox(query({ search: 'recipe' }))
    expect(projectTitles(oneTerm)).toEqual(['Offline recipe planner'])
    const bothTerms = await core.queryMailbox(query({ search: 'community tool' }))
    expect(projectTitles(bothTerms)).toEqual(['Community tool library'])
  })

  it('distinguishes no results from having no Sessions at all', async () => {
    const snapshot = await core.queryMailbox(query({ search: 'zeppelin' }))
    expect(snapshot.total).toBe(2)
    expect(snapshot.matched).toBe(0)
  })
})

/** Puts a Session mid-Run, as developing one does. */
async function beginRun(sessionId: string): Promise<string> {
  const opened = await core.openRunLifecycle({
    submissionId: `submission-${sessionId}`,
    sessionId,
    prompt: 'Change the greeting',
    configuration: {
      harness: 'claude',
      executable: '/usr/local/bin/claude',
      executableHash: 'a'.repeat(64),
      harnessVersion: '2.1.220 (Claude Code)',
      model: 'default',
      effort: 'medium',
      skill: null,
      environment: {},
      checkout: projectRoot,
      permissionMode: 'ask'
    }
  })
  await core.recordRunEvent({
    sessionId,
    runId: opened.run.id,
    status: 'starting',
    kind: 'lifecycle',
    summary: 'Starting the Harness'
  })
  await core.recordRunEvent({
    sessionId,
    runId: opened.run.id,
    status: 'running',
    kind: 'lifecycle',
    summary: 'Harness process running'
  })
  return opened.run.id
}

const finishRun = (input: Parameters<typeof finishRunLifecycle>[1]) =>
  finishRunLifecycle(core, input)

/** The one row a title names, wherever its Project group is. */
function row(snapshot: MailboxSnapshot, title: string) {
  return [...snapshot.pinned, ...snapshot.projects]
    .flatMap((group) => group.sessions)
    .find((session) => session.title === title)
}

it('says what each Session is doing on its row, without moving it', async () => {
  const waiting = await start('Waiting on me')
  const working = await start('Still working')
  const quiet = await start('Replied and stopped')

  const waitingRun = await beginRun(waiting.id)
  await core.applyHarnessEvent({
    sessionId: waiting.id,
    runId: waitingRun,
    event: {
      type: 'approval-request',
      id: 'toolu_1',
      tool: 'Bash',
      summary: 'rm -rf build',
      detail: '{}',
      proposedRule: null
    }
  })
  await beginRun(working.id)
  const quietRun = await beginRun(quiet.id)
  await core.applyHarnessEvent({
    sessionId: quiet.id,
    runId: quietRun,
    event: { type: 'assistant-message', id: 'msg_1', text: 'Done.', complete: true }
  })
  await finishRun({
    sessionId: quiet.id,
    runId: quietRun,
    outcome: 'completed',
    category: null,
    summary: 'Harness process completed'
  })

  const snapshot = await core.queryMailbox(query())
  // One group holds all three: status is a dot on the row, not an address.
  expect(titles(snapshot.projects, projectRoot)).toHaveLength(3)
  expect(row(snapshot, 'Waiting on me')).toMatchObject({
    status: 'blocked',
    waitingFor: 'approval'
  })
  expect(row(snapshot, 'Still working')).toMatchObject({ status: 'running' })
  expect(row(snapshot, 'Replied and stopped')).toMatchObject({ status: 'idle' })
})

it('counts an unanswered structured question as waiting, and prose as not', async () => {
  const asked = await start('Asked me something')
  const runId = await beginRun(asked.id)
  await core.applyHarnessEvent({
    sessionId: asked.id,
    runId,
    event: { type: 'assistant-message', id: 'msg_1', text: 'Which one?', complete: true }
  })
  await core.applyHarnessEvent({
    sessionId: asked.id,
    runId,
    event: {
      type: 'choices',
      question: 'Which one?',
      options: [{ id: 'option-1', label: 'The first', value: 'The first' }]
    }
  })
  await finishRun({
    sessionId: asked.id,
    runId,
    outcome: 'completed',
    category: null,
    summary: 'Harness process completed'
  })

  const waiting = await core.queryMailbox(query())
  expect(row(waiting, 'Asked me something')).toMatchObject({
    status: 'blocked',
    waitingFor: 'question'
  })

  // Answering it is what stops it waiting.
  await core.submitConversationMessage({
    sessionId: asked.id,
    submissionId: 'submission-answer',
    text: 'The first',
    source: 'suggested-response'
  })
  const answered = await core.queryMailbox(query())
  expect(row(answered, 'Asked me something')).toMatchObject({ status: 'idle', waitingFor: null })
})

describe('what the inbox reads', () => {
  /** Where the projection for a Session lives, beside its Conversation. */
  function stateFile(sessionId: string): string {
    return join(stateDir, 'sessions', sessionId, 'state.json')
  }

  it('answers from the projection rather than the Conversation', async () => {
    const session = await start('Quietly idle')
    await core.queryMailbox(query())

    // Only reading the projection can produce this answer: the Conversation
    // says nothing of the kind. Tampering is how the difference is visible.
    const projected = JSON.parse(await readFile(stateFile(session.id), 'utf8')) as {
      journalBytes: number
    }
    await writeFile(
      stateFile(session.id),
      JSON.stringify({ ...projected, activeRunId: 'run-invented' })
    )
    expect(row(await core.queryMailbox(query()), 'Quietly idle')).toMatchObject({
      status: 'running'
    })
  })

  it('never says something the Conversation itself would not', async () => {
    // The case that separates a projection from a copy: an agent asks a
    // question, the person answers while its message is still streaming, and
    // the message is written again afterwards. The journal keeps one entry per
    // message, at the place it first appeared — so the reply is still the last
    // thing said, and this Session is not waiting on anybody.
    const session = await start('Answered while it streamed')
    const runId = await beginRun(session.id)
    const asking = {
      sessionId: session.id,
      runId,
      event: {
        type: 'assistant-message' as const,
        id: 'msg_ask',
        text: 'Which one?',
        complete: false
      }
    }
    await core.applyHarnessEvent(asking)
    await core.applyHarnessEvent({
      sessionId: session.id,
      runId,
      event: {
        type: 'choices',
        question: 'Which one?',
        options: [{ id: 'option-1', label: 'The first', value: 'The first' }]
      }
    })
    await core.submitConversationMessage({
      sessionId: session.id,
      submissionId: 'submission-answer',
      text: 'The first',
      source: 'suggested-response'
    })
    // The same message again, written when it finishes — after the reply.
    await core.applyHarnessEvent({
      ...asking,
      event: { ...asking.event, text: 'Which one?', complete: true }
    })

    const projected = await core.queryMailbox(query())
    expect(row(projected, 'Answered while it streamed')).toMatchObject({ waitingFor: null })
    // And the Conversation, read in full, says exactly the same thing.
    const conversation = await core.getConversation(session.id)
    const spoken = conversation.entries.filter((entry) => entry.kind === 'message').at(-1)
    expect(spoken).toMatchObject({ role: 'user', text: 'The first' })
  })

  it('rebuilds a projection that has fallen behind its Conversation', async () => {
    const session = await start('Told the truth')
    await core.queryMailbox(query())
    // A projection written before a journal that has since grown: exactly what
    // a crash between the two leaves behind.
    await writeFile(
      stateFile(session.id),
      JSON.stringify({
        activeRunId: 'run-invented',
        openApprovals: [],
        lastMessage: null,
        recovery: null,
        journalBytes: 1
      })
    )

    const snapshot = await core.queryMailbox(query())
    expect(row(snapshot, 'Told the truth')).toMatchObject({ status: 'idle' })
  })

  it('answers without a projection at all, and leaves one behind', async () => {
    const session = await start('Never projected')
    await rm(stateFile(session.id), { force: true })

    expect(row(await core.queryMailbox(query()), 'Never projected')).toMatchObject({
      status: 'idle'
    })
    await expect(readFile(stateFile(session.id), 'utf8')).resolves.toContain('journalBytes')
  })
})

describe('what is waiting for me', () => {
  it('lists a Run its Conversation still has open, and stops once it is closed', async () => {
    const abandoned = await start('Quit while it worked')
    const runId = await beginRun(abandoned.id)

    // What a restart finds: nothing finalized it, so it still reads as
    // working — which is what makes closing it worth doing.
    expect(await core.listUnfinishedRuns()).toEqual([{ sessionId: abandoned.id, runId }])
    expect(row(await core.queryMailbox(query()), 'Quit while it worked')).toMatchObject({
      status: 'running'
    })

    await finishRun({
      sessionId: abandoned.id,
      runId,
      outcome: 'failed',
      category: null,
      summary: 'The app closed while this Run was working'
    })

    expect(await core.listUnfinishedRuns()).toEqual([])
    expect(row(await core.queryMailbox(query()), 'Quit while it worked')).toMatchObject({
      status: 'failed'
    })
    // The person's message is theirs to send again.
    const conversation = await core.getConversation(abandoned.id)
    expect(conversation.recovery?.resumableSubmissionId).toBe(`submission-${abandoned.id}`)
  })

  it('does not call a Run the person stopped a failure', async () => {
    const stopped = await start('Stopped it myself')
    const runId = await beginRun(stopped.id)
    await finishRun({
      sessionId: stopped.id,
      runId,
      outcome: 'stopped',
      category: null,
      summary: 'Stopped on request'
    })

    const snapshot = await core.queryMailbox(query())
    expect(row(snapshot, 'Stopped it myself')).toMatchObject({ status: 'idle' })
  })

  it('reports a failed Run as failed on its row', async () => {
    const failed = await start('Ended badly')
    const runId = await beginRun(failed.id)
    await finishRun({
      sessionId: failed.id,
      runId,
      outcome: 'failed',
      category: 'process-crash',
      summary: 'Harness process failed'
    })

    const snapshot = await core.queryMailbox(query())
    expect(row(snapshot, 'Ended badly')).toMatchObject({ status: 'failed' })
  })
})
