import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Clock3,
  Folder,
  FolderOpen,
  GitFork,
  Link,
  LoaderCircle,
  LockKeyhole,
  Search,
  ShieldCheck,
  X
} from 'lucide-react'
import type {
  ChooseProjectResult,
  GitHubRepository,
  ProjectCloneEvent,
  ProjectCloneLocation,
  ProjectView
} from '@shared/contract'
import { projectNameFromRemote } from '@shared/project'
import { Button } from '@renderer/components/ui/button'
import { Modal } from '@renderer/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@renderer/lib/utils'

type Source = 'local' | 'git-url' | 'github'
type Refusal = Extract<ChooseProjectResult, { status: 'refused' }>
type RootConfirmation = Extract<ChooseProjectResult, { status: 'confirm-root' }>

const SOURCE_DETAILS = {
  local: { title: 'Local folder', description: 'Browse a folder on disk', icon: FolderOpen },
  'git-url': { title: 'Git URL', description: 'Clone from an HTTPS or SSH URL', icon: Link },
  github: { title: 'GitHub repository', description: 'Clone GitHub owner/repo', icon: GitFork }
} as const

export function AddProjectDialog({
  onAdded,
  onDismiss
}: {
  onAdded: (project: ProjectView) => void
  onDismiss: () => void
}): React.JSX.Element {
  const [source, setSource] = useState<Source>('local')
  const [gitUrl, setGitUrl] = useState('')
  const [repositories, setRepositories] = useState<GitHubRepository[]>([])
  const [repositoryStatus, setRepositoryStatus] = useState<
    'loading' | 'ready' | 'unavailable' | 'unauthenticated' | 'failed'
  >('loading')
  const [repositoryDetail, setRepositoryDetail] = useState('')
  const [repository, setRepository] = useState('')
  const [repositoryQuery, setRepositoryQuery] = useState('')
  const [repositoryOpen, setRepositoryOpen] = useState(false)
  const [locations, setLocations] = useState<ProjectCloneLocation[]>([])
  const [location, setLocation] = useState<ProjectCloneLocation | null>(null)
  const [locationsForName, setLocationsForName] = useState<string | null>(null)
  const [locationOpen, setLocationOpen] = useState(false)
  const [operationId, setOperationId] = useState<string | null>(null)
  const operationIdRef = useRef<string | null>(null)
  const [cloneStatus, setCloneStatus] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [confirmation, setConfirmation] = useState<RootConfirmation | null>(null)
  const [busy, setBusy] = useState(false)

  const suggestedName =
    source === 'github'
      ? (repository.split('/').at(-1) ?? null)
      : projectNameFromRemote(gitUrl.trim())

  const loadRepositories = useCallback(() => {
    setRepositoryStatus('loading')
    void window.shell.listGitHubRepositories().then(
      (result) => {
        setRepositoryStatus(result.status)
        if (result.status === 'ready') {
          setRepositories(result.repositories)
          setRepository((current) =>
            current.length > 0 ? current : (result.repositories[0]?.nameWithOwner ?? '')
          )
          setRepositoryDetail('')
        } else {
          setRepositories([])
          setRepositoryDetail(result.detail)
        }
      },
      () => {
        setRepositoryStatus('failed')
        setRepositoryDetail('GitHub repositories could not be loaded.')
      }
    )
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(loadRepositories, 0)
    return () => window.clearTimeout(timer)
  }, [loadRepositories])

  useEffect(() => {
    if (!suggestedName) return
    let active = true
    void window.shell.listProjectCloneLocations(suggestedName).then(
      (next) => {
        if (!active) return
        setLocations(next)
        setLocation(next[0] ?? null)
        setLocationsForName(suggestedName)
      },
      () => {
        if (active) {
          setLocations([])
          setLocation(null)
          setLocationsForName(suggestedName)
        }
      }
    )
    return () => {
      active = false
    }
  }, [suggestedName])

  useEffect(() => {
    return window.shell.onProjectCloneEvent((event) => {
      if (event.operationId !== operationIdRef.current) return
      handleCloneEvent(event)
    })
  })

  const matchingRepositories = useMemo(() => {
    const query = repositoryQuery.trim().toLowerCase()
    if (!query) return repositories
    return repositories.filter(
      (item) =>
        item.nameWithOwner.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query)
    )
  }, [repositories, repositoryQuery])
  const activeLocation = suggestedName === locationsForName ? location : null

  function handleCloneEvent(event: ProjectCloneEvent): void {
    if (event.type === 'progress') {
      setCloneStatus(event.detail)
      return
    }
    setOperationId(null)
    operationIdRef.current = null
    if (event.type === 'completed') {
      onAdded(event.project)
      onDismiss()
    } else if (event.type === 'cancelled') {
      setFailure(`Clone cancelled. Any partial files remain at ${event.destination}.`)
    } else {
      const mayHavePartialFiles = ![
        'invalid-source',
        'destination-exists',
        'destination-unavailable'
      ].includes(event.reason)
      setFailure(
        mayHavePartialFiles
          ? `${event.detail} Any partial files remain at ${event.destination}.`
          : event.detail
      )
    }
  }

  const adopt = useCallback(
    (result: ChooseProjectResult) => {
      if (result.status === 'cancelled') return
      setFailure(null)
      if (result.status === 'refused') {
        setConfirmation(null)
        setRefusal(result)
      } else if (result.status === 'confirm-root') {
        setRefusal(null)
        setConfirmation(result)
      } else {
        onAdded(result.project)
        onDismiss()
      }
    },
    [onAdded, onDismiss]
  )

  async function offer(work: () => Promise<ChooseProjectResult>, detail: string): Promise<void> {
    setBusy(true)
    setFailure(null)
    try {
      adopt(await work())
    } catch {
      setFailure(detail)
    } finally {
      setBusy(false)
    }
  }

  async function chooseAnotherLocation(): Promise<void> {
    if (!suggestedName) return
    const chosen = await window.shell.chooseProjectCloneLocation(suggestedName).catch(() => null)
    if (!chosen) return
    setLocations((current) => [chosen, ...current.filter((item) => item.parent !== chosen.parent)])
    setLocation(chosen)
    setLocationsForName(suggestedName)
    setLocationOpen(false)
  }

  async function startClone(): Promise<void> {
    if (!activeLocation || !suggestedName) return
    setBusy(true)
    setFailure(null)
    setCloneStatus('Starting clone…')
    let preparedId: string | null = null
    try {
      const started = await window.shell.startProjectClone(
        source === 'github'
          ? { source: 'github', repository, destination: activeLocation.destination }
          : { source: 'git-url', url: gitUrl.trim(), destination: activeLocation.destination }
      )
      preparedId = started.operationId
      operationIdRef.current = started.operationId
      setOperationId(started.operationId)
      await window.shell.beginProjectClone(started.operationId)
      setBusy(false)
    } catch {
      if (preparedId) await window.shell.cancelProjectClone(preparedId).catch(() => undefined)
      operationIdRef.current = null
      setOperationId(null)
      setBusy(false)
      setCloneStatus('')
      setFailure('The clone could not be started.')
    }
  }

  function dismiss(): void {
    if (operationId || busy) return
    onDismiss()
  }

  return (
    <Modal
      labelledBy="add-project-title"
      onDismiss={dismiss}
      className="add-project-dialog overflow-hidden p-0"
    >
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-border px-6">
        <div>
          <h1 id="add-project-title" className="text-sm font-semibold">
            Add Project
          </h1>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            Choose where your project comes from.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close Add Project"
          disabled={busy || operationId !== null}
          onClick={dismiss}
        >
          <X aria-hidden="true" className="size-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl">
          <div className="grid grid-cols-3 gap-2" aria-label="Project source">
            {(Object.keys(SOURCE_DETAILS) as Source[]).map((item) => {
              const details = SOURCE_DETAILS[item]
              const Icon = details.icon
              const selected = source === item
              return (
                <button
                  key={item}
                  type="button"
                  data-autofocus={item === 'local' ? '' : undefined}
                  aria-pressed={selected}
                  disabled={busy || operationId !== null}
                  onClick={() => {
                    setSource(item)
                    setFailure(null)
                  }}
                  className={cn(
                    'relative flex min-h-28 flex-col items-start rounded-xl border p-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                    selected
                      ? 'border-ring bg-surface-raised ring-1 ring-ring'
                      : 'border-border bg-surface hover:bg-accent'
                  )}
                >
                  <Icon aria-hidden="true" className="mb-3 size-4" />
                  <span className="text-xs font-medium">{details.title}</span>
                  <span className="mt-1 text-2xs leading-relaxed text-muted-foreground">
                    {details.description}
                  </span>
                  {selected && (
                    <span className="absolute top-2 right-2 grid size-4 place-items-center rounded-full bg-primary text-primary-foreground">
                      <Check aria-hidden="true" className="size-3" />
                    </span>
                  )}
                  {item === 'github' &&
                    !selected &&
                    ['unavailable', 'unauthenticated', 'failed'].includes(repositoryStatus) && (
                      <span className="border-warning/30 bg-warning/10 text-warning absolute top-2 right-2 rounded border px-1.5 py-0.5 text-2xs font-medium">
                        Setup Required
                      </span>
                    )}
                </button>
              )
            })}
          </div>

          <div className="mt-3 rounded-xl border border-border bg-surface p-5 shadow-sm">
            {source === 'local' ? (
              <div className="flex min-h-44 flex-col items-center justify-center px-6 text-center">
                <Folder aria-hidden="true" className="size-6 text-muted-foreground" />
                <p className="mt-3 text-sm font-medium">Open a local Project</p>
                <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                  Select an existing folder with your system’s directory picker.
                </p>
                <Button
                  className="mt-4"
                  disabled={busy}
                  onClick={() =>
                    void offer(
                      () => window.shell.chooseProject(),
                      'That folder could not be added.'
                    )
                  }
                >
                  <Folder aria-hidden="true" className="size-3.5" />
                  Choose project folder…
                </Button>
              </div>
            ) : (
              <div>
                <div className="mb-4 flex items-center gap-2">
                  <h2 className="text-sm font-medium">{SOURCE_DETAILS[source].title}</h2>
                  {source === 'github' && repositoryStatus === 'ready' && (
                    <span className="ml-auto flex items-center gap-1 text-2xs text-positive">
                      <Check aria-hidden="true" className="size-3" /> GitHub authenticated
                    </span>
                  )}
                </div>

                {source === 'git-url' ? (
                  <label className="flex flex-col gap-1.5 text-xs font-medium">
                    Repository URL
                    <input
                      value={gitUrl}
                      disabled={busy || operationId !== null}
                      placeholder="https://github.com/owner/repo.git"
                      onChange={(event) => setGitUrl(event.currentTarget.value)}
                      className="h-10 rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    />
                  </label>
                ) : (
                  <RepositoryPicker
                    open={repositoryOpen}
                    setOpen={setRepositoryOpen}
                    status={repositoryStatus}
                    detail={repositoryDetail}
                    repository={repository}
                    query={repositoryQuery}
                    setQuery={setRepositoryQuery}
                    matches={matchingRepositories}
                    disabled={busy || operationId !== null}
                    onRetry={loadRepositories}
                    onSelect={(next) => {
                      setRepository(next)
                      setRepositoryOpen(false)
                    }}
                  />
                )}

                <div className="mt-3 flex flex-col gap-1.5 text-xs font-medium">
                  <p>Clone into</p>
                  <Popover open={locationOpen} onOpenChange={setLocationOpen}>
                    <PopoverTrigger
                      disabled={busy || !suggestedName || operationId !== null}
                      className="flex h-11 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    >
                      <Folder
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-xs">
                          {activeLocation?.parent ?? 'Choose a repository first'}
                        </span>
                        {suggestedName && (
                          <span className="block text-2xs text-muted-foreground">
                            Creates {suggestedName} inside this folder
                          </span>
                        )}
                      </span>
                      <ChevronDown
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-80 overflow-hidden p-1.5">
                      <p className="px-2 py-1.5 text-2xs tracking-wide text-muted-foreground uppercase">
                        Locations
                      </p>
                      {locations.map((item) => (
                        <button
                          key={item.parent}
                          type="button"
                          onClick={() => {
                            setLocation(item)
                            setLocationOpen(false)
                          }}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent',
                            activeLocation?.parent === item.parent && 'bg-accent'
                          )}
                        >
                          <Folder
                            aria-hidden="true"
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-xs font-medium">{item.label}</span>
                            <span className="block truncate font-mono text-2xs text-muted-foreground">
                              {item.parent}
                            </span>
                          </span>
                          {activeLocation?.parent === item.parent && (
                            <Check aria-hidden="true" className="size-3.5 shrink-0" />
                          )}
                        </button>
                      ))}
                      <div className="my-1 border-t border-border" />
                      <button
                        type="button"
                        onClick={() => void chooseAnotherLocation()}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
                      >
                        <FolderOpen
                          aria-hidden="true"
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                        <span>
                          <span className="block text-xs font-medium">Choose another folder…</span>
                          <span className="block text-2xs text-muted-foreground">
                            Open the system directory picker
                          </span>
                        </span>
                      </button>
                    </PopoverContent>
                  </Popover>
                </div>

                {activeLocation && (
                  <div className="mt-3 rounded-md border border-border bg-muted/50 px-3 py-2">
                    <p className="text-2xs text-muted-foreground">New Project location</p>
                    <p className="mt-0.5 truncate font-mono text-xs select-text">
                      {activeLocation.destination}
                    </p>
                  </div>
                )}

                {operationId && (
                  <div className="mt-4 rounded-md border border-border bg-muted/50 p-3">
                    <p className="flex items-center gap-2 text-xs font-medium">
                      <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                      Cloning Project…
                    </p>
                    <p className="mt-1 truncate font-mono text-2xs text-muted-foreground">
                      {cloneStatus}
                    </p>
                  </div>
                )}

                <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
                  <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                    <ShieldCheck aria-hidden="true" className="size-3.5" />
                    Argos never stores your credentials
                  </span>
                  {operationId ? (
                    <Button
                      variant="secondary"
                      onClick={() => void window.shell.cancelProjectClone(operationId)}
                    >
                      Cancel
                    </Button>
                  ) : (
                    <Button
                      disabled={
                        busy ||
                        !activeLocation ||
                        !suggestedName ||
                        (source === 'github' && repositoryStatus !== 'ready')
                      }
                      onClick={() => void startClone()}
                    >
                      Clone Project
                    </Button>
                  )}
                </div>
              </div>
            )}

            {failure && (
              <p className="mt-4 text-xs leading-relaxed text-destructive" role="status">
                {failure}
              </p>
            )}
            {refusal && (
              <RefusalNotice
                refusal={refusal}
                busy={busy}
                onDismiss={() => setRefusal(null)}
                onInitialize={(path) =>
                  void offer(() => window.shell.initializeProject(path), 'Git could not set it up.')
                }
              />
            )}
            {confirmation && (
              <ConfirmationNotice
                confirmation={confirmation}
                busy={busy}
                onDismiss={() => setConfirmation(null)}
                onConfirm={(root) =>
                  void offer(
                    () => window.shell.confirmProject(root),
                    'That Project could not be added.'
                  )
                }
              />
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}

function RepositoryPicker({
  open,
  setOpen,
  status,
  detail,
  repository,
  query,
  setQuery,
  matches,
  disabled,
  onRetry,
  onSelect
}: {
  open: boolean
  setOpen: (open: boolean) => void
  status: 'loading' | 'ready' | 'unavailable' | 'unauthenticated' | 'failed'
  detail: string
  repository: string
  query: string
  setQuery: (query: string) => void
  matches: GitHubRepository[]
  disabled: boolean
  onRetry: () => void
  onSelect: (repository: string) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 text-xs font-medium">
      <p>GitHub repository</p>
      {status === 'ready' ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            disabled={disabled}
            className="flex h-10 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <GitFork aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">
              {repository || 'No repositories found'}
            </span>
            <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground" />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-96 overflow-hidden p-0">
            <div className="flex h-10 items-center gap-2 border-b border-border px-3">
              <Search aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <input
                value={query}
                aria-label="Search GitHub repositories"
                placeholder="Search repositories…"
                onChange={(event) => setQuery(event.currentTarget.value)}
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="max-h-72 overflow-y-auto p-1.5">
              {matches.map((item) => (
                <button
                  key={item.nameWithOwner}
                  type="button"
                  onClick={() => onSelect(item.nameWithOwner)}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent',
                    item.nameWithOwner === repository && 'bg-accent'
                  )}
                >
                  {item.private ? (
                    <LockKeyhole
                      aria-label="Private repository"
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    />
                  ) : (
                    <GitFork
                      aria-label="Public repository"
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-mono text-xs">{item.nameWithOwner}</span>
                      {item.nameWithOwner === repository && (
                        <Check aria-hidden="true" className="ml-auto size-3.5" />
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
                      {item.description || 'No description'}
                    </span>
                    <span className="mt-1 flex items-center gap-1 text-2xs text-muted-foreground">
                      <Clock3 aria-hidden="true" className="size-3" />
                      Updated {new Date(item.updatedAt).toLocaleDateString()}
                    </span>
                  </span>
                </button>
              ))}
              {matches.length === 0 && (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No repositories match “{query}”.
                </p>
              )}
            </div>
          </PopoverContent>
        </Popover>
      ) : (
        <div className="rounded-md border border-notice-border bg-notice p-3 text-xs text-notice-foreground">
          <p>{status === 'loading' ? 'Loading GitHub repositories…' : detail}</p>
          {status !== 'loading' && (
            <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
              Try again
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function ConfirmationNotice({
  confirmation,
  busy,
  onDismiss,
  onConfirm
}: {
  confirmation: RootConfirmation
  busy: boolean
  onDismiss: () => void
  onConfirm: (root: string) => void
}): React.JSX.Element {
  return (
    <div role="alert" className="mt-4 rounded-md border border-notice-border bg-notice p-3 text-xs">
      <p className="font-mono break-all select-text">{confirmation.chosen}</p>
      <p>That folder is inside a Project. Git resolves its root to:</p>
      <p className="mt-1 font-mono break-all select-text">{confirmation.root}</p>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={onDismiss}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy} onClick={() => onConfirm(confirmation.root)}>
          Add this Project
        </Button>
      </div>
    </div>
  )
}

function RefusalNotice({
  refusal,
  busy,
  onDismiss,
  onInitialize
}: {
  refusal: Refusal
  busy: boolean
  onDismiss: () => void
  onInitialize: (path: string) => void
}): React.JSX.Element {
  return (
    <div role="alert" className="mt-4 rounded-md border border-notice-border bg-notice p-3 text-xs">
      {refusal.reason === 'not-a-repository' ? (
        <>
          <p>This folder is not under Git yet:</p>
          <p className="mt-1 font-mono break-all select-text">{refusal.path}</p>
          <p className="mt-1 text-muted-foreground">
            Setting it up runs <span className="font-mono">git init</span> there and changes nothing
            else.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={onDismiss}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy} onClick={() => onInitialize(refusal.path)}>
              Set up Git here
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>Git could not be found, so this folder could not be added.</p>
          <div className="mt-3 flex justify-end">
            <Button size="sm" onClick={onDismiss}>
              Close
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
