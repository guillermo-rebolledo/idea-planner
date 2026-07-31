import { createHash } from 'node:crypto'
import { watch } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { inflateSync } from 'node:zlib'
import { Context, Effect, Layer, Ref } from 'effect'
import { decode as decodeJpeg } from 'jpeg-js'
import {
  CoreError,
  type ManagedDocument,
  type ManagedVersion,
  type ReconcileIdeaInput,
  type ReconciledDocument,
  type ReconciliationReason,
  type ReconciliationState,
  type ReferenceActionInput,
  type ResolveManagedConflictInput,
  type ResolveDuplicateManagedDocumentInput,
  type ReferenceAttachment,
  type RestoreManagedVersionInput
} from '@shared/contract'

export interface ReferenceContext {
  id: string
  files: { referenceId: string; path: string }[]
  missing: {
    referenceId: string
    safeName: string
    choices: ['locate-image', 'continue-without']
  }[]
}

interface RecoveryFile {
  documents: {
    root: { id: string; path: string }
    planningIndex: { id: string; path: string }
    conversation: { id: string; path: string }
  }
}

interface ReconciliationFile {
  documents: Record<string, ReconciledDocument>
  history: ManagedVersion[]
}

interface ReferenceFile {
  references: ReferenceAttachment[]
}

interface ExternalContentOptions {
  library: Effect.Effect<string | null>
  observeManagedPaths?: (
    paths: string[],
    onHint: (reason: ReconciliationReason) => void
  ) => (() => void) | undefined
  clock: Effect.Effect<Date>
  nextReferenceId: Effect.Effect<string>
}

interface ExternalContentNodeService {
  readonly exists: (path: string) => Effect.Effect<boolean, CoreError>
  readonly readJson: <A>(path: string) => Effect.Effect<A | null, CoreError>
  readonly writeJsonAtomic: (path: string, value: unknown) => Effect.Effect<void, CoreError>
  readonly scanIdentities: (ideaDir: string) => Effect.Effect<IdentityScan, CoreError>
  readonly readStableUtf8: (path: string) => Effect.Effect<string, CoreError>
  readonly staysInside: (path: string, root: string) => Effect.Effect<boolean, CoreError>
  readonly persistVersion: (
    ideaDir: string,
    documentId: string,
    version: number,
    content: string
  ) => Effect.Effect<void, CoreError>
  readonly copyFile: (source: string, target: string) => Effect.Effect<void, CoreError>
  readonly rename: (source: string, target: string) => Effect.Effect<void, CoreError>
  readonly realpathOrNull: (path: string) => Effect.Effect<string | null, CoreError>
  readonly resolvePaths: (
    root: string,
    paths: string[]
  ) => Effect.Effect<{ path: string; absolute: string }[], CoreError>
  readonly mkdir: (path: string, mode?: number) => Effect.Effect<void, CoreError>
  readonly readFileOrNull: (path: string) => Effect.Effect<Buffer | null, CoreError>
  readonly writeText: (path: string, content: string) => Effect.Effect<void, CoreError>
  readonly writePrivateBytes: (path: string, bytes: Buffer) => Effect.Effect<void, CoreError>
  readonly writeExclusiveBytes: (path: string, bytes: Buffer) => Effect.Effect<void, CoreError>
  readonly remove: (path: string) => Effect.Effect<void, CoreError>
  readonly removeAll: (paths: string[]) => Effect.Effect<void, CoreError>
  readonly cleanupRunContexts: (ideaDir: string) => Effect.Effect<void, CoreError>
  readonly now: Effect.Effect<Date>
  readonly nextId: Effect.Effect<string>
  readonly schedule: (delayMs: number, task: () => void) => Effect.Effect<NodeJS.Timeout>
  readonly cancelTimer: (timer: NodeJS.Timeout) => Effect.Effect<void>
  readonly observe: (
    paths: string[],
    onHint: (reason: ReconciliationReason) => void
  ) => Effect.Effect<(() => void) | undefined, CoreError>
}

interface IdentityScan {
  paths: Map<string, string>
  duplicates: ReconciliationState['duplicateCandidates']
  syncCopyAmbiguous: boolean
  unsafe: boolean
}

class ExternalContentNode extends Context.Tag('core/ExternalContentNode')<
  ExternalContentNode,
  ExternalContentNodeService
>() {}

/**
 * Unexported Node adapter. Its promises are the foreign-API boundary consumed
 * by the Effect-native service below; no Promise escapes into Core behavior.
 * Mutable product state remains in Ref, while watcher handles stay private to
 * the adapter that acquires and closes them.
 */
class ExternalContentManager {
  private readonly observedIdeas = Effect.runSync(Ref.make(new Set<string>()))
  private readonly referenceContexts = Effect.runSync(Ref.make(new Map<string, string>()))
  private readonly locatedIdeas = Effect.runSync(Ref.make(new Map<string, string>()))
  private readonly knownIdeaIds = Effect.runSync(Ref.make(new Map<string, string>()))
  private readonly latestStates = Effect.runSync(Ref.make(new Map<string, ReconciliationState>()))
  private readonly activeRuns = Effect.runSync(
    Ref.make(new Map<string, ReconcileIdeaInput['activeRun']>())
  )
  private readonly observationDisposers = Effect.runSync(Ref.make(new Map<string, () => void>()))
  private readonly hintTimers = Effect.runSync(Ref.make(new Map<string, NodeJS.Timeout>()))

  constructor(
    private readonly options: ExternalContentOptions,
    private readonly nodeLayer: Layer.Layer<ExternalContentNode>
  ) {}

  private node<A>(
    operation: (node: ExternalContentNodeService) => Effect.Effect<A, CoreError>
  ): Effect.Effect<A, CoreError, ExternalContentNode> {
    return ExternalContentNode.pipe(Effect.flatMap(operation))
  }

  reconcile(
    input: ReconcileIdeaInput
  ): Effect.Effect<ReconciliationState, CoreError, ExternalContentNode> {
    return Effect.gen(this, function* () {
      const ideaDir = yield* this.ideaDir(input.relativePath)
      if (input.activeRun) {
        yield* updateMap(this.activeRuns, input.relativePath, input.activeRun)
      }
      if (!(yield* this.node((node) => node.exists(ideaDir)))) {
        return yield* this.rememberState(
          input.relativePath,
          emptyState(input.reason === 'missing-volume' ? 'offline' : 'location-missing', 'locate')
        )
      }
      const registeredRun = (yield* Ref.get(this.activeRuns)).get(input.relativePath)
      if (input.reason === 'opened' && !input.activeRun && !registeredRun) {
        yield* this.node((node) => node.cleanupRunContexts(ideaDir))
      }

      const recovery = yield* this.node((node) =>
        node.readJson<RecoveryFile>(join(ideaDir, '.idea', 'recovery.json'))
      )
      if (!recovery)
        return yield* this.rememberState(
          input.relativePath,
          emptyState('location-missing', 'locate')
        )
      yield* updateMap(this.knownIdeaIds, input.relativePath, recovery.documents.root.id)
      const expected = Object.entries(recovery.documents).map(([kind, document]) => ({
        id: document.id,
        kind: normalizedKind(kind),
        path: document.path
      }))
      const identityScan = yield* this.node((node) => node.scanIdentities(ideaDir))
      if (identityScan.unsafe)
        return yield* this.rememberState(input.relativePath, emptyState('unsafe-path'))
      if (identityScan.syncCopyAmbiguous)
        return yield* this.rememberState(
          input.relativePath,
          emptyState('sync-copy-ambiguous', null, identityScan.duplicates)
        )
      if (identityScan.duplicates.length > 0)
        return yield* this.rememberState(
          input.relativePath,
          emptyState('duplicate-identity', null, identityScan.duplicates)
        )

      const documents = expected.map((document) => ({
        ...document,
        path: identityScan.paths.get(document.id) ?? document.path
      }))
      if (documents.some((document) => !identityScan.paths.has(document.id))) {
        return yield* this.rememberState(
          input.relativePath,
          emptyState('location-missing', 'locate')
        )
      }

      const absolutePaths = documents.map((document) => join(ideaDir, document.path))
      const observed = yield* Ref.get(this.observedIdeas)
      if (!observed.has(ideaDir)) {
        yield* updateSet(this.observedIdeas, ideaDir, true)
        const node = yield* ExternalContentNode
        const handleHint = (reason: ReconciliationReason): void => {
          const watcherProgram = Effect.gen(this, function* () {
            const priorTimer = (yield* Ref.get(this.hintTimers)).get(input.relativePath)
            if (priorTimer) yield* node.cancelTimer(priorTimer)
            const timer = yield* node.schedule(30, () => {
              const reconcileProgram = Effect.gen(this, function* () {
                yield* deleteMap(this.hintTimers, input.relativePath)
                if (reason === 'atomic-replacement' || reason === 'overflow') {
                  ;(yield* Ref.get(this.observationDisposers)).get(ideaDir)?.()
                  yield* deleteMap(this.observationDisposers, ideaDir)
                  yield* updateSet(this.observedIdeas, ideaDir, false)
                }
                const activeRun = (yield* Ref.get(this.activeRuns)).get(input.relativePath)
                yield* this.reconcile({ relativePath: input.relativePath, reason, activeRun }).pipe(
                  Effect.catchAll((error) =>
                    error.code === 'IO_ERROR'
                      ? node
                          .schedule(120, () => handleHint(reason))
                          .pipe(
                            Effect.tap((timer) =>
                              updateMap(this.hintTimers, input.relativePath, timer)
                            ),
                            Effect.asVoid
                          )
                      : Effect.void
                  )
                )
              })
              Effect.runFork(reconcileProgram.pipe(Effect.provide(this.nodeLayer)))
            })
            yield* updateMap(this.hintTimers, input.relativePath, timer)
          })
          Effect.runFork(watcherProgram.pipe(Effect.provide(this.nodeLayer)))
        }
        const dispose = yield* node.observe(absolutePaths, handleHint)
        if (dispose) yield* updateMap(this.observationDisposers, ideaDir, dispose)
      }
      for (const path of absolutePaths) {
        if (!(yield* this.node((node) => node.staysInside(path, ideaDir))))
          return yield* this.rememberState(input.relativePath, emptyState('unsafe-path'))
      }

      const statePath = join(ideaDir, '.idea', 'reconciliation.json')
      const prior: ReconciliationFile = (yield* this.node((node) =>
        node.readJson<ReconciliationFile>(statePath)
      )) ?? {
        documents: {},
        history: []
      }
      const next: ReconciliationFile = { documents: {}, history: [...prior.history] }
      const contents = new Map<string, string>()
      let changed = false
      for (const document of documents) {
        const content = yield* this.node((node) =>
          node.readStableUtf8(join(ideaDir, document.path))
        )
        const hash = sha256(content)
        const previous = prior.documents[document.id]
        const version = previous ? previous.version + Number(previous.hash !== hash) : 1
        if (previous?.hash !== hash) {
          changed ||= Boolean(previous)
          yield* this.node((node) => node.persistVersion(ideaDir, document.id, version, content))
          next.history.push({
            documentId: document.id,
            version,
            hash,
            createdAt: (yield* (yield* ExternalContentNode).now).toISOString()
          })
        }
        next.documents[document.id] = { ...document, hash, version }
        contents.set(document.id, content)
      }
      yield* this.node((node) => node.writeJsonAtomic(statePath, next))

      const conflicts = (input.activeRun?.documents ?? []).flatMap((candidate) => {
        const current = next.documents[candidate.id]
        if (!current || current.hash === candidate.baselineHash) return []
        return [
          {
            documentId: candidate.id,
            disk: contents.get(candidate.id) ?? '',
            aiDraft: candidate.aiDraft,
            choices: ['keep-disk', 'keep-ai-draft'] as ['keep-disk', 'keep-ai-draft']
          }
        ]
      })
      return yield* this.rememberState(input.relativePath, {
        status: conflicts.length > 0 ? 'conflict' : changed ? 'changed' : 'ready',
        documents: Object.values(next.documents),
        history: next.history,
        conflicts,
        pausedRunId: conflicts.length > 0 ? (input.activeRun?.id ?? null) : null,
        recoveryAction: null,
        duplicateCandidates: []
      })
    })
  }

  latestState(relativePath: string): Effect.Effect<ReconciliationState | null> {
    return Ref.get(this.latestStates).pipe(Effect.map((states) => states.get(relativePath) ?? null))
  }

  private rememberState(
    relativePath: string,
    state: ReconciliationState
  ): Effect.Effect<ReconciliationState> {
    return updateMap(this.latestStates, relativePath, state).pipe(Effect.as(state))
  }

  resolveIdeaDirectory(relativePath: string): Effect.Effect<string, CoreError> {
    return this.ideaDir(relativePath)
  }

  locateIdea(
    relativePath: string,
    selectedDirectory: string,
    expectedIdeaId?: string
  ): Effect.Effect<ReconciliationState, CoreError, ExternalContentNode> {
    return Effect.gen(this, function* () {
      const library = yield* this.options.library
      if (!library)
        return yield* Effect.fail(new CoreError('NO_LIBRARY_OPEN', 'Open an Idea Library first'))
      const previousDirectory =
        (yield* Ref.get(this.locatedIdeas)).get(relativePath) ?? join(library, relativePath)
      const previousRecovery = yield* this.node((node) =>
        node.readJson<RecoveryFile>(join(previousDirectory, '.idea', 'recovery.json'))
      )
      const selectedRecovery = yield* this.node((node) =>
        node.readJson<RecoveryFile>(join(selectedDirectory, '.idea', 'recovery.json'))
      )
      const expectedRootId =
        expectedIdeaId ??
        previousRecovery?.documents.root.id ??
        (yield* Ref.get(this.knownIdeaIds)).get(relativePath)
      if (
        !selectedRecovery ||
        !expectedRootId ||
        selectedRecovery.documents.root.id !== expectedRootId
      ) {
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', 'The selected folder belongs to a different Idea')
        )
      }
      ;(yield* Ref.get(this.observationDisposers)).get(previousDirectory)?.()
      yield* deleteMap(this.observationDisposers, previousDirectory)
      yield* updateSet(this.observedIdeas, previousDirectory, false)
      yield* updateMap(this.locatedIdeas, relativePath, selectedDirectory)
      return yield* this.reconcile({ relativePath, reason: 'opened' })
    })
  }

  restore(
    input: RestoreManagedVersionInput
  ): Effect.Effect<ReconciliationState, CoreError, ExternalContentNode> {
    return Effect.gen(this, function* () {
      const ideaDir = yield* this.ideaDir(input.relativePath)
      const state = yield* this.node((node) =>
        node.readJson<ReconciliationFile>(join(ideaDir, '.idea', 'reconciliation.json'))
      )
      const document = state?.documents[input.documentId]
      if (!document)
        return yield* Effect.fail(new CoreError('INVALID_INPUT', 'Unknown managed document'))
      const snapshot = versionPath(ideaDir, input.documentId, input.version)
      if (!(yield* this.node((node) => node.exists(snapshot))))
        return yield* Effect.fail(new CoreError('INVALID_INPUT', 'Unknown managed version'))
      const staged = `${join(ideaDir, document.path)}.restore-staged`
      yield* this.node((node) => node.copyFile(snapshot, staged))
      yield* this.node((node) => node.rename(staged, join(ideaDir, document.path)))
      return yield* this.reconcile({ relativePath: input.relativePath, reason: 'changed' })
    })
  }

  resolveConflict(
    input: ResolveManagedConflictInput
  ): Effect.Effect<ReconciliationState, CoreError, ExternalContentNode> {
    return Effect.gen(this, function* () {
      yield* deleteMap(this.activeRuns, input.relativePath)
      if (input.choice === 'keep-disk') {
        return yield* this.reconcile({ relativePath: input.relativePath, reason: 'changed' })
      }
      if (input.aiDraft === undefined) {
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', 'The AI draft is required for this choice')
        )
      }
      const aiDraft = input.aiDraft
      const ideaDir = yield* this.ideaDir(input.relativePath)
      const state = yield* this.node((node) =>
        node.readJson<ReconciliationFile>(join(ideaDir, '.idea', 'reconciliation.json'))
      )
      const document = state?.documents[input.documentId]
      if (!document)
        return yield* Effect.fail(new CoreError('INVALID_INPUT', 'Unknown managed document'))
      const target = join(ideaDir, document.path)
      const staged = `${target}.conflict-staged`
      yield* this.node((node) => node.writeText(staged, aiDraft))
      yield* this.node((node) => node.rename(staged, target))
      return yield* this.reconcile({ relativePath: input.relativePath, reason: 'changed' })
    })
  }

  resolveDuplicate(
    input: ResolveDuplicateManagedDocumentInput
  ): Effect.Effect<ReconciliationState, CoreError, ExternalContentNode> {
    return Effect.gen(this, function* () {
      const ideaDir = yield* this.ideaDir(input.relativePath)
      const scan = yield* this.node((node) => node.scanIdentities(ideaDir))
      const duplicate = scan.duplicates.find((entry) => entry.documentId === input.documentId)
      if (!duplicate)
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', 'The duplicate is no longer present')
        )
      const selectedAbsolute = yield* this.node((node) => node.realpathOrNull(input.selectedPath))
      const candidates = yield* this.node((node) => node.resolvePaths(ideaDir, duplicate.paths))
      if (
        !selectedAbsolute ||
        !candidates.some((candidate) => candidate.absolute === selectedAbsolute)
      ) {
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', 'Choose one of the listed managed copies')
        )
      }
      const recoveryDir = join(ideaDir, '.idea', 'recovery', 'duplicate-content')
      yield* this.node((node) => node.mkdir(recoveryDir))
      for (const candidate of candidates) {
        if (candidate.absolute === selectedAbsolute) continue
        const target = join(
          recoveryDir,
          `${(yield* (yield* ExternalContentNode).now).getTime()}-${sha256(candidate.path).slice(0, 10)}-${basename(candidate.path)}`
        )
        yield* this.node((node) => node.rename(candidate.absolute, target))
      }
      return yield* this.reconcile({ relativePath: input.relativePath, reason: 'changed' })
    })
  }

  endRun(relativePath: string, runId: string): Effect.Effect<void, CoreError, ExternalContentNode> {
    return Effect.gen(this, function* () {
      const runs = yield* Ref.get(this.activeRuns)
      if (runs.get(relativePath)?.id === runId) yield* deleteMap(this.activeRuns, relativePath)
      yield* this.removeReferenceContext(`reference-context-${runId}`)
    })
  }

  addReference(input: {
    relativePath: string
    messageId: string
    sourcePath: string
  }): Effect.Effect<ReferenceAttachment, CoreError, ExternalContentNode> {
    return Effect.gen(this, function* () {
      const ideaDir = yield* this.ideaDir(input.relativePath)
      const source = yield* this.node((node) => node.readFileOrNull(input.sourcePath))
      if (!source)
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', 'The selected image is unavailable')
        )
      const mediaType = yield* parseImage(() => imageType(source))
      yield* parseImage(() => sanitizeImage(source, mediaType))
      const file = yield* this.readReferences(ideaDir)
      const reference: ReferenceAttachment = {
        id: yield* (yield* ExternalContentNode).nextId,
        messageId: input.messageId,
        sourcePath: input.sourcePath,
        safeName: safeImageName(basename(input.sourcePath), mediaType),
        sourceHash: sha256(source),
        mediaType,
        durablePath: null,
        omitted: false
      }
      file.references.push(reference)
      yield* this.writeReferences(ideaDir, file)
      return reference
    })
  }

  listReferences(
    relativePath: string
  ): Effect.Effect<ReferenceAttachment[], CoreError, ExternalContentNode> {
    return this.ideaDir(relativePath).pipe(
      Effect.flatMap((ideaDir) => this.readReferences(ideaDir)),
      Effect.map((file) => file.references)
    )
  }

  prepareReferences(input: {
    relativePath: string
    runId: string
    referenceIds: string[]
  }): Effect.Effect<ReferenceContext, CoreError, ExternalContentNode> {
    return Effect.gen(this, function* () {
      const ideaDir = yield* this.ideaDir(input.relativePath)
      const file = yield* this.readReferences(ideaDir)
      const contextId = `reference-context-${input.runId}`
      const contextDir = join(ideaDir, '.idea', 'runs', input.runId, 'references')
      const result: ReferenceContext = { id: contextId, files: [], missing: [] }
      yield* updateMap(this.referenceContexts, contextId, contextDir)
      for (const referenceId of input.referenceIds) {
        const reference = file.references.find((entry) => entry.id === referenceId)
        if (!reference || reference.omitted) continue
        const sourcePath = reference.durablePath
          ? join(ideaDir, reference.durablePath)
          : reference.sourcePath
        const source = yield* this.node((node) => node.readFileOrNull(sourcePath))
        if (!source) {
          result.missing.push({
            referenceId,
            safeName: reference.safeName,
            choices: ['locate-image', 'continue-without']
          })
          continue
        }
        const sanitized = yield* parseImage(() => sanitizeImage(source, reference.mediaType))
        const target = join(contextDir, `${reference.id}-${reference.safeName}`)
        yield* this.node((node) => node.mkdir(dirname(target), 0o700))
        yield* this.node((node) => node.writePrivateBytes(target, sanitized))
        result.files.push({ referenceId, path: target })
      }
      return result
    })
  }

  removeReferenceContext(contextId: string): Effect.Effect<void, CoreError, ExternalContentNode> {
    return Effect.gen(this, function* () {
      const runId = contextId.startsWith('reference-context-')
        ? contextId.slice('reference-context-'.length)
        : null
      if (runId) {
        const activeRuns = yield* Ref.get(this.activeRuns)
        for (const [relativePath, activeRun] of activeRuns) {
          if (activeRun?.id === runId) yield* deleteMap(this.activeRuns, relativePath)
        }
      }
      const contextDir = (yield* Ref.get(this.referenceContexts)).get(contextId)
      if (!contextDir) return
      yield* deleteMap(this.referenceContexts, contextId)
      yield* this.node((node) => node.remove(contextDir))
    })
  }

  keepReference(
    input: ReferenceActionInput
  ): Effect.Effect<ReferenceAttachment, CoreError, ExternalContentNode> {
    return Effect.gen(this, function* () {
      const ideaDir = yield* this.ideaDir(input.relativePath)
      const file = yield* this.readReferences(ideaDir)
      const index = file.references.findIndex((entry) => entry.id === input.referenceId)
      const reference = file.references[index]
      if (!reference)
        return yield* Effect.fail(new CoreError('INVALID_INPUT', 'Unknown Reference Attachment'))
      const source = yield* this.node((node) => node.readFileOrNull(reference.sourcePath))
      if (!source)
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', 'Locate the image before keeping it')
        )
      const sanitized = yield* parseImage(() => sanitizeImage(source, reference.mediaType))
      const extension = reference.mediaType === 'image/png' ? '.png' : '.jpg'
      const durablePath = `assets/${sha256(sanitized)}${extension}`
      yield* this.node((node) => node.mkdir(join(ideaDir, 'assets')))
      yield* this.node((node) => node.writeExclusiveBytes(join(ideaDir, durablePath), sanitized))
      const kept = { ...reference, durablePath }
      file.references[index] = kept
      yield* this.writeReferences(ideaDir, file)
      return kept
    })
  }

  locateReference(input: {
    relativePath: string
    referenceId: string
    sourcePath: string
  }): Effect.Effect<ReferenceAttachment, CoreError, ExternalContentNode> {
    return Effect.gen(this, function* () {
      const ideaDir = yield* this.ideaDir(input.relativePath)
      const file = yield* this.readReferences(ideaDir)
      const index = file.references.findIndex((entry) => entry.id === input.referenceId)
      const reference = file.references[index]
      if (!reference)
        return yield* Effect.fail(new CoreError('INVALID_INPUT', 'Unknown Reference Attachment'))
      const source = yield* this.node((node) => node.readFileOrNull(input.sourcePath))
      if (!source)
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', 'The selected image is unavailable')
        )
      const mediaType = yield* parseImage(() => imageType(source))
      yield* parseImage(() => sanitizeImage(source, mediaType))
      const located: ReferenceAttachment = {
        ...reference,
        sourcePath: input.sourcePath,
        sourceHash: sha256(source),
        mediaType,
        safeName: safeImageName(basename(input.sourcePath), mediaType),
        omitted: false
      }
      file.references[index] = located
      yield* this.writeReferences(ideaDir, file)
      return located
    })
  }

  continueWithoutReference(
    input: ReferenceActionInput
  ): Effect.Effect<void, CoreError, ExternalContentNode> {
    return Effect.gen(this, function* () {
      const ideaDir = yield* this.ideaDir(input.relativePath)
      const file = yield* this.readReferences(ideaDir)
      const index = file.references.findIndex((entry) => entry.id === input.referenceId)
      const reference = file.references[index]
      if (!reference)
        return yield* Effect.fail(new CoreError('INVALID_INPUT', 'Unknown Reference Attachment'))
      file.references[index] = { ...reference, omitted: true }
      yield* this.writeReferences(ideaDir, file)
    })
  }

  shutdown(): Effect.Effect<void, CoreError, ExternalContentNode> {
    return Effect.gen(this, function* () {
      const node = yield* ExternalContentNode
      for (const timer of (yield* Ref.get(this.hintTimers)).values()) yield* node.cancelTimer(timer)
      for (const dispose of (yield* Ref.get(this.observationDisposers)).values()) dispose()
      const contexts = [...(yield* Ref.get(this.referenceContexts)).values()]
      yield* this.node((node) => node.removeAll(contexts))
      yield* Ref.set(this.hintTimers, new Map())
      yield* Ref.set(this.observationDisposers, new Map())
      yield* Ref.set(this.referenceContexts, new Map())
      yield* Ref.set(this.observedIdeas, new Set())
    })
  }

  resetForLibraryChange(): Effect.Effect<void, CoreError, ExternalContentNode> {
    return Effect.gen(this, function* () {
      const node = yield* ExternalContentNode
      for (const timer of (yield* Ref.get(this.hintTimers)).values()) yield* node.cancelTimer(timer)
      for (const dispose of (yield* Ref.get(this.observationDisposers)).values()) dispose()
      yield* node.removeAll([...(yield* Ref.get(this.referenceContexts)).values()])
      yield* Ref.set(this.hintTimers, new Map())
      yield* Ref.set(this.observationDisposers, new Map())
      yield* Ref.set(this.observedIdeas, new Set())
      yield* Ref.set(this.locatedIdeas, new Map())
      yield* Ref.set(this.knownIdeaIds, new Map())
      yield* Ref.set(this.latestStates, new Map())
      yield* Ref.set(this.activeRuns, new Map())
      yield* Ref.set(this.referenceContexts, new Map())
    })
  }

  private ideaDir(relativePath: string): Effect.Effect<string, CoreError> {
    return Effect.gen(this, function* () {
      const library = yield* this.options.library
      if (!library)
        return yield* Effect.fail(new CoreError('NO_LIBRARY_OPEN', 'Open an Idea Library first'))
      if (
        relativePath === '.' ||
        relativePath === '..' ||
        relativePath.includes('/') ||
        relativePath.includes('\\')
      ) {
        return yield* Effect.fail(
          new CoreError('INVALID_INPUT', 'The Idea reference is not portable')
        )
      }
      return (yield* Ref.get(this.locatedIdeas)).get(relativePath) ?? join(library, relativePath)
    })
  }

  private readReferences(
    ideaDir: string
  ): Effect.Effect<ReferenceFile, CoreError, ExternalContentNode> {
    return this.node((node) =>
      node.readJson<ReferenceFile>(join(ideaDir, '.idea', 'references.json'))
    ).pipe(Effect.map((file) => file ?? { references: [] }))
  }

  private writeReferences(
    ideaDir: string,
    file: ReferenceFile
  ): Effect.Effect<void, CoreError, ExternalContentNode> {
    return this.node((node) =>
      node.writeJsonAtomic(join(ideaDir, '.idea', 'references.json'), file)
    )
  }
}

export function createExternalContentEffects(options: ExternalContentOptions) {
  const toCoreError = (error: unknown): CoreError =>
    error instanceof CoreError
      ? error
      : new CoreError('IO_ERROR', error instanceof Error ? error.message : 'Filesystem error')
  const promise = <A>(operation: () => Promise<A>): Effect.Effect<A, CoreError> =>
    Effect.tryPromise({ try: operation, catch: toCoreError })
  const nodeLayer = Layer.succeed(ExternalContentNode, {
    exists: (path) => promise(() => exists(path)),
    readJson: <A>(path: string) => promise(() => readJson<A>(path)),
    writeJsonAtomic: (path, value) => promise(() => writeJsonAtomic(path, value)),
    scanIdentities: (ideaDir) => promise(() => scanIdentities(ideaDir)),
    readStableUtf8: (path) => promise(() => readStableUtf8(path)),
    staysInside: (path, root) => promise(() => staysInside(path, root)),
    persistVersion: (ideaDir, documentId, version, content) =>
      promise(() => persistVersion(ideaDir, documentId, version, content)),
    copyFile: (source, target) => promise(() => copyFile(source, target)),
    rename: (source, target) => promise(() => rename(source, target)),
    realpathOrNull: (path) => promise(() => realpath(path).catch(() => null)),
    resolvePaths: (root, paths) =>
      promise(() =>
        Promise.all(
          paths.map(async (path) => ({ path, absolute: await realpath(join(root, path)) }))
        )
      ),
    mkdir: (path, mode) =>
      promise(() => mkdir(path, { recursive: true, ...(mode === undefined ? {} : { mode }) })).pipe(
        Effect.asVoid
      ),
    readFileOrNull: (path) => promise(() => readFile(path).catch(() => null)),
    writeText: (path, content) => promise(() => writeFile(path, content)),
    writePrivateBytes: (path, bytes) => promise(() => writeFile(path, bytes, { mode: 0o600 })),
    writeExclusiveBytes: (path, bytes) =>
      promise(() =>
        writeFile(path, bytes, { flag: 'wx' }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        })
      ),
    remove: (path) => promise(() => rm(path, { recursive: true, force: true })),
    removeAll: (paths) =>
      promise(() =>
        Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })))
      ).pipe(Effect.asVoid),
    cleanupRunContexts: (ideaDir) =>
      promise(() => rm(join(ideaDir, '.idea', 'runs'), { recursive: true, force: true })),
    now: options.clock,
    nextId: options.nextReferenceId,
    schedule: (delayMs, task) => Effect.sync(() => setTimeout(task, delayMs)),
    cancelTimer: (timer) => Effect.sync(() => clearTimeout(timer)),
    observe: (paths, onHint) =>
      Effect.try({
        try: () => (options.observeManagedPaths ?? observeExactPaths)(paths, onHint),
        catch: toCoreError
      })
  })
  const manager = new ExternalContentManager(options, nodeLayer)
  const provideNode = <A>(
    program: Effect.Effect<A, CoreError, ExternalContentNode>
  ): Effect.Effect<A, CoreError> => program.pipe(Effect.provide(nodeLayer))
  return {
    reconcile: (input: ReconcileIdeaInput) => provideNode(manager.reconcile(input)),
    latestState: (relativePath: string) => manager.latestState(relativePath),
    locateIdea: (relativePath: string, selectedDirectory: string, expectedIdeaId?: string) =>
      provideNode(manager.locateIdea(relativePath, selectedDirectory, expectedIdeaId)),
    resolveIdeaDirectory: (relativePath: string) => manager.resolveIdeaDirectory(relativePath),
    restore: (input: RestoreManagedVersionInput) => provideNode(manager.restore(input)),
    resolveConflict: (input: ResolveManagedConflictInput) =>
      provideNode(manager.resolveConflict(input)),
    resolveDuplicate: (input: ResolveDuplicateManagedDocumentInput) =>
      provideNode(manager.resolveDuplicate(input)),
    endRun: (relativePath: string, runId: string) =>
      provideNode(manager.endRun(relativePath, runId)),
    addReference: (input: { relativePath: string; messageId: string; sourcePath: string }) =>
      provideNode(manager.addReference(input)),
    listReferences: (relativePath: string) => provideNode(manager.listReferences(relativePath)),
    prepareReferences: (input: { relativePath: string; runId: string; referenceIds: string[] }) =>
      provideNode(manager.prepareReferences(input)),
    removeReferenceContext: (contextId: string) =>
      provideNode(manager.removeReferenceContext(contextId)),
    keepReference: (input: ReferenceActionInput) => provideNode(manager.keepReference(input)),
    locateReference: (input: { relativePath: string; referenceId: string; sourcePath: string }) =>
      provideNode(manager.locateReference(input)),
    continueWithoutReference: (input: ReferenceActionInput) =>
      provideNode(manager.continueWithoutReference(input)),
    resetForLibraryChange: provideNode(manager.resetForLibraryChange()),
    shutdown: provideNode(manager.shutdown())
  }
}

export interface ExactPathWatcher {
  on(event: 'error', listener: () => void): ExactPathWatcher
  close(): void
}

export type ExactPathWatch = (
  path: string,
  options: { persistent: false },
  listener: (eventType: string) => void
) => ExactPathWatcher

export function observeExactPaths(
  paths: string[],
  onHint: (reason: ReconciliationReason) => void,
  watchPath: ExactPathWatch = watch
): () => void {
  const watchers = paths.map((path) =>
    watchPath(path, { persistent: false }, (eventType) =>
      onHint(eventType === 'rename' ? 'atomic-replacement' : 'changed')
    )
  )
  watchers.forEach((watcher) => watcher.on('error', () => onHint('overflow')))
  const volumeProbe = setInterval(() => {
    void Promise.all(paths.map((path) => stat(path))).catch(() => onHint('missing-volume'))
  }, 2_000)
  volumeProbe.unref()
  return () => {
    clearInterval(volumeProbe)
    watchers.forEach((watcher) => watcher.close())
  }
}

function updateMap<K, V>(ref: Ref.Ref<Map<K, V>>, key: K, value: V): Effect.Effect<void> {
  return Ref.update(ref, (current) => new Map(current).set(key, value))
}

function deleteMap<K, V>(ref: Ref.Ref<Map<K, V>>, key: K): Effect.Effect<void> {
  return Ref.update(ref, (current) => {
    const next = new Map(current)
    next.delete(key)
    return next
  })
}

function updateSet<A>(ref: Ref.Ref<Set<A>>, value: A, present: boolean): Effect.Effect<void> {
  return Ref.update(ref, (current) => {
    const next = new Set(current)
    if (present) next.add(value)
    else next.delete(value)
    return next
  })
}

function parseImage<A>(operation: () => A): Effect.Effect<A, CoreError> {
  return Effect.try({
    try: operation,
    catch: (error) =>
      error instanceof CoreError ? error : new CoreError('INVALID_INPUT', 'The image is invalid')
  })
}

function emptyState(
  status: ReconciliationState['status'],
  recoveryAction: ReconciliationState['recoveryAction'] = null,
  duplicateCandidates: ReconciliationState['duplicateCandidates'] = []
): ReconciliationState {
  return {
    status,
    documents: [],
    history: [],
    conflicts: [],
    pausedRunId: null,
    recoveryAction,
    duplicateCandidates
  }
}

async function scanIdentities(ideaDir: string): Promise<{
  paths: Map<string, string>
  duplicates: ReconciliationState['duplicateCandidates']
  syncCopyAmbiguous: boolean
  unsafe: boolean
}> {
  const paths = new Map<string, string>()
  const candidates = new Map<string, string[]>()
  let unsafe = false
  async function walk(prefix = ''): Promise<void> {
    const entries = await readdir(join(ideaDir, prefix), { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.idea' || entry.name === 'assets') continue
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(ideaDir, path)
      if (entry.isSymbolicLink()) {
        unsafe = true
        continue
      }
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const raw = await readFile(absolute, 'utf8')
        const id = frontmatterIdentity(raw)
        if (!id) continue
        const priorPath = paths.get(id)
        if (priorPath) {
          candidates.set(id, [...(candidates.get(id) ?? [priorPath]), path])
        } else paths.set(id, path)
      }
    }
  }
  await walk()
  const duplicates = [...candidates].map(([documentId, duplicatePaths]) => ({
    documentId,
    paths: [...new Set(duplicatePaths)]
  }))
  const syncCopyAmbiguous = duplicates.some((duplicate) =>
    duplicate.paths.some((path) => /sync[-_. ]?conflict/i.test(path))
  )
  return { paths, duplicates, syncCopyAmbiguous, unsafe }
}

function frontmatterIdentity(raw: string): string | null {
  if (!raw.startsWith('---\n')) return null
  const end = raw.indexOf('\n---\n', 4)
  if (end < 0) return null
  for (const line of raw.slice(4, end).split('\n')) {
    const match = /^(?:document_id|id):\s*(.+)$/.exec(line)
    if (match?.[1]) return match[1].trim()
  }
  return null
}

function normalizedKind(kind: string): ManagedDocument['kind'] {
  if (kind === 'planningIndex') return 'planning-index'
  return kind as ManagedDocument['kind']
}

async function readStableUtf8(path: string): Promise<string> {
  let previous: { bytes: Buffer; mtimeMs: number; size: number } | null = null
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const bytes = await readFile(path)
    const metadata = await stat(path)
    const stable =
      previous === null
        ? false
        : previous.size === metadata.size &&
          previous.mtimeMs === metadata.mtimeMs &&
          previous.bytes.equals(bytes)
    if (stable) {
      return bytes.toString('utf8')
    }
    previous = { bytes, mtimeMs: metadata.mtimeMs, size: metadata.size }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40))
  }
  throw new CoreError('IO_ERROR', 'Managed content did not settle after an external write')
}

async function persistVersion(
  ideaDir: string,
  documentId: string,
  version: number,
  content: string
): Promise<void> {
  const path = versionPath(ideaDir, documentId, version)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, { flag: 'wx' }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
}

function versionPath(ideaDir: string, documentId: string, version: number): string {
  return join(ideaDir, '.idea', 'snapshots', 'managed', sha256(documentId), `${version}.md`)
}

async function staysInside(path: string, root: string): Promise<boolean> {
  const entry = await lstat(path).catch(() => null)
  if (!entry || entry.isSymbolicLink()) return false
  const [resolvedPath, resolvedRoot] = await Promise.all([realpath(path), realpath(root)])
  const rel = relative(resolvedRoot, resolvedPath)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..')
}

function imageType(bytes: Buffer): ReferenceAttachment['mediaType'] {
  if (bytes.length > 25 * 1024 * 1024) throw new CoreError('INVALID_INPUT', 'Image exceeds 25 MB')
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  throw new CoreError('INVALID_INPUT', 'Choose a PNG or JPEG image')
}

function sanitizeImage(bytes: Buffer, mediaType: ReferenceAttachment['mediaType']): Buffer {
  return mediaType === 'image/png' ? sanitizePng(bytes) : sanitizeJpeg(bytes)
}

function sanitizePng(bytes: Buffer): Buffer {
  imageType(bytes)
  const chunks = [bytes.subarray(0, 8)]
  let offset = 8
  let sawHeader = false
  let sawEnd = false
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const imageData: Buffer[] = []
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > bytes.length) throw new CoreError('INVALID_INPUT', 'The PNG image is truncated')
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const chunk = bytes.subarray(offset, end)
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) {
      throw new CoreError('INVALID_INPUT', 'The PNG checksum is invalid')
    }
    if (type === 'IHDR') {
      if (length !== 13) throw new CoreError('INVALID_INPUT', 'The PNG header is invalid')
      width = bytes.readUInt32BE(offset + 8)
      height = bytes.readUInt32BE(offset + 12)
      bitDepth = bytes[offset + 16] ?? 0
      colorType = bytes[offset + 17] ?? 0
      interlace = bytes[offset + 20] ?? 0
      if (width === 0 || height === 0 || width * height > 40_000_000) {
        throw new CoreError('INVALID_INPUT', 'The image dimensions are unsafe')
      }
      sawHeader = true
    }
    if (type === 'IEND') sawEnd = true
    if (type === 'IDAT') imageData.push(bytes.subarray(offset + 8, end - 4))
    if (
      type === 'IHDR' ||
      type === 'PLTE' ||
      type === 'IDAT' ||
      type === 'IEND' ||
      type === 'tRNS'
    ) {
      chunks.push(chunk)
    }
    offset = end
    if (type === 'IEND') break
  }
  if (!sawHeader || !sawEnd) throw new CoreError('INVALID_INPUT', 'The PNG image is incomplete')
  if (interlace !== 0) throw new CoreError('INVALID_INPUT', 'Interlaced PNG images are unsupported')
  const channels = new Map([
    [0, 1],
    [2, 3],
    [3, 1],
    [4, 2],
    [6, 4]
  ]).get(colorType)
  if (!channels || ![1, 2, 4, 8, 16].includes(bitDepth)) {
    throw new CoreError('INVALID_INPUT', 'The PNG color format is invalid')
  }
  let decoded: Buffer
  try {
    decoded = inflateSync(Buffer.concat(imageData))
  } catch {
    throw new CoreError('INVALID_INPUT', 'The PNG pixel data is corrupt')
  }
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8)
  if (decoded.length !== (rowBytes + 1) * height) {
    throw new CoreError('INVALID_INPUT', 'The PNG pixel data has an invalid size')
  }
  for (let row = 0; row < height; row += 1) {
    if ((decoded[row * (rowBytes + 1)] ?? 5) > 4) {
      throw new CoreError('INVALID_INPUT', 'The PNG row filter is invalid')
    }
  }
  return Buffer.concat(chunks)
}

function sanitizeJpeg(bytes: Buffer): Buffer {
  imageType(bytes)
  if (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    throw new CoreError('INVALID_INPUT', 'The JPEG image is incomplete')
  }
  const output = [bytes.subarray(0, 2)]
  let offset = 2
  let sawDimensions = false
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new CoreError('INVALID_INPUT', 'The JPEG image is malformed')
    const markerStart = offset
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset]
    if (marker === undefined) throw new CoreError('INVALID_INPUT', 'The JPEG is truncated')
    offset += 1
    if (marker === 0xd9) {
      output.push(bytes.subarray(markerStart, offset))
      break
    }
    if (marker === 0xda) {
      output.push(bytes.subarray(markerStart))
      break
    }
    if (offset + 2 > bytes.length) throw new CoreError('INVALID_INPUT', 'The JPEG is truncated')
    const length = bytes.readUInt16BE(offset)
    const end = offset + length
    if (length < 2 || end > bytes.length)
      throw new CoreError('INVALID_INPUT', 'The JPEG is truncated')
    if (marker >= 0xc0 && marker <= 0xc3) {
      const height = bytes.readUInt16BE(offset + 3)
      const width = bytes.readUInt16BE(offset + 5)
      if (width === 0 || height === 0 || width * height > 40_000_000) {
        throw new CoreError('INVALID_INPUT', 'The image dimensions are unsafe')
      }
      sawDimensions = true
    }
    const metadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe
    if (!metadata) output.push(bytes.subarray(markerStart, end))
    offset = end
  }
  if (!sawDimensions) throw new CoreError('INVALID_INPUT', 'The JPEG dimensions are missing')
  const sanitized = Buffer.concat(output)
  try {
    decodeJpeg(sanitized, {
      useTArray: true,
      formatAsRGBA: false,
      tolerantDecoding: false,
      maxResolutionInMP: 40,
      maxMemoryUsageInMB: 128
    })
  } catch {
    throw new CoreError('INVALID_INPUT', 'The JPEG pixel data is corrupt')
  }
  return sanitized
}

function safeImageName(filename: string, mediaType: ReferenceAttachment['mediaType']): string {
  const stem = basename(filename, extname(filename))
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return `${stem || 'reference'}${mediaType === 'image/png' ? '.png' : '.jpg'}`
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

async function readJson<T>(path: string): Promise<T | null> {
  return readFile(path, 'utf8').then(
    (raw) => JSON.parse(raw) as T,
    () => null
  )
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const staged = `${path}.staged`
  await writeFile(staged, `${JSON.stringify(value, null, 2)}\n`)
  await rename(staged, path)
}
