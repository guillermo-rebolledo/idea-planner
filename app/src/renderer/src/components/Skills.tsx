import { useEffect, useId, useRef, useState, type Ref, type RefObject } from 'react'
import { SKILL_ATTRIBUTION } from '@shared/contract'
import type { HarnessId, SkillCatalog } from '@shared/contract'
import { skillFromDraft } from '@shared/skill'
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
  /** Queue pausing can mean a queued Project Skill lost trust at its launch gate. */
  refreshWhenQueuePaused?: boolean
}): [SkillCatalog | null, (catalog: SkillCatalog) => void] {
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null)
  const { projectRoot, harness, refreshWhenQueuePaused } = input
  useEffect(() => {
    if (!harness || !projectRoot) return
    void window.shell.listSkills({ projectRoot, harness }).then(setCatalog, () => undefined)
  }, [harness, projectRoot, refreshWhenQueuePaused])
  return [catalog, setCatalog]
}

/**
 * What the message is asking for, and null when its leading token does not name
 * an offered Skill. The visible draft is the source of truth: editing the token
 * edits the Run configuration, and a catalog change withdraws recognition
 * without rewriting what the person typed.
 */
export function skillInDraft(catalog: SkillCatalog | null, draft: string): string | null {
  return catalog ? (skillFromDraft(catalog.available, draft)?.name ?? null) : null
}

/** Refocuses after React has rendered a completed token, ready for the prompt. */
export function focusTextareaAtEnd(ref: RefObject<HTMLTextAreaElement | null>): void {
  window.requestAnimationFrame(() => {
    const textarea = ref.current
    if (!textarea) return
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  })
}

/** Moves keyboard focus from the textarea into one edge of its open Skill list. */
export function focusSkillSuggestion(
  ref: RefObject<HTMLUListElement | null>,
  edge: 'first' | 'last'
): boolean {
  const suggestions = ref.current?.querySelectorAll<HTMLButtonElement>('[data-skill-suggestion]')
  if (!suggestions?.length) return false
  suggestions[edge === 'first' ? 0 : suggestions.length - 1]?.focus()
  return true
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
  onChoose,
  listRef
}: {
  matching: SkillCatalog['available']
  onChoose: (name: string) => void
  listRef?: Ref<HTMLUListElement>
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-popover shadow-sm">
      <PopoverHeading>Skills</PopoverHeading>
      <ul ref={listRef} aria-label="Skills" className="max-h-40 overflow-y-auto px-1 pb-1">
        {matching.length === 0 && (
          <li className="px-1.5 py-1.5 text-xs text-muted-foreground">
            No installed Skill matches. Keep typing your message — a Skill is optional.
          </li>
        )}
        {matching.map((entry, index) => (
          <li key={`${entry.source}:${entry.name}`}>
            <button
              type="button"
              data-skill-suggestion
              className="flex w-full flex-col items-start rounded-md px-1.5 py-1.5 text-left hover:bg-muted/60"
              onClick={() => onChoose(entry.name)}
              onKeyDown={(event) => {
                const unmodified =
                  !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
                if (unmodified && (event.key === 'Enter' || event.key === 'Tab')) {
                  event.preventDefault()
                  onChoose(entry.name)
                  return
                }
                if (unmodified && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                  event.preventDefault()
                  const suggestions = event.currentTarget
                    .closest('ul')
                    ?.querySelectorAll<HTMLButtonElement>('[data-skill-suggestion]')
                  if (!suggestions?.length) return
                  const offset = event.key === 'ArrowDown' ? 1 : -1
                  const nextIndex = (index + offset + suggestions.length) % suggestions.length
                  suggestions[nextIndex]?.focus()
                }
              }}
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
          lives with the list it is about — and only when there is a list, so
          "no match, keep typing" is not chaperoned by a licence. */}
      {matching.length > 0 && (
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
      )}
    </div>
  )
}

/**
 * A plain textarea with a presentation layer directly beneath it. The native
 * control still owns text, selection, composition, undo, and accessibility;
 * the mirrored layer only makes the recognized leading token read as a pill.
 */
export function SkillAwareTextarea({
  value,
  skill,
  textareaRef,
  onScroll,
  'aria-describedby': describedBy,
  ...props
}: {
  value: string
  skill: string | null
  textareaRef?: Ref<HTMLTextAreaElement>
} & Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  'className' | 'value'
>): React.JSX.Element {
  const mirrorRef = useRef<HTMLDivElement>(null)
  const recognitionId = useId()
  const tokenLength = skill ? skill.length + 1 : 0
  const description = [describedBy, skill ? recognitionId : null].filter(Boolean).join(' ')

  function syncScroll(target: HTMLTextAreaElement): void {
    if (!mirrorRef.current) return
    mirrorRef.current.scrollTop = target.scrollTop
    mirrorRef.current.scrollLeft = target.scrollLeft
  }

  return (
    <div className="relative">
      <div
        ref={mirrorRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-x-hidden overflow-y-scroll px-3 pt-3 pb-1 text-sm break-words whitespace-pre-wrap text-foreground"
      >
        {skill ? (
          <>
            <mark className="rounded-sm bg-primary/10 text-primary ring-1 ring-primary/25">
              {value.slice(0, tokenLength)}
            </mark>
            {value.slice(tokenLength)}
          </>
        ) : (
          value
        )}
      </div>
      <textarea
        {...props}
        ref={textareaRef}
        value={value}
        aria-describedby={description || undefined}
        className="relative block w-full resize-none overflow-y-scroll bg-transparent px-3 pt-3 pb-1 text-sm text-transparent caret-foreground outline-none placeholder:text-muted-foreground"
        onScroll={(event) => {
          syncScroll(event.currentTarget)
          onScroll?.(event)
        }}
      />
      {skill && (
        <span id={recognitionId} className="sr-only">
          {skill} Skill recognized
        </span>
      )}
    </div>
  )
}
