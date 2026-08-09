import { Check, ChevronLeft, Palette, Plus, X } from 'lucide-react'
import { Button, ColorField, DialogFrame, MiniPreview, PresetButton, SchemeControl } from './parts'
import { PRESETS, isDirty, type VariantProps } from './theme'

export function VariantB(props: VariantProps): React.JSX.Element {
  const custom = props.selected === 'custom'
  const dirty = isDirty(props)
  return (
    <DialogFrame width="max-w-md">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        {custom ? (
          <button
            type="button"
            onClick={() => props.select('system')}
            className="grid size-7 place-items-center rounded-md hover:bg-muted"
            aria-label="Back to themes"
          >
            <ChevronLeft className="size-4" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">{custom ? 'Create a theme' : 'Appearance'}</h1>
          <p className="text-2xs text-muted-foreground">
            {custom ? 'Start with three decisions.' : 'Choose how Argos looks.'}
          </p>
        </div>
        <button
          type="button"
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted"
          aria-label="Close settings"
        >
          <X className="size-4" />
        </button>
      </header>
      {!custom ? (
        <div className="max-h-[570px] overflow-y-auto p-4">
          <div className="space-y-2">
            {PRESETS.map((preset) => (
              <PresetButton
                compact
                key={preset.id}
                preset={preset}
                selected={props.selected === preset.id}
                onSelect={props.select}
              />
            ))}
          </div>
          <div className="my-4 h-px bg-border" />
          <button
            type="button"
            onClick={() => props.select('custom')}
            className="flex w-full items-center gap-3 rounded-lg border border-dashed border-border p-3 text-left hover:bg-muted"
          >
            <span className="grid size-9 place-items-center rounded-lg bg-accent text-primary">
              <Plus className="size-4" />
            </span>
            <span className="flex-1">
              <span className="block text-xs font-medium">Create your theme</span>
              <span className="block text-2xs text-muted-foreground">
                Background, accent, and nothing fiddly.
              </span>
            </span>
          </button>
          <p className="mt-4 text-center text-2xs text-muted-foreground">
            Theme changes apply immediately.
          </p>
        </div>
      ) : (
        <div className="p-5">
          <div className="mb-5 flex items-center gap-2 text-2xs">
            <span className="grid size-5 place-items-center rounded-full bg-primary text-primary-foreground">
              <Check className="size-3" />
            </span>
            <span className="text-muted-foreground">Starting point</span>
            <span className="h-px flex-1 bg-border" />
            <span className="grid size-5 place-items-center rounded-full border border-primary text-primary">
              2
            </span>
            <span className="font-medium">Make it yours</span>
          </div>
          <MiniPreview draft={props.draft} roomy />
          <label className="mt-5 block">
            <span className="mb-1.5 block text-2xs font-medium text-muted-foreground">
              Theme name
            </span>
            <input
              value={props.draft.name}
              onChange={(event) => props.updateDraft({ name: event.currentTarget.value })}
              aria-label="Theme name"
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-xs outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <div className="mt-4">
            <SchemeControl
              value={props.draft.scheme}
              onChange={(scheme) => props.updateDraft({ scheme })}
            />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <ColorField
              label="Background"
              value={props.draft.background}
              onChange={(background) => props.updateDraft({ background })}
            />
            <ColorField
              label="Accent"
              value={props.draft.accent}
              onChange={(accent) => props.updateDraft({ accent })}
            />
          </div>
          <div className="mt-5 flex items-start gap-2 rounded-lg bg-accent p-3">
            <Palette className="mt-0.5 size-3.5 text-primary" />
            <p className="text-2xs leading-relaxed text-muted-foreground">
              Argos automatically keeps text, code diffs, and status colors readable.
            </p>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button quiet onClick={props.cancel} disabled={!dirty}>
              Cancel
            </Button>
            <Button onClick={props.save} disabled={!dirty}>
              Save & use
            </Button>
          </div>
        </div>
      )}
    </DialogFrame>
  )
}
