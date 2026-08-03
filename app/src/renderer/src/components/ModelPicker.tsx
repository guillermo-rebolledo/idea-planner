import { useCallback, useEffect, useMemo, useState } from 'react'
import { firstProblem, harnessIdSchema, DEFAULT_EFFORT } from '@shared/contract'
import type {
  HarnessId,
  HarnessReadiness,
  ModelCatalog,
  ModelGroup,
  ReadinessSnapshot
} from '@shared/contract'
import { ClaudeLogo, OpenAILogo } from '@renderer/components/ui/logos'
import {
  ModelSelectorRoot,
  ModelSelectorContent,
  ModelSelectorEffort,
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorSearch,
  ModelSelectorTrigger,
  resolveModelEffort,
  type ModelOption as SelectorModel
} from '@renderer/components/ui/model-selector'

/**
 * What there is to choose from, and what stands in the way of the rest. Read
 * rather than remembered, and read again on every return to the window: a
 * Harness is installed, updated and signed out by the person, in their own
 * terminal, and none of that is announced to this app.
 */
export function useModelCatalog(): {
  models: ModelCatalog | null
  readiness: ReadinessSnapshot | null
} {
  const [models, setModels] = useState<ModelCatalog | null>(null)
  const [readiness, setReadiness] = useState<ReadinessSnapshot | null>(null)
  const read = useCallback(() => {
    void window.shell.listModels().then(setModels, () => undefined)
    void window.shell.getReadiness().then(setReadiness, () => undefined)
  }, [])
  useEffect(() => {
    read()
    window.addEventListener('focus', read)
    return () => window.removeEventListener('focus', read)
  }, [read])
  return { models, readiness }
}

/**
 * What a Run is asked for: a model, the Harness that reaches it, and a level.
 * The level is the person's, kept whether or not the model in front of them
 * can use it — `applicableEffort` is what a Run is actually asked for.
 */
export interface ModelChoice {
  harness: HarnessId
  model: string
  effort: string
}

/**
 * The level to ask this model for, and null when it has none to ask for. The
 * choice itself is untouched: switching to a model with fewer levels and back
 * finds the level still there.
 */
export function applicableEffort(
  catalog: ModelCatalog | null,
  choice: ModelChoice | null
): string | null {
  if (!choice) return null
  const model = (catalog?.groups ?? [])
    .find((group) => group.harness === choice.harness)
    ?.models.find((entry) => entry.id === choice.model)
  if (!model || model.efforts.length === 0) return null
  return model.efforts.some((effort) => effort.id === choice.effort) ? choice.effort : null
}

/**
 * One control where a Harness, a model and an effort used to be three.
 *
 * Choosing a model chooses the Harness, because people think in models rather
 * than in which CLI reaches them. That collapse hides something real, so the
 * groups are headed by the Harness and crossing between them says what
 * changes: Ask and Full access do not mean the same thing across Harnesses
 * (`docs/harness-permission-mapping.md`), and Skills are native to Claude Code
 * where Codex is handed instruction text (ADR 0003).
 */
export function ModelPicker({
  catalog,
  readiness,
  choice,
  onChange,
  disabled
}: {
  catalog: ModelCatalog | null
  /** For naming the Harnesses that cannot run a message, and why. */
  readiness?: ReadinessSnapshot | null
  choice: ModelChoice | null
  onChange: (choice: ModelChoice) => void
  disabled?: boolean
}): React.JSX.Element {
  const groups = useMemo(() => catalog?.groups ?? [], [catalog])
  // Greyed rather than hidden: a Harness that cannot run a Session is still
  // real, and what stands in its way is exactly what the person needs told.
  // Only genuinely unusable ones qualify — a ready Harness whose model probe
  // merely failed has no problem worth stating as one.
  const unusable = (readiness?.harnesses ?? []).filter(
    (entry) =>
      !entry.capabilities.developSession.available &&
      !groups.some((group) => group.harness === entry.harness)
  )
  // One flat list for the selector, which owns selection and search; the
  // groups are drawn from it so a model always knows its Harness.
  const models = useMemo<SelectorModel[]>(
    () =>
      groups.flatMap((group) =>
        group.models.map((model) => ({
          id: modelKey(group.harness, model.id),
          name: model.name,
          description: model.description,
          icon: HARNESS_LOGO[group.harness],
          keywords: [group.displayName, model.id],
          ...(model.efforts.length > 0
            ? { efforts: model.efforts.map((effort) => ({ id: effort.id, name: effort.name })) }
            : {})
        }))
      ),
    [groups]
  )

  const byKey = useMemo(() => new Map(models.map((model) => [model.id, model])), [models])

  if (groups.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No Harness is ready, so there is nothing to run a message with.
      </p>
    )
  }

  const value = choice ? modelKey(choice.harness, choice.model) : undefined
  // Sticky across a switch: a level the new model does not have is kept rather
  // than discarded, and simply does not apply while that model is chosen.
  const effort = resolveModelEffort(models, value, choice?.effort)

  return (
    <div className="flex flex-col gap-1">
      <ModelSelectorRoot
        models={models}
        {...(value !== undefined ? { value } : {})}
        {...(effort !== undefined ? { effort } : {})}
        onValueChange={(next) => {
          const chosen = parseModelKey(next)
          if (!chosen) return
          onChange({
            harness: chosen.harness,
            model: chosen.model,
            // Kept as the person left it; what the new model cannot do is
            // simply not asked for.
            effort: choice?.effort ?? startingEffortFor(groups, chosen.harness, chosen.model)
          })
        }}
        onEffortChange={(next) => {
          if (!choice) return
          onChange({ ...choice, effort: next })
        }}
      >
        <ModelSelectorTrigger
          aria-label="Model"
          disabled={disabled ?? false}
          className="h-8 border border-border px-2"
        />
        <ModelSelectorContent align="start" searchable>
          <ModelSelectorSearch placeholder="Search models…" />
          <ModelSelectorList>
            {groups.map((group) => (
              <ModelSelectorGroup key={group.harness} heading={group.displayName}>
                {group.models.map((model) => (
                  <ModelSelectorItem
                    key={model.id}
                    model={
                      byKey.get(modelKey(group.harness, model.id)) ?? {
                        id: modelKey(group.harness, model.id),
                        name: model.name
                      }
                    }
                  />
                ))}
              </ModelSelectorGroup>
            ))}
          </ModelSelectorList>
          {unusable.length > 0 && (
            <div aria-label="Unavailable Harnesses" className="border-t border-border px-1 py-1">
              {unusable.map((entry) => (
                <UnusableHarnessRow key={entry.harness} entry={entry} />
              ))}
            </div>
          )}
          <ModelSelectorEffort />
        </ModelSelectorContent>
      </ModelSelectorRoot>
      {choice && <HarnessNote groups={groups} harness={choice.harness} />}
    </div>
  )
}

/**
 * What comes with each Harness, beyond the model. Stated per Harness rather
 * than as a test against one, so a Harness added later says its own thing
 * instead of inheriting somebody else's.
 */
/** The mark of whoever makes the models a Harness reaches. */
const HARNESS_LOGO: Record<HarnessId, React.JSX.Element> = {
  claude: <ClaudeLogo />,
  codex: <OpenAILogo />
}

const HARNESS_DIFFERENCE: Record<HarnessId, string> = {
  claude: 'runs Skills natively.',
  codex:
    'runs Skills as instruction text rather than natively, and reads Ask and Full access in its own terms.'
}

/**
 * A Harness that cannot run a message, named with the one thing standing in
 * its way. Not an option — there is nothing to choose until it is fixed in
 * the Launch Gate or a terminal.
 */
function UnusableHarnessRow({ entry }: { entry: HarnessReadiness }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 rounded-md px-2 py-1.5 opacity-60" aria-disabled="true">
      <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5">
        {HARNESS_LOGO[entry.harness]}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs">{entry.displayName}</span>
        <span className="block truncate text-2xs text-muted-foreground">{firstProblem(entry)}</span>
      </span>
    </div>
  )
}

/**
 * What comes with the Harness this model belongs to. Said at the picker rather
 * than in documentation, because switching model is where it changes.
 */
function HarnessNote({
  groups,
  harness
}: {
  groups: ModelGroup[]
  harness: HarnessId
}): React.JSX.Element | null {
  const group = groups.find((entry) => entry.harness === harness)
  if (!group) return null
  return (
    <p className="text-2xs text-muted-foreground">
      {group.displayName} {HARNESS_DIFFERENCE[harness]}
      {group.source === 'documented' && ' It lists no models, so these are the ones it documents.'}
    </p>
  )
}

/**
 * What a message would actually be sent with: the person's choice while the
 * catalog still offers it, and otherwise the first model of the first group —
 * which is a Harness that can run a Session.
 *
 * Derived rather than stored, so a Harness that stops being usable stops being
 * offered without anything having to notice and correct itself.
 */
export function effectiveChoice(
  catalog: ModelCatalog | null,
  chosen: ModelChoice | null
): ModelChoice | null {
  const groups = catalog?.groups ?? []
  const kept = groups
    .find((group) => group.harness === chosen?.harness)
    ?.models.find((model) => model.id === chosen?.model)
  if (chosen && kept) return chosen
  const first = groups[0]
  const model = first?.models[0]
  if (!first || !model) return null
  return { harness: first.harness, model: model.id, effort: startingEffort(model) }
}

function startingEffortFor(groups: ModelGroup[], harness: HarnessId, model: string): string {
  const found = groups
    .find((group) => group.harness === harness)
    ?.models.find((entry) => entry.id === model)
  return found ? startingEffort(found) : DEFAULT_EFFORT
}

/** The picker's ids carry the Harness, because a model name alone is ambiguous. */
function modelKey(harness: HarnessId, model: string): string {
  return `${harness}:${model}`
}

function parseModelKey(value: string): { harness: HarnessId; model: string } | null {
  const boundary = value.indexOf(':')
  if (boundary < 0) return null
  // The contract's own list, rather than a second copy of it here.
  const harness = harnessIdSchema.safeParse(value.slice(0, boundary))
  return harness.success ? { harness: harness.data, model: value.slice(boundary + 1) } : null
}

/** What to ask a model for when nothing has been chosen for it yet. */
function startingEffort(model: {
  defaultEffort: string | null
  efforts: { id: string }[]
}): string {
  return model.defaultEffort ?? model.efforts[0]?.id ?? DEFAULT_EFFORT
}
