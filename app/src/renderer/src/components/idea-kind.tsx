import { Lightbulb, Wrench, type LucideIcon } from 'lucide-react'
import type { IdeaKind } from '@shared/contract'

interface IdeaKindMeta {
  label: string
  hint: string
  icon: LucideIcon
}

export const IDEA_KIND_META: Record<IdeaKind, IdeaKindMeta> = {
  software: {
    label: 'Software Idea',
    hint: 'Develops into an MVP Spec and tickets',
    icon: Wrench
  },
  general: {
    label: 'General Idea',
    hint: 'Free-form thought without engineering phases',
    icon: Lightbulb
  }
}

export function IdeaKindIcon({ kind }: { kind: IdeaKind }): React.JSX.Element {
  const meta = IDEA_KIND_META[kind]
  return <meta.icon aria-label={meta.label} role="img" className="size-3.5 shrink-0" />
}
