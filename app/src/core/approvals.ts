import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import { CoreError } from '@shared/contract'
import {
  ruleText,
  standingApprovalSchema,
  type GrantStandingApprovalInput,
  type RevokeStandingApprovalInput,
  type StandingApproval
} from '@shared/approval'
import type { HarnessId } from '@shared/readiness'
import { writeJsonAtomic } from './atomic'

const STORE_FILE = 'standing-approvals.json'

/**
 * The app-owned store of Standing Approvals, in userData rather than in any
 * repository and never in the person's own Harness configuration (ADR 0003).
 *
 * Each approval names the Project it belongs to by the root git resolved, which
 * is what keeps two clones of one remote two separate grants: they are two
 * Projects, and a Project lends its permissions to nobody (ADR 0005).
 *
 * Losing this file loses permissions, which means the agent goes back to
 * asking. That is the right way round for a file that can be lost.
 */
export class StandingApprovalStore {
  /** Serializes writes, so a read-modify-write can never interleave. */
  private readonly writeLock = Effect.runSync(Effect.makeSemaphore(1))

  constructor(
    private readonly stateDirectory: string | undefined,
    private readonly now: () => Date,
    private readonly nextId: () => string
  ) {}

  private directory(): Effect.Effect<string, CoreError> {
    return this.stateDirectory
      ? Effect.succeed(this.stateDirectory)
      : Effect.fail(new CoreError('IO_ERROR', 'No app state directory is configured'))
  }

  grant(input: GrantStandingApprovalInput): Effect.Effect<StandingApproval, CoreError> {
    return this.writeLock.withPermits(1)(
      Effect.gen(this, function* () {
        const stored = yield* this.read()
        // Granting the same rule twice is one permission, not two. The person
        // said yes to a thing, and it is allowed.
        // One permission is one rule, whatever shape its Harness writes it in.
        const existing = stored.find(
          (entry) => entry.projectRoot === input.projectRoot && ruleText(entry) === ruleText(input)
        )
        if (existing) return existing
        const approval: StandingApproval = {
          ...input,
          id: this.nextId(),
          grantedAt: this.now().toISOString()
        }
        yield* this.write([...stored, approval])
        return approval
      })
    )
  }

  list(projectRoot: string): Effect.Effect<StandingApproval[], CoreError> {
    return this.read().pipe(
      Effect.map((stored) => stored.filter((entry) => entry.projectRoot === projectRoot))
    )
  }

  /**
   * What a Run in this Project is allowed to do without asking. Filtered by
   * Harness: a rule is written in one Harness's syntax, and handing it to
   * another is at best ignored and at worst means something else.
   */
  rules(projectRoot: string, harness: HarnessId): Effect.Effect<string[], CoreError> {
    return this.list(projectRoot).pipe(
      Effect.map((granted) =>
        granted.filter((entry) => entry.harness === harness).map((entry) => ruleText(entry))
      )
    )
  }

  /**
   * Revoking names the Project as well as the approval. An id is enough to
   * find one, but a revocation routed through the wrong Project is a sign the
   * caller has the wrong idea about what it is revoking.
   */
  revoke(input: RevokeStandingApprovalInput): Effect.Effect<void, CoreError> {
    return this.writeLock.withPermits(1)(
      Effect.gen(this, function* () {
        const stored = yield* this.read()
        const target = stored.find(
          (entry) => entry.id === input.id && entry.projectRoot === input.projectRoot
        )
        if (!target) {
          return yield* Effect.fail(
            new CoreError('INVALID_INPUT', 'That Standing Approval is not in this Project')
          )
        }
        yield* this.write(stored.filter((entry) => entry !== target))
      })
    )
  }

  /**
   * Forgets a Project's permissions along with the Project. Re-adding it starts
   * from asking again, which is the only honest reading of having removed it.
   */
  forgetProject(projectRoot: string): Effect.Effect<void, CoreError> {
    return this.writeLock.withPermits(1)(
      this.read().pipe(
        Effect.flatMap((stored) =>
          this.write(stored.filter((entry) => entry.projectRoot !== projectRoot))
        )
      )
    )
  }

  private read(): Effect.Effect<StandingApproval[], CoreError> {
    return this.directory().pipe(
      Effect.flatMap((directory) =>
        Effect.tryPromise({
          try: () =>
            readFile(join(directory, STORE_FILE), 'utf8').catch((error: unknown) => {
              // No file yet is an app nobody has granted anything, which is
              // every app until somebody does. Any other read failure is a
              // failure: answering "no permissions" would let the next grant
              // overwrite a store we could not read.
              if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return '[]'
              throw error
            }),
          catch: () => new CoreError('IO_ERROR', 'Your Standing Approvals could not be read')
        })
      ),
      Effect.flatMap((raw) =>
        Effect.try({
          try: () => standingApprovalSchema.array().parse(JSON.parse(raw)),
          catch: () => new CoreError('IO_ERROR', 'Your Standing Approvals could not be read')
        })
      )
    )
  }

  private write(approvals: StandingApproval[]): Effect.Effect<void, CoreError> {
    return this.directory().pipe(
      Effect.flatMap((directory) => writeJsonAtomic(join(directory, STORE_FILE), approvals))
    )
  }
}
