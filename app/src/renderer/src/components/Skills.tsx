import { useEffect, useState } from 'react'
import { SKILL_ATTRIBUTION } from '@shared/contract'
import type { HarnessId, SkillCatalog } from '@shared/contract'
import { PopoverHeading } from '@renderer/components/ui/chip-popover'

/**
 * Asking a message for a methodology, wherever a message is written. Both
 * composers — the launch screen and the Conversation — offer the same `/`, so
 * the offer is written once: two implementations of "what Skills are there"
 * would be two answers to the same question.
 *
 * Skills are installed and removed by the person, in their own directories,
 * so what is available is read rather than remembered.
 */
export function useSkillCatalog(input: {
  projectRoot: string
  harness: HarnessId | null
}): [SkillCatalog | null, (catalog: SkillCatalog) => void] {
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null)
  const { projectRoot, harness } = input
  useEffect(() => {
    if (!harness || !projectRoot) return
    void window.shell.listSkills({ projectRoot, harness }).then(setCatalog, () => undefined)
  }, [harness, projectRoot])
  return [catalog, setCatalog]
}

/**
 * What the message is asking for, and null when it asks for nothing. Derived
 * rather than corrected: a Skill the catalog stops offering — the Project's
 * trust withdrawn, the directory deleted — is one this message no longer asks
 * for, without a round of state chasing the catalog.
 */
export function offeredSkill(catalog: SkillCatalog | null, chosen: string | null): string | null {
  return chosen && catalog?.available.some((entry) => entry.name === chosen) ? chosen : null
}

/**
 * The Skills a draft is asking to see. `/` at the start of an otherwise empty
 * message asks what methodologies there are; anywhere else it is just a
 * slash, because most messages contain paths.
 */
export function skillsMatching(
  catalog: SkillCatalog | null,
  draft: string
): SkillCatalog['available'] | null {
  const query = /^\/(\S*)$/.exec(draft)?.[1] ?? null
  if (query === null) return null
  return (catalog?.available ?? []).filter((entry) => entry.name.includes(query))
}

/** The list `/` opens, above the field it belongs to. */
export function SkillSuggestions({
  matching,
  onChoose
}: {
  matching: SkillCatalog['available']
  onChoose: (name: string) => void
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-popover shadow-sm">
      <PopoverHeading>Skills</PopoverHeading>
      <ul aria-label="Skills" className="max-h-40 overflow-y-auto px-1 pb-1">
        {matching.length === 0 && (
          <li className="px-1.5 py-1.5 text-xs text-muted-foreground">
            No installed Skill matches. Keep typing your message — a Skill is optional.
          </li>
        )}
        {matching.map((entry) => (
          <li key={`${entry.source}:${entry.name}`}>
            <button
              type="button"
              className="flex w-full flex-col items-start rounded-md px-1.5 py-1.5 text-left hover:bg-muted/60"
              onClick={() => onChoose(entry.name)}
            >
              <span className="text-xs font-medium">
                {entry.name}
                {entry.source === 'project' && (
                  <span className="ml-1 font-normal text-muted-foreground">this Project</span>
                )}
              </span>
              {entry.description && (
                <span className="text-xs text-muted-foreground">{entry.description}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {/* Owed where Skills are offered, not paid on every screen: the notice
          lives with the list it is about, and nowhere else. */}
      <footer className="border-t border-border px-2.5 py-1.5 text-2xs text-muted-foreground">
        {SKILL_ATTRIBUTION.notice}{' '}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => void window.shell.openExternalLink(SKILL_ATTRIBUTION.website)}
        >
          {SKILL_ATTRIBUTION.author}’s website
        </button>{' '}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => void window.shell.openExternalLink(SKILL_ATTRIBUTION.repository)}
        >
          skills repository ({SKILL_ATTRIBUTION.licence})
        </button>
      </footer>
    </div>
  )
}

/**
 * What this message is asking for, said where it was asked for. Per message,
 * not per Session: real work switches methodology inside one thread of
 * context, so a Skill never quietly outlives the message it was chosen for.
 */
export function ChosenSkillNote({
  name,
  onClear
}: {
  name: string
  onClear: () => void
}): React.JSX.Element {
  return (
    <p className="text-xs text-muted-foreground">
      This message asks for the <span className="font-medium text-foreground">{name}</span> Skill.{' '}
      <button type="button" className="underline underline-offset-2" onClick={onClear}>
        Send without it
      </button>
    </p>
  )
}
