/**
 * PROTOTYPE — throwaway.
 *
 * B — Add Project modal. The empty workspace opens it on first launch, and
 * the same surface returns from every later Add / New Project entry point.
 */
import { useMemo, useState } from 'react'
import {
  Check,
  ChevronDown,
  Clock3,
  Folder,
  FolderPlus,
  Github,
  HardDrive,
  LockKeyhole,
  Search,
  ShieldCheck,
  X
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Modal } from '@renderer/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@renderer/lib/utils'
import { CloneStatus, DestinationFields, SOURCE_ICONS } from './parts'
import { SOURCE_COPY, type SourceKind, type VariantProps } from './model'

const REPOSITORIES = [
  {
    name: 'pingdotgg/t3code',
    description: 'The developer tool for command-line agents',
    private: false,
    updated: 'Updated today'
  },
  {
    name: 'guillermo-rebolledo/idea-planner',
    description: 'Local-first planning and coding workspace',
    private: true,
    updated: 'Updated yesterday'
  },
  {
    name: 'guillermo-rebolledo/memoji',
    description: 'Experiments and product sketches',
    private: true,
    updated: 'Updated last week'
  },
  {
    name: 'vercel/next.js',
    description: 'The React framework for the web',
    private: false,
    updated: 'Recently viewed'
  }
] as const

const LOCATIONS = [
  { path: '~/Developer', label: 'Developer' },
  { path: '~/Code', label: 'Code' },
  { path: '~/Documents', label: 'Documents' },
  { path: '~/Desktop', label: 'Desktop' }
] as const

export function VariantB(props: VariantProps): React.JSX.Element {
  const { state, setDestination, setScenario, setSource } = props
  const [projectDialogOpen, setProjectDialogOpen] = useState(true)

  function openProjectDialog(): void {
    setScenario('source')
    setProjectDialogOpen(true)
  }

  return (
    <div className="relative flex h-full bg-background">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface p-2">
        <div className="app-drag-region h-9 shrink-0" />
        <div className="flex items-center px-2 py-1 text-2xs tracking-wide text-muted-foreground uppercase">
          Projects
          <button
            type="button"
            aria-label="New Project"
            onClick={openProjectDialog}
            className="ml-auto grid size-6 place-items-center rounded-md hover:bg-accent hover:text-foreground"
          >
            <FolderPlus aria-hidden="true" className="size-3.5" />
          </button>
        </div>
        <div className="mt-auto border-t border-border px-2 py-3 text-xs text-muted-foreground">
          Argos
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="app-drag-region h-11 shrink-0 border-b border-border" />
        <div className="grid min-h-0 flex-1 place-items-center px-6 pb-16 text-center">
          <div className="max-w-sm">
            <div className="mx-auto grid size-12 place-items-center rounded-xl border border-border bg-surface shadow-sm">
              <FolderPlus aria-hidden="true" className="size-5 text-muted-foreground" />
            </div>
            <h1 className="mt-4 text-lg font-semibold tracking-tight">Add your first Project</h1>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Open a local folder or clone a repository to start working with an agent.
            </p>
            <Button className="mt-5" onClick={openProjectDialog}>
              <FolderPlus aria-hidden="true" className="size-3.5" />
              Add Project
            </Button>
          </div>
        </div>
      </main>

      {projectDialogOpen && (
        <Modal
          labelledBy="add-project-title"
          onDismiss={() => setProjectDialogOpen(false)}
          className="project-source-dialog overflow-hidden p-0"
        >
          <header className="flex h-16 shrink-0 items-center justify-between border-b border-border px-6">
            <div>
              <h2 id="add-project-title" className="text-sm font-semibold">
                Add Project
              </h2>
              <p className="mt-0.5 text-2xs text-muted-foreground">
                Choose where your project comes from.
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close Add Project"
              onClick={() => setProjectDialogOpen(false)}
            >
              <X aria-hidden="true" className="size-4" />
            </Button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <div className="mx-auto max-w-2xl">
              <div className="grid grid-cols-3 gap-2" aria-label="Project source">
                {(['local', 'url', 'github'] as const).map((source) => (
                  <SourceCard
                    key={source}
                    source={source}
                    selected={state.source === source}
                    onClick={() => {
                      setSource(source)
                      setScenario(source === 'local' ? 'source' : 'configure')
                    }}
                  />
                ))}
              </div>

              <div className="mt-3 rounded-xl border border-border bg-surface p-5 shadow-sm">
                {state.source === 'local' ? (
                  <div className="flex min-h-44 flex-col items-center justify-center px-6 text-center">
                    <Folder aria-hidden="true" className="size-6 text-muted-foreground" />
                    <p className="mt-3 text-sm font-medium">Open a local Project</p>
                    <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                      Select an existing folder with your system’s directory picker.
                    </p>
                    <Button
                      className="mt-4 inline-flex h-8 items-center justify-center gap-1.5 px-3"
                      onClick={() => {
                        setDestination('~/Projects/my-project')
                        setScenario('configure')
                      }}
                    >
                      <Folder aria-hidden="true" className="size-3.5" />
                      Choose project folder…
                    </Button>
                    {state.scenario === 'configure' && (
                      <p className="mt-3 font-mono text-2xs text-muted-foreground">
                        Selected: {state.destination}
                      </p>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="mb-4 flex items-center gap-2">
                      <h2 className="text-sm font-medium">{SOURCE_COPY[state.source].title}</h2>
                      {state.source === 'github' && (
                        <span className="ml-auto flex items-center gap-1 text-2xs text-positive">
                          <Check aria-hidden="true" className="size-3" /> gh authenticated
                        </span>
                      )}
                    </div>
                    {state.source === 'github' ? (
                      <GitHubCloneSelectors {...props} />
                    ) : (
                      <DestinationFields {...props} />
                    )}
                    {(state.scenario === 'cloning' || state.scenario === 'failed') && (
                      <div className="mt-4">
                        <CloneStatus failed={state.scenario === 'failed'} />
                      </div>
                    )}
                    <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
                      <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                        <ShieldCheck aria-hidden="true" className="size-3.5" />
                        Argos never stores your credentials
                      </span>
                      {state.scenario === 'cloning' ? (
                        <Button variant="secondary" onClick={() => setScenario('failed')}>
                          Cancel
                        </Button>
                      ) : (
                        <Button onClick={() => setScenario('cloning')}>
                          {state.scenario === 'failed' ? 'Try again' : 'Clone Project'}
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

function GitHubCloneSelectors({
  state,
  setRepository,
  setDestination
}: VariantProps): React.JSX.Element {
  const [repositoryOpen, setRepositoryOpen] = useState(false)
  const [locationOpen, setLocationOpen] = useState(false)
  const [query, setQuery] = useState('')
  const repositoryLeaf = state.repository.split('/').at(-1) ?? 'project'
  const selectedParent = state.destination.slice(0, -repositoryLeaf.length - 1) || '~/Developer'
  const matches = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return REPOSITORIES
    return REPOSITORIES.filter(
      (repository) =>
        repository.name.toLowerCase().includes(normalized) ||
        repository.description.toLowerCase().includes(normalized)
    )
  }, [query])

  function chooseRepository(repository: string): void {
    const leaf = repository.split('/').at(-1) ?? 'project'
    setRepository(repository)
    setDestination(`${selectedParent}/${leaf}`)
    setRepositoryOpen(false)
  }

  function chooseParent(parent: string): void {
    setDestination(`${parent}/${repositoryLeaf}`)
    setLocationOpen(false)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5 text-xs font-medium">
        <p>GitHub repository</p>
        <Popover open={repositoryOpen} onOpenChange={setRepositoryOpen}>
          <PopoverTrigger className="flex h-10 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
            <Github aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{state.repository}</span>
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="project-source-popover z-50 w-96 overflow-hidden rounded-md border border-border bg-surface-raised p-0 text-foreground shadow-md outline-none"
          >
            <div className="flex h-10 items-center gap-2 border-b border-border px-3">
              <Search aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search repositories…"
                aria-label="Search GitHub repositories"
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="max-h-72 overflow-y-auto p-1.5">
              <p className="px-2 py-1.5 text-2xs tracking-wide text-muted-foreground uppercase">
                Accessible to @guillermo-rebolledo
              </p>
              {matches.map((repository) => (
                <button
                  key={repository.name}
                  type="button"
                  onClick={() => chooseRepository(repository.name)}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent',
                    repository.name === state.repository && 'bg-accent'
                  )}
                >
                  {repository.private ? (
                    <LockKeyhole
                      aria-label="Private repository"
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    />
                  ) : (
                    <Github
                      aria-label="Public repository"
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-mono text-xs">{repository.name}</span>
                      {repository.name === state.repository && (
                        <Check aria-hidden="true" className="ml-auto size-3.5 shrink-0" />
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
                      {repository.description}
                    </span>
                    <span className="mt-1 flex items-center gap-1 text-2xs text-muted-foreground">
                      <Clock3 aria-hidden="true" className="size-3" /> {repository.updated}
                    </span>
                  </span>
                </button>
              ))}
              {matches.length === 0 && (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No accessible repositories match “{query}”.
                </p>
              )}
            </div>
            <div className="border-t border-border px-3 py-2 text-2xs text-muted-foreground">
              Listed by your authenticated GitHub CLI account
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex flex-col gap-1.5 text-xs font-medium">
        <p>Clone into</p>
        <Popover open={locationOpen} onOpenChange={setLocationOpen}>
          <PopoverTrigger className="flex h-11 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
            <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-xs">{selectedParent}</span>
              <span className="block text-2xs text-muted-foreground">
                Creates {repositoryLeaf} inside this folder
              </span>
            </span>
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="project-source-popover z-50 w-80 overflow-hidden rounded-md border border-border bg-surface-raised p-1.5 text-foreground shadow-md outline-none"
          >
            <p className="px-2 py-1.5 text-2xs tracking-wide text-muted-foreground uppercase">
              Recent locations
            </p>
            {LOCATIONS.map((location) => (
              <button
                key={location.path}
                type="button"
                onClick={() => chooseParent(location.path)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent',
                  selectedParent === location.path && 'bg-accent'
                )}
              >
                <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium">{location.label}</span>
                  <span className="block font-mono text-2xs text-muted-foreground">
                    {location.path}
                  </span>
                </span>
                {selectedParent === location.path && (
                  <Check aria-hidden="true" className="size-3.5 shrink-0" />
                )}
              </button>
            ))}
            <div className="my-1 border-t border-border" />
            <button
              type="button"
              onClick={() => chooseParent('~/Projects')}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
            >
              <HardDrive aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium">Choose another folder…</span>
                <span className="block text-2xs text-muted-foreground">
                  Open the system directory picker
                </span>
              </span>
            </button>
            <p className="mx-2 mt-1 border-t border-border py-2 text-2xs leading-relaxed text-muted-foreground">
              Your system may request access to the selected location.
            </p>
          </PopoverContent>
        </Popover>
      </div>

      <div className="rounded-md border border-border bg-muted/50 px-3 py-2">
        <p className="text-2xs text-muted-foreground">New Project location</p>
        <p className="mt-0.5 truncate font-mono text-xs select-text">{state.destination}</p>
      </div>
    </div>
  )
}

function SourceCard({
  source,
  selected,
  onClick
}: {
  source: SourceKind
  selected: boolean
  onClick: () => void
}): React.JSX.Element {
  const Icon = SOURCE_ICONS[source]
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative flex min-h-28 flex-col items-start rounded-xl border p-3 text-left transition-colors',
        selected
          ? 'border-ring bg-surface-raised ring-1 ring-ring'
          : 'border-border bg-surface hover:bg-accent'
      )}
    >
      <Icon aria-hidden="true" className="mb-3 size-4" />
      <span className="text-xs font-medium">{SOURCE_COPY[source].title}</span>
      <span className="mt-1 text-2xs leading-relaxed text-muted-foreground">
        {SOURCE_COPY[source].description}
      </span>
      {selected && (
        <span className="absolute top-2 right-2 grid size-4 place-items-center rounded-full bg-primary text-primary-foreground">
          <Check aria-hidden="true" className="size-3" />
        </span>
      )}
    </button>
  )
}
