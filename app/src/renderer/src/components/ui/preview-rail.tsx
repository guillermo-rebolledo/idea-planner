/**
 * A tall list stood on its edge: one hairline tick per item, the ticks nearest
 * the pointer growing into a small pyramid, and a card that slides along the
 * rail showing whatever the caller wants said about the item under the cursor.
 *
 * After beui's Preview Rail (`https://beui.dev/components/motion/preview-rail`),
 * rebuilt on this app's terms: the original leans on `motion/react` for the
 * tick springs and a shared-element card, and this app carries no animation
 * runtime. Both effects survive the translation — every row has the same
 * height, so the "shared element" is one card that transforms between rows,
 * and the pyramid is a scale transition per tick. The motion is therefore CSS,
 * and the reduced-motion rule in `styles.css` already switches all of it off.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@renderer/lib/utils'

export interface PreviewRailItem {
  /** Identity of the row, and what a selection hands back to the caller. */
  id: string
  /** The accessible name of the tick. */
  label: string
}

interface PreviewRailProps<Item extends PreviewRailItem> {
  items: Item[]
  /** Names the rail for a screen reader — it is a navigation landmark. */
  label: string
  /** The row the surface itself considers current, drawn when nothing is hovered. */
  activeId?: string | null
  onSelect?: (item: Item) => void
  renderPreview: (item: Item) => React.ReactNode
  /** The pitch of one tick in pixels. Condensed when the rail runs out of height. */
  itemSize?: number
  /** How long a tick is at full extension, in pixels. */
  tickLength?: number
  /** Width of the card the preview is drawn into. */
  previewWidth?: number
  className?: string
}

/** How long a tick is when nothing is being read and it is not the reader's. */
const REST_SCALE = 0.5

/** How far a tick retracts by its distance from the one being read. */
function tickScale(distance: number): number {
  if (distance === 0) return 1
  if (distance === 1) return 0.68
  if (distance === 2) return 0.44
  return 0.25
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high))
}

/** The height of an element, kept current while it and the window resize. */
function useMeasuredHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry !== undefined) setHeight(entry.contentRect.height)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [ref])
  return height
}

export function PreviewRail<Item extends PreviewRailItem>({
  items,
  label,
  activeId = null,
  onSelect,
  renderPreview,
  itemSize = 9,
  tickLength = 18,
  previewWidth = 288,
  className
}: PreviewRailProps<Item>): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const rootHeight = useMeasuredHeight(rootRef)
  const cardHeight = useMeasuredHeight(cardRef)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)

  const known = (id: string | null): string | null =>
    id !== null && items.some((item) => item.id === id) ? id : null
  const readId = known(hoveredId) ?? known(focusedId)
  const currentId = known(activeId)
  const readIndex = items.findIndex((item) => item.id === readId)

  /* The rail never grows past the room it was given: past that it condenses,
     so a hundred-turn conversation is still one rail and not a scroller
     inside a scroller. */
  const pitch =
    rootHeight > 0 && items.length > 0
      ? clamp(Math.floor((rootHeight - 32) / items.length), 6, itemSize)
      : itemSize
  const railHeight = pitch * items.length

  /* The card is mounted whether or not it is being read, so that letting go
     of the rail fades it out in place instead of cutting it. */
  const lastReadIdRef = useRef<string | null>(null)
  if (readId !== null) lastReadIdRef.current = readId
  const shownId = readId ?? lastReadIdRef.current
  const shown = useMemo(() => items.find((item) => item.id === shownId) ?? null, [items, shownId])
  const shownIndex = items.findIndex((item) => item.id === shownId)
  const rowCenter = (rootHeight - railHeight) / 2 + Math.max(shownIndex, 0) * pitch + pitch / 2
  const cardTop = clamp(rowCenter - cardHeight / 2, 8, rootHeight - cardHeight - 8)

  /* The ticks are hairlines with gaps between them, and a gap is not a thing
     anyone means to point at. The rail as a whole takes the pointer and reads
     the row off its position, so the strip has no dead bands in it. */
  const readPointer = useCallback(
    (clientY: number): void => {
      const nav = navRef.current
      if (nav === null || items.length === 0) return
      const bounds = nav.getBoundingClientRect()
      const index = clamp(Math.floor((clientY - bounds.top) / pitch), 0, items.length - 1)
      setHoveredId(items[index]?.id ?? null)
    },
    [items, pitch]
  )

  /* One tab stop for the whole rail, arrows between the ticks: the pattern a
     list of like controls is meant to use, and the only one that stays usable
     when a conversation has fifty turns in it. */
  const tabbableId = known(focusedId) ?? currentId ?? items[0]?.id ?? null
  const moveFocus = (from: number, delta: number): void => {
    const target = items[clamp(from + delta, 0, items.length - 1)]
    if (target === undefined) return
    navRef.current?.querySelector<HTMLButtonElement>(`[data-item-id="${target.id}"]`)?.focus()
  }

  return (
    <div
      ref={rootRef}
      className={cn('pointer-events-none isolate flex items-center', className)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(null)
      }}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions --
          the pointer listeners only widen the hover target of the buttons
          inside; every way to actually operate the rail is one of those
          buttons, and nothing here is reachable by pointer alone. */}
      <nav
        ref={navRef}
        aria-label={label}
        style={{
          gridTemplateRows: `repeat(${String(items.length)}, ${String(pitch)}px)`,
          width: tickLength
        }}
        className="pointer-events-auto grid shrink-0 content-center"
        onPointerMove={(event) => {
          readPointer(event.clientY)
        }}
        onPointerLeave={() => {
          setHoveredId(null)
        }}
        onKeyDown={(event) => {
          const focused = document.activeElement?.getAttribute('data-item-id') ?? focusedId
          const at = Math.max(
            items.findIndex((item) => item.id === focused),
            0
          )
          if (event.key === 'ArrowDown') moveFocus(at, 1)
          else if (event.key === 'ArrowUp') moveFocus(at, -1)
          else if (event.key === 'Home') moveFocus(0, 0)
          else if (event.key === 'End') moveFocus(items.length - 1, 0)
          else return
          event.preventDefault()
        }}
      >
        {items.map((item, index) => {
          const read = item.id === readId
          const current = item.id === currentId
          /* At rest the rail is a legible ruler with the reader's place marked
             on it. It only collapses into the pyramid once there is a row
             being read, because that is the only time the shape means
             anything. */
          const scale =
            read || (readIndex < 0 && current)
              ? 1
              : readIndex < 0
                ? REST_SCALE
                : tickScale(Math.abs(index - readIndex))
          return (
            <button
              key={item.id}
              type="button"
              data-item-id={item.id}
              aria-label={item.label}
              aria-current={current ? 'location' : undefined}
              tabIndex={item.id === tabbableId ? 0 : -1}
              style={{ height: pitch, width: tickLength }}
              onFocus={(event) => {
                if (event.currentTarget.matches(':focus-visible')) setFocusedId(item.id)
              }}
              onPointerDown={() => {
                setFocusedId(null)
              }}
              onClick={() => {
                onSelect?.(item)
              }}
              className="flex items-center rounded-xs outline-offset-2"
            >
              <span
                aria-hidden="true"
                style={{ transform: `scaleX(${String(scale)})`, width: tickLength }}
                className={cn(
                  'block h-0.5 origin-left rounded-full bg-current',
                  'transition-[transform,color] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
                  'motion-reduce:transition-none',
                  read || current ? 'text-foreground' : 'text-muted-foreground/60'
                )}
              />
            </button>
          )
        })}
      </nav>

      {/* The slider carries the card between rows; the card itself only comes
          and goes. Two elements so neither transform has to know the other. */}
      <div
        aria-hidden="true"
        style={{ transform: `translateY(${String(Math.round(cardTop))}px)`, width: previewWidth }}
        className={cn(
          'absolute top-0 left-full z-50 ml-2',
          'transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
          'motion-reduce:transition-none'
        )}
      >
        <div
          ref={cardRef}
          data-open={readId !== null}
          className={cn(
            'origin-left transition-[opacity,filter,scale,translate] duration-200 ease-out',
            'motion-reduce:transition-none',
            'data-[open=false]:-translate-x-1 data-[open=false]:scale-[0.98]',
            'data-[open=false]:opacity-0 data-[open=false]:blur-[6px]'
          )}
        >
          {shown !== null && (
            <div key={shown.id} className="preview-rise">
              {renderPreview(shown)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
