import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ideaSummarySchema,
  type IdeaSummary,
  type MailboxCoreQuery,
  type MailboxGroup,
  type MailboxIdea,
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

export interface IndexedIdea {
  summary: IdeaSummary
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
    CREATE TABLE IF NOT EXISTS ideas (
      id TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      open_state TEXT NOT NULL,
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
  INSERT INTO ideas (
    id, relative_path, kind, title, status, created_at, updated_at,
    open_state, pinned, archived_at, body
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    relative_path = excluded.relative_path,
    kind = excluded.kind,
    title = excluded.title,
    status = excluded.status,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    open_state = excluded.open_state,
    pinned = excluded.pinned,
    archived_at = excluded.archived_at,
    body = excluded.body
`

function upsertRow(db: DatabaseSync, idea: IndexedIdea): void {
  const { summary, body } = idea
  db.prepare(UPSERT_SQL).run(
    summary.id,
    summary.relativePath,
    summary.kind,
    summary.title,
    summary.status,
    summary.createdAt,
    summary.updatedAt,
    summary.openState,
    summary.pinned ? 1 : 0,
    summary.archivedAt,
    body
  )
}

/**
 * Replaces the whole projection with a fresh scan of canonical content. An
 * empty library keeps no projection at all: opening a folder writes nothing.
 */
export function rebuildIndex(library: string, ideas: IndexedIdea[]): void {
  deleteIndex(library)
  if (ideas.length === 0) return
  withIndex(library, (db) => {
    for (const idea of ideas) upsertRow(db, idea)
  })
}

/** The answer for a library with no Ideas, without touching the disk. */
export function emptyMailbox(view: MailboxCoreQuery['view']): Omit<MailboxSnapshot, 'index'> {
  return { view, total: 0, matched: 0, groups: groupIdeas([], view) }
}

export function upsertIdea(library: string, idea: IndexedIdea): void {
  withIndex(library, (db) => upsertRow(db, idea))
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`)
}

interface IdeaRow {
  id: string
  relative_path: string
  kind: string
  title: string
  status: string
  created_at: string
  updated_at: string
  open_state: string
  pinned: number
  archived_at: string | null
  body: string
}

function rowToIdea(row: IdeaRow, dormant: boolean): MailboxIdea | null {
  const parsed = ideaSummarySchema.safeParse({
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    openState: row.open_state,
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
      .prepare(`SELECT COUNT(*) AS count FROM ideas WHERE ${viewCondition}`)
      .get() as { count: number }

    const conditions = [viewCondition]
    const parameters: string[] = []
    if (query.kind !== 'all') {
      conditions.push('kind = ?')
      parameters.push(query.kind)
    }
    for (const term of query.search.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
      conditions.push(`(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(body) LIKE ? ESCAPE '\\')`)
      const pattern = `%${escapeLike(term)}%`
      parameters.push(pattern, pattern)
    }

    const rows = db
      .prepare(
        `SELECT * FROM ideas WHERE ${conditions.join(' AND ')}
         ORDER BY updated_at DESC, title ASC`
      )
      .all(...parameters) as unknown as IdeaRow[]

    const dormantBefore = now.getTime() - query.dormantAfterDays * DAY_MS
    const ideas = rows
      .map((row) => {
        const dormant =
          query.view === 'active' && row.pinned === 1 && Date.parse(row.updated_at) <= dormantBefore
        return rowToIdea(row, dormant)
      })
      .filter((idea): idea is MailboxIdea => idea !== null)

    return {
      view: query.view,
      total: totalRow.count,
      matched: ideas.length,
      groups: groupIdeas(ideas, query.view)
    }
  })
}

function groupIdeas(ideas: MailboxIdea[], view: MailboxCoreQuery['view']): MailboxGroup[] {
  if (view === 'archived') {
    return [{ key: 'archived', ideas }]
  }
  const groups: MailboxGroup[] = [
    { key: 'pinned', ideas: [] },
    { key: 'needs-attention', ideas: [] },
    { key: 'running', ideas: [] },
    { key: 'recent', ideas: [] }
  ]
  const byKey = new Map(groups.map((group) => [group.key, group]))
  for (const idea of ideas) {
    const key = idea.pinned
      ? 'pinned'
      : idea.openState === 'unrecoverable-content' || idea.openState === 'read-only-newer-format'
        ? 'needs-attention'
        : 'recent'
    byKey.get(key)?.ideas.push(idea)
  }
  return groups
}
