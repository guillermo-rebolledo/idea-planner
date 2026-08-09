/** PROTOTYPE — one shared simulated flow so variants compare the same state. */
export type VariantKey = 'A' | 'B' | 'C'
export type Scenario = 'source' | 'configure' | 'cloning' | 'failed'
export type SourceKind = 'local' | 'url' | 'github'

export interface FlowState {
  scenario: Scenario
  source: SourceKind
  repository: string
  destination: string
}

export interface VariantProps {
  state: FlowState
  setScenario: (scenario: Scenario) => void
  setSource: (source: SourceKind) => void
  setRepository: (repository: string) => void
  setDestination: (destination: string) => void
}

export const SCENARIOS: Scenario[] = ['source', 'configure', 'cloning', 'failed']

export const SOURCE_COPY: Record<SourceKind, { title: string; description: string }> = {
  local: { title: 'Local folder', description: 'Browse a folder on disk' },
  url: { title: 'Git URL', description: 'Clone from an HTTPS or SSH URL' },
  github: { title: 'GitHub repository', description: 'Clone GitHub owner/repo' }
}

export function readVariant(): VariantKey {
  const value = new URLSearchParams(window.location.search).get('variant')?.toUpperCase()
  return value === 'B' || value === 'C' ? value : 'A'
}

export function readScenario(): Scenario {
  const value = new URLSearchParams(window.location.search).get('state')
  return SCENARIOS.find((scenario) => scenario === value) ?? 'source'
}
