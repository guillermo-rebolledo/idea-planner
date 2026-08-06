import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Effect } from 'effect'
import { CoreError } from '@shared/contract'
import {
  projectDisplayName,
  projectSchema,
  type Project,
  type ProjectSkillsTrust,
  type ProjectView
} from '@shared/project'
import { writeJsonAtomic } from './atomic'

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
          name: projectDisplayName(root),
          addedAt: this.now().toISOString(),
          skillsTrustedAt: null,
          skillsTrustedDigest: null,
          skillsTrustedManifest: []
        }
        yield* this.write([...projects, project])
        return yield* this.view(project)
      })
    )
  }

  /**
   * Trusts, or stops trusting, this Project's own Skills. Revocable because
   * the repository it came from can change under it: what was trusted was a
   * set of Skills the person read, not the repository forever.
   */
  setSkillsTrusted(
    root: string,
    trust: ProjectSkillsTrust | null
  ): Effect.Effect<ProjectView, CoreError> {
    return this.writeLock.withPermits(1)(
      Effect.gen(this, function* () {
        const projects = yield* this.read()
        const project = projects.find((entry) => entry.root === root)
        if (!project) {
          return yield* Effect.fail(
            new CoreError('INVALID_INPUT', 'That Project has not been added')
          )
        }
        const updated: Project = {
          ...project,
          skillsTrustedAt: trust ? this.now().toISOString() : null,
          skillsTrustedDigest: trust?.digest ?? null,
          skillsTrustedManifest: trust?.manifest ?? []
        }
        yield* this.write(projects.map((entry) => (entry === project ? updated : entry)))
        return yield* this.view(updated)
      })
    )
  }

  /** Core owns whether one Main-observed digest still satisfies stored trust. */
  observeSkills(root: string, digest: string | null): Effect.Effect<ProjectView, CoreError> {
    return this.writeLock.withPermits(1)(
      Effect.gen(this, function* () {
        const projects = yield* this.read()
        const project = projects.find((entry) => entry.root === root)
        if (!project) {
          return yield* Effect.fail(
            new CoreError('INVALID_INPUT', 'That Project has not been added')
          )
        }
        if (
          project.skillsTrustedAt === null ||
          (digest !== null && project.skillsTrustedDigest === digest)
        ) {
          return yield* this.view(project)
        }
        const updated = { ...project, skillsTrustedAt: null }
        yield* this.write(projects.map((entry) => (entry === project ? updated : entry)))
        return yield* this.view(updated)
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
        Effect.tryPromise({
          try: () =>
            readFile(join(directory, STORE_FILE), 'utf8').catch((error: unknown) => {
              // No file yet is not a failure: it is an app that has never been
              // given a Project. Every other read failure is one, because
              // answering "no Projects" would let the next add overwrite a
              // store we could not read.
              if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return '[]'
              throw error
            }),
          catch: () => new CoreError('IO_ERROR', 'The Project list could not be read')
        })
      ),
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
      Effect.flatMap((directory) => writeJsonAtomic(join(directory, STORE_FILE), projects))
    )
  }
}
