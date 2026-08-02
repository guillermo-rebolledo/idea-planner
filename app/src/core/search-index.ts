import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  sessionSummarySchema,
  type SessionSummary,
  type MailboxCoreQuery,
  type MailboxGroup,
  type MailboxSession,
  type MailboxSnapshot
} from '@shared/contract'

/**
 * The disposable SQLite search projection for the Focus Mailbox. Canonical
 * Markdown stays the only truth: everything here can be deleted at any time
 * and rebuilt from a library scan, and callers are expected to do exactly
 * that whenever this module throws.
 */

const INDEX_DIR = '.index'
const INDEX_FILE = 'mailbox.sqlite'
const DAY_MS = 24 * 60 * 60 * 1000

export interface IndexedSession {
  summary: SessionSummary
  /** Markdown body (after frontmatter) used for full-text search. */
  body: string
}

export function indexPath(library: string): string {
  return join(library, INDEX_DIR, INDEX_FILE)
}

export function indexExists(library: string): boolean {
  return existsSync(indexPath(library))
}

export function deleteIndex(library: string): void {
  rmSync(join(library, INDEX_DIR), { recursive: true, force: true })
}

function openIndex(library: string): DatabaseSync {
  mkdirSync(join(library, INDEX_DIR), { recursive: true })
  const db = new DatabaseSync(indexPath(library))
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      pinned INTEGER NOT NULL,
      archived_at TEXT,
      body TEXT NOT NULL
    )
  `)
  return db
}

function withIndex<A>(library: string, use: (db: DatabaseSync) => A): A {
  const db = openIndex(library)
  try {
    return use(db)
  } finally {
    db.close()
  }
}

const UPSERT_SQL = `
  INSERT INTO sessions (
    id, relative_path, title, created_at, updated_at, pinned, archived_at, body
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    relative_path = excluded.relative_path,
    title = excluded.title,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    pinned = excluded.pinned,
    archived_at = excluded.archived_at,
    body = excluded.body
`

function upsertRow(db: DatabaseSync, session: IndexedSession): void {
  const { summary, body } = session
  db.prepare(UPSERT_SQL).run(
    summary.id,
    summary.relativePath,
    summary.title,
    summary.createdAt,
    summary.updatedAt,
    summary.pinned ? 1 : 0,
    summary.archivedAt,
    body
  )
}

/**
 * Replaces the whole projection with a fresh scan of canonical content. An
 * empty library keeps no projection at all: opening a folder writes nothing.
 */
export function rebuildIndex(library: string, sessions: IndexedSession[]): void {
  deleteIndex(library)
  if (sessions.length === 0) return
  withIndex(library, (db) => {
    for (const session of sessions) upsertRow(db, session)
  })
}

/** The answer for a library with no Sessions, without touching the disk. */
export function emptyMailbox(view: MailboxCoreQuery['view']): Omit<MailboxSnapshot, 'index'> {
  return { view, total: 0, matched: 0, groups: groupSessions([], view) }
}

export function upsertSession(library: string, session: IndexedSession): void {
  withIndex(library, (db) => upsertRow(db, session))
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`)
}

interface SessionRow {
  id: string
  relative_path: string
  title: string
  created_at: string
  updated_at: string
  pinned: number
  archived_at: string | null
  body: string
}

function rowToSession(row: SessionRow, dormant: boolean): MailboxSession | null {
  const parsed = sessionSummarySchema.safeParse({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    relativePath: row.relative_path,
    pinned: row.pinned === 1,
    archivedAt: row.archived_at
  })
  return parsed.success ? { ...parsed.data, dormant } : null
}

/**
 * Answers a mailbox query from the projection alone. Throws on any SQLite
 * problem so the caller can rebuild from canonical content and retry.
 */
export function queryIndex(
  library: string,
  query: MailboxCoreQuery,
  now: Date
): Omit<MailboxSnapshot, 'index'> {
  return withIndex(library, (db) => {
    const viewCondition =
      query.view === 'archived' ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS count FROM sessions WHERE ${viewCondition}`)
      .get() as { count: number }

    const conditions = [viewCondition]
    const parameters: string[] = []
    for (const term of query.search.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
      conditions.push(`(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(body) LIKE ? ESCAPE '\\')`)
      const pattern = `%${escapeLike(term)}%`
      parameters.push(pattern, pattern)
    }

    const rows = db
      .prepare(
        `SELECT * FROM sessions WHERE ${conditions.join(' AND ')}
         ORDER BY updated_at DESC, title ASC`
      )
      .all(...parameters) as unknown as SessionRow[]

    const dormantBefore = now.getTime() - query.dormantAfterDays * DAY_MS
    const sessions = rows
      .map((row) => {
        const dormant =
          query.view === 'active' && row.pinned === 1 && Date.parse(row.updated_at) <= dormantBefore
        return rowToSession(row, dormant)
      })
      .filter((session): session is MailboxSession => session !== null)

    return {
      view: query.view,
      total: totalRow.count,
      matched: sessions.length,
      groups: groupSessions(sessions, query.view)
    }
  })
}

function groupSessions(sessions: MailboxSession[], view: MailboxCoreQuery['view']): MailboxGroup[] {
  if (view === 'archived') {
    return [{ key: 'archived', sessions }]
  }
  const groups: MailboxGroup[] = [
    { key: 'pinned', sessions: [] },
    { key: 'needs-attention', sessions: [] },
    { key: 'running', sessions: [] },
    { key: 'recent', sessions: [] }
  ]
  const byKey = new Map(groups.map((group) => [group.key, group]))
  for (const session of sessions) {
    const key = session.pinned ? 'pinned' : 'recent'
    byKey.get(key)?.sessions.push(session)
  }
  return groups
}
