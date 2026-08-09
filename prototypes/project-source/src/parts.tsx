import {
  AlertTriangle,
  Bot,
  FolderGit2,
  FolderOpen,
  Github,
  Link,
  LoaderCircle,
  Plus,
  Search
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { SOURCE_COPY, type FlowState, type SourceKind } from './model'

export const SOURCE_ICONS = { local: FolderOpen, url: Link, github: Github } as const

export function AppBackdrop({ muted = true }: { muted?: boolean }): React.JSX.Element {
  return (
    <div className={cn('absolute inset-0 flex bg-background', muted && 'opacity-60')}>
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface p-2 md:flex">
        <button
          type="button"
          className="mb-2 flex h-8 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground"
        >
          <Search aria-hidden="true" className="size-3.5" />
          Search Sessions
          <span className="ml-auto font-mono text-2xs">⌘K</span>
        </button>
        <div className="flex items-center px-2 py-1 text-2xs tracking-wide text-muted-foreground uppercase">
          Projects
          <Plus aria-hidden="true" className="ml-auto size-3" />
        </div>
        <div className="mt-1 rounded-md bg-accent px-2 py-2">
          <div className="flex items-center gap-2 text-xs font-medium">
            <FolderGit2 aria-hidden="true" className="size-3.5" />
            argos
          </div>
          <p className="mt-2 pl-5 text-xs text-muted-foreground">Project source flow</p>
          <p className="mt-1 pl-5 text-xs text-muted-foreground">Theme customization</p>
        </div>
        <div className="mt-auto flex items-center gap-2 border-t border-border px-2 py-3 text-xs text-muted-foreground">
          <Bot aria-hidden="true" className="size-3.5" />
          Argos
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 items-center border-b border-border px-4 text-sm font-medium">
          Project source flow
        </header>
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-3 px-8 py-10">
          <div className="self-end rounded-lg bg-muted px-3 py-2 text-sm">
            Add a way to clone a Project from GitHub.
          </div>
          <p className="max-w-xl text-sm leading-relaxed">
            I’ll map the existing Project boundary, then propose the smallest clone flow that fits
            it.
          </p>
          <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
            Reading the Project lifecycle…
          </div>
        </div>
        <div className="border-t border-border p-4">
          <div className="mx-auto h-16 max-w-3xl rounded-xl border border-border bg-surface" />
        </div>
      </main>
    </div>
  )
}

export function SourceRows({
  selected,
  onSelect,
  compact = false
}: {
  selected: SourceKind
  onSelect: (source: SourceKind) => void
  compact?: boolean
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-col', compact ? 'gap-1' : 'gap-1.5')}>
      {(['local', 'url', 'github'] as const).map((source) => {
        const Icon = SOURCE_ICONS[source]
        const copy = SOURCE_COPY[source]
        return (
          <button
            key={source}
            type="button"
            onClick={() => onSelect(source)}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg px-3 text-left transition-colors hover:bg-accent',
              compact ? 'py-2' : 'py-3',
              selected === source && 'bg-accent'
            )}
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-surface">
              <Icon aria-hidden="true" className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{copy.title}</span>
              <span className="block text-xs text-muted-foreground">{copy.description}</span>
            </span>
            {source === 'github' && (
              <span className="rounded border border-border px-1.5 py-0.5 text-2xs text-muted-foreground">
                gh ready
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export function Field({
  label,
  value,
  onChange,
  mono = false,
  trailing
}: {
  label: string
  value: string
  onChange: (value: string) => void
  mono?: boolean
  trailing?: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1.5 text-xs font-medium">
      {label}
      <span className="flex h-9 items-center rounded-md border border-input bg-background px-2.5 focus-within:ring-2 focus-within:ring-ring">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            'min-w-0 flex-1 bg-transparent text-sm font-normal outline-none',
            mono && 'font-mono text-xs'
          )}
        />
        {trailing}
      </span>
    </label>
  )
}

export function CloneStatus({ failed = false }: { failed?: boolean }): React.JSX.Element {
  if (failed) {
    return (
      <div className="rounded-lg border border-notice-border bg-notice p-3 text-xs text-notice-foreground">
        <div className="flex items-start gap-2">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <div>
            <p className="font-medium">Couldn’t reach GitHub</p>
            <p className="mt-1 leading-relaxed">
              Check your connection or SSH access, then try again. The incomplete folder was left
              at:
            </p>
            <p className="mt-1 font-mono break-all select-text">~/Developer/t3code</p>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-border bg-muted/60 p-3">
      <div className="flex items-center gap-2 text-xs font-medium">
        <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
        Cloning t3code…
        <span className="ml-auto font-mono text-2xs text-muted-foreground">68%</span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-border">
        <div className="prototype-progress h-full w-2/3 bg-primary" />
      </div>
      <p className="mt-2 font-mono text-2xs text-muted-foreground">
        Receiving objects · 12.4 MB of 18.1 MB
      </p>
    </div>
  )
}

export function DestinationFields({
  state,
  setRepository,
  setDestination,
  showSource = true
}: {
  state: FlowState
  setRepository: (value: string) => void
  setDestination: (value: string) => void
  showSource?: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {showSource && (
        <Field
          label={state.source === 'github' ? 'GitHub repository' : 'Repository URL'}
          value={state.repository}
          onChange={setRepository}
          mono
        />
      )}
      <Field
        label="Clone into"
        value={state.destination}
        onChange={setDestination}
        mono
        trailing={
          <Button variant="ghost" size="sm" className="-mr-1 h-6">
            Choose…
          </Button>
        }
      />
      <p className="text-2xs leading-relaxed text-muted-foreground">
        Argos creates this folder and adds it as a Project after cloning finishes.
      </p>
    </div>
  )
}
