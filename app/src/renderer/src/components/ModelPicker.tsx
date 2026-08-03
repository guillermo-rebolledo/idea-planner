import { useMemo } from 'react'
import type { HarnessId, ModelCatalog, ModelGroup } from '@shared/contract'
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

/** What a Run is asked for: a model, the Harness that reaches it, and a level. */
export interface ModelChoice {
  harness: HarnessId
  model: string
  effort: string
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
  choice,
  onChange,
  disabled
}: {
  catalog: ModelCatalog | null
  choice: ModelChoice | null
  onChange: (choice: ModelChoice) => void
  disabled?: boolean
}): React.JSX.Element {
  const groups = useMemo(() => catalog?.groups ?? [], [catalog])
  // One flat list for the selector, which owns selection and search; the
  // groups are drawn from it so a model always knows its Harness.
  const models = useMemo<SelectorModel[]>(
    () =>
      groups.flatMap((group) =>
        group.models.map((model) => ({
          id: key(group.harness, model.id),
          name: model.name,
          description: model.description,
          keywords: [group.displayName, model.id],
          ...(model.efforts.length > 0
            ? { efforts: model.efforts.map((effort) => ({ id: effort.id, name: effort.name })) }
            : {})
        }))
      ),
    [groups]
  )

  if (groups.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        No Harness is ready, so there is nothing to run a message with.
      </p>
    )
  }

  const value = choice ? key(choice.harness, choice.model) : undefined
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
          const chosen = read(next)
          if (!chosen) return
          onChange({
            harness: chosen.harness,
            model: chosen.model,
            // Kept as the person left it; what the new model cannot do is
            // simply not asked for.
            effort: choice?.effort ?? defaultEffort(groups, chosen.harness, chosen.model)
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
                      models.find((entry) => entry.id === key(group.harness, model.id)) ?? {
                        id: key(group.harness, model.id),
                        name: model.name
                      }
                    }
                  />
                ))}
              </ModelSelectorGroup>
            ))}
          </ModelSelectorList>
          <ModelSelectorEffort />
        </ModelSelectorContent>
      </ModelSelectorRoot>
      {choice && <HarnessNote groups={groups} harness={choice.harness} />}
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
    <p className="text-[10px] text-muted-foreground">
      {group.displayName}
      {harness === 'codex'
        ? ' runs Skills as instruction text rather than natively, and reads Ask and Full access in its own terms.'
        : ' runs Skills natively.'}
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
  return {
    harness: first.harness,
    model: model.id,
    effort: model.defaultEffort ?? model.efforts[0]?.id ?? 'medium'
  }
}

/** The picker's ids carry the Harness, because a model name alone is ambiguous. */
function key(harness: HarnessId, model: string): string {
  return `${harness}:${model}`
}

function read(value: string): { harness: HarnessId; model: string } | null {
  const boundary = value.indexOf(':')
  if (boundary < 0) return null
  const harness = value.slice(0, boundary)
  if (harness !== 'claude' && harness !== 'codex') return null
  return { harness, model: value.slice(boundary + 1) }
}

function defaultEffort(groups: ModelGroup[], harness: HarnessId, model: string): string {
  const found = groups
    .find((group) => group.harness === harness)
    ?.models.find((entry) => entry.id === model)
  return found?.defaultEffort ?? found?.efforts[0]?.id ?? 'medium'
}
