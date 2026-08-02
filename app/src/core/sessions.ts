import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import { z } from 'zod'
import { CoreError } from '@shared/contract'
import { sessionSummarySchema, type SessionSummary } from '@shared/contract'
import { writeJsonAtomic } from './atomic'

const SESSIONS_DIR = 'sessions'
const RECORD_FILE = 'session.json'

const recordSchema = sessionSummarySchema

/**
 * The app-owned store of Sessions, beside the Projects it points at and never
 * inside them (ADR 0002). A Session is a directory named by its id, holding
 * the record, the Conversation journal, and its Runs.
 *
 * A Session exists if and only if its record parses. Records are written whole
 * or not at all, so a crash can leave a Session missing but never leave one
 * that reads as something it is not.
 */
export class SessionStore {
  private readonly writeLock = Effect.runSync(Effect.makeSemaphore(1))

  constructor(
    private readonly stateDirectory: string | undefined,
    private readonly now: () => Date,
    private readonly nextId: () => string
  ) {}

  /** The directory holding one Session's record, journal, and Runs. */
  directoryFor(id: string): Effect.Effect<string, CoreError> {
    return this.root().pipe(Effect.map((root) => join(root, id)))
  }

  start(input: { projectRoot: string; title: string }): Effect.Effect<SessionSummary, CoreError> {
    return this.writeLock.withPermits(1)(
      Effect.gen(this, function* () {
        const created = this.now().toISOString()
        const session: SessionSummary = {
          id: this.nextId(),
          projectRoot: input.projectRoot,
          title: input.title,
          createdAt: created,
          updatedAt: created,
          pinned: false,
          archivedAt: null
        }
        yield* this.save(session)
        return session
      })
    )
  }

  list(): Effect.Effect<SessionSummary[], CoreError> {
    return this.scan().pipe(Effect.map((scanned) => scanned.intact))
  }

  /**
   * Ids whose record could not be read. Reported rather than hidden: a Session
   * that vanishes without a word is the failure this store exists to prevent.
   */
  listDamaged(): Effect.Effect<string[], CoreError> {
    return this.scan().pipe(Effect.map((scanned) => scanned.damaged))
  }

  get(id: string): Effect.Effect<SessionSummary, CoreError> {
    return this.read(id).pipe(
      Effect.flatMap((session) =>
        session
          ? Effect.succeed(session)
          : Effect.fail(new CoreError('SESSION_NOT_FOUND', 'The Session was not found'))
      )
    )
  }

  update(
    id: string,
    patch: { pinned?: boolean; archived?: boolean; title?: string }
  ): Effect.Effect<SessionSummary, CoreError> {
    return this.writeLock.withPermits(1)(
      this.get(id).pipe(
        Effect.flatMap((session) => {
          const next: SessionSummary = {
            ...session,
            ...(patch.title === undefined ? {} : { title: patch.title }),
            ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
            ...(patch.archived === undefined
              ? {}
              : { archivedAt: patch.archived ? this.now().toISOString() : null }),
            updatedAt: this.now().toISOString()
          }
          return this.save(next).pipe(Effect.as(next))
        })
      )
    )
  }

  /** Forgets a Session. Nothing in the Project it pointed at is touched. */
  delete(id: string): Effect.Effect<void, CoreError> {
    return this.writeLock.withPermits(1)(
      this.directoryFor(id).pipe(
        Effect.flatMap((directory) =>
          Effect.tryPromise({
            try: () => rm(directory, { recursive: true, force: true }),
            catch: () => new CoreError('IO_ERROR', 'The Session could not be deleted')
          })
        )
      )
    )
  }

  private save(session: SessionSummary): Effect.Effect<void, CoreError> {
    return this.directoryFor(session.id).pipe(
      Effect.flatMap((directory) => writeJsonAtomic(join(directory, RECORD_FILE), session))
    )
  }

  private read(id: string): Effect.Effect<SessionSummary | null, CoreError> {
    return this.directoryFor(id).pipe(
      Effect.flatMap((directory) =>
        Effect.promise(() =>
          readFile(join(directory, RECORD_FILE), 'utf8').then(
            (raw) => parse(raw),
            () => null
          )
        )
      )
    )
  }

  private scan(): Effect.Effect<{ intact: SessionSummary[]; damaged: string[] }, CoreError> {
    return this.root().pipe(
      Effect.flatMap((root) =>
        Effect.promise(() => readdir(root, { withFileTypes: true }).catch(() => []))
      ),
      Effect.flatMap((entries) =>
        Effect.forEach(
          entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
          (id) => this.read(id).pipe(Effect.map((session) => ({ id, session }))),
          { concurrency: 8 }
        )
      ),
      Effect.map((results) => ({
        intact: results
          .flatMap((result) => (result.session ? [result.session] : []))
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
        damaged: results.filter((result) => !result.session).map((result) => result.id)
      }))
    )
  }

  /**
   * Refuses loudly rather than defaulting to a directory nobody chose: a store
   * written somewhere unintended is worse than one that fails to be written,
   * because the person is never told.
   */
  private root(): Effect.Effect<string, CoreError> {
    return this.stateDirectory
      ? Effect.succeed(join(this.stateDirectory, SESSIONS_DIR))
      : Effect.fail(new CoreError('IO_ERROR', 'No app state directory is configured'))
  }
}

function parse(raw: string): SessionSummary | null {
  const parsed = z
    .string()
    .transform((text, ctx) => {
      try {
        return JSON.parse(text) as unknown
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not JSON' })
        return z.NEVER
      }
    })
    .pipe(recordSchema)
    .safeParse(raw)
  return parsed.success ? parsed.data : null
}
