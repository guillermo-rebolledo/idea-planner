import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { Effect } from 'effect'
import { CoreError } from '@shared/contract'
import { projectSchema, type Project, type ProjectView } from '@shared/project'

const STORE_FILE = 'projects.json'

/**
 * The app-owned store of Projects, in userData rather than in any repository.
 * It is the first piece of the store ADR 0002 describes; ticket 05 extends the
 * same directory to Sessions.
 *
 * Losing this file loses the list of Projects and nothing else. The work lives
 * in the repositories it points at, under git.
 */
export class ProjectStore {
  /** Serializes writes, so a read-modify-write can never interleave. */
  private readonly writeLock = Effect.runSync(Effect.makeSemaphore(1))

  constructor(
    private readonly stateDirectory: string | undefined,
    private readonly now: () => Date
  ) {}

  /**
   * Refuses loudly rather than defaulting to a directory nobody chose. A
   * Project list written somewhere unintended is worse than one that fails to
   * be written at all, because the user is never told.
   */
  private directory(): Effect.Effect<string, CoreError> {
    return this.stateDirectory
      ? Effect.succeed(this.stateDirectory)
      : Effect.fail(new CoreError('IO_ERROR', 'No app state directory is configured'))
  }

  add(root: string): Effect.Effect<ProjectView, CoreError> {
    return this.writeLock.withPermits(1)(
      Effect.gen(this, function* () {
        if (!isAbsolute(root)) {
          return yield* Effect.fail(
            new CoreError('INVALID_INPUT', 'A Project root must be an absolute path')
          )
        }
        const projects = yield* this.read()
        // Adding a Project already present is not an error and not an update:
        // the user asked for it to be there, and it is.
        const existing = projects.find((project) => project.root === root)
        if (existing) return yield* this.view(existing)

        const project: Project = {
          root,
          name: basename(root),
          addedAt: this.now().toISOString()
        }
        yield* this.write([...projects, project])
        return yield* this.view(project)
      })
    )
  }

  list(): Effect.Effect<ProjectView[], CoreError> {
    return this.read().pipe(
      Effect.flatMap((projects) => Effect.forEach(projects, (project) => this.view(project)))
    )
  }

  remove(root: string): Effect.Effect<void, CoreError> {
    return this.writeLock.withPermits(1)(
      this.read().pipe(
        Effect.flatMap((projects) =>
          this.write(projects.filter((project) => project.root !== root))
        )
      )
    )
  }

  /** Availability is observed, never stored. */
  private view(project: Project): Effect.Effect<ProjectView, CoreError> {
    return Effect.promise(() =>
      stat(project.root).then(
        (entry) => entry.isDirectory(),
        () => false
      )
    ).pipe(Effect.map((available) => ({ ...project, available })))
  }

  private read(): Effect.Effect<Project[], CoreError> {
    return this.directory().pipe(
      Effect.flatMap((directory) =>
        Effect.promise(() => readFile(join(directory, STORE_FILE), 'utf8').catch(() => '[]'))
      ),
      // No file yet is not a failure: it is an app that has never been given a
      // Project. A missing state directory is a failure, and stays one.
      Effect.flatMap((raw) =>
        Effect.try({
          try: () => projectSchema.array().parse(JSON.parse(raw)),
          catch: () => new CoreError('IO_ERROR', 'The Project list could not be read')
        })
      )
    )
  }

  private write(projects: Project[]): Effect.Effect<void, CoreError> {
    return this.directory().pipe(
      Effect.flatMap((directory) =>
        Effect.tryPromise({
          try: async () => {
            await mkdir(directory, { recursive: true })
            const path = join(directory, STORE_FILE)
            const staged = `${path}.staged`
            // Staged then renamed, so an interrupted write leaves the previous
            // list rather than half of the new one.
            await writeFile(staged, `${JSON.stringify(projects, null, 2)}\n`, 'utf8')
            await rename(staged, path).catch(async (error: unknown) => {
              await rm(staged, { force: true })
              throw error
            })
          },
          catch: () => new CoreError('IO_ERROR', 'The Project list could not be saved')
        })
      )
    )
  }
}
