import { Check, Palette, RotateCcw, X } from 'lucide-react'
import { Button, ColorField, PresetStrip, SchemeControl } from './parts'
import { isDirty, type VariantProps } from './theme'

export function VariantC(props: VariantProps): React.JSX.Element {
  const dirty = isDirty(props)
  return (
    <div className="absolute inset-0 z-10 bg-black/10">
      <aside className="absolute inset-y-0 right-0 flex w-[420px] max-w-[90vw] flex-col border-l border-border bg-surface-raised shadow-lg">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h1 className="text-sm font-semibold">Make it yours</h1>
            <p className="mt-0.5 text-2xs text-muted-foreground">The workspace is your preview.</p>
          </div>
          <button
            type="button"
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted"
            aria-label="Close settings"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-5">
          <section>
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-medium">Quick themes</h2>
              <span className="text-2xs text-muted-foreground">Click to apply</span>
            </div>
            <div className="mt-3">
              <PresetStrip selected={props.selected} onSelect={props.select} />
            </div>
          </section>
          <div className="my-6 h-px bg-border" />
          <section>
            <div className="flex items-center gap-2">
              <span className="grid size-7 place-items-center rounded-md bg-accent text-primary">
                <Palette className="size-3.5" />
              </span>
              <div>
                <h2 className="text-xs font-medium">Custom</h2>
                <p className="text-2xs text-muted-foreground">Two colors, full theme.</p>
              </div>
            </div>
            <label className="mt-5 block">
              <span className="mb-1.5 block text-2xs font-medium text-muted-foreground">Name</span>
              <input
                value={props.draft.name}
                onFocus={() => props.select('custom')}
                onChange={(event) => props.updateDraft({ name: event.currentTarget.value })}
                aria-label="Theme name"
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <div className="mt-4">
              <span className="mb-1.5 block text-2xs font-medium text-muted-foreground">Base</span>
              <SchemeControl
                value={props.draft.scheme}
                onChange={(scheme) => props.updateDraft({ scheme })}
              />
            </div>
            <div className="mt-5 space-y-4">
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
            <div className="mt-5 grid grid-cols-3 gap-2">
              <Sample label="Surface" className="bg-surface" />
              <Sample label="Hover" className="bg-accent" />
              <Sample label="Action" className="bg-primary text-primary-foreground" />
            </div>
            <div className="mt-5 flex items-start gap-2 rounded-lg border border-border bg-background p-3">
              <Check className="mt-0.5 size-3.5 text-positive" />
              <p className="text-2xs leading-relaxed text-muted-foreground">
                Readable text and interface contrast. Product status colors stay unchanged.
              </p>
            </div>
          </section>
        </div>
        <footer className="flex items-center justify-between border-t border-border p-4">
          <button
            type="button"
            onClick={props.reset}
            className="flex items-center gap-1.5 text-2xs text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="size-3" />
            Reset
          </button>
          <div className="flex gap-2">
            <Button quiet onClick={props.cancel} disabled={!dirty}>
              Discard
            </Button>
            <Button onClick={props.save} disabled={!dirty}>
              Save theme
            </Button>
          </div>
        </footer>
      </aside>
    </div>
  )
}

function Sample({ label, className }: { label: string; className: string }): React.JSX.Element {
  return (
    <div
      className={`grid h-16 place-items-center rounded-md border border-border text-2xs ${className}`}
    >
      {label}
    </div>
  )
}
