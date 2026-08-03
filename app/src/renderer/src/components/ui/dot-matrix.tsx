import { cn } from '@renderer/lib/utils'

/**
 * A 5×5 dot-matrix running indicator, after assistant-ui's dot matrix: SVG
 * circles in `currentColor`, each breathing on one shared CSS keyframe
 * (`styles.css`) offset along the diagonal so the grid reads as a wave.
 *
 * Deterministic on purpose — the delays are a function of the dot's position,
 * so nothing runs after render and reduced motion leaves every dot resting at
 * its quiet opacity instead of pulsing.
 */

const GRID = 5
/** viewBox units between dot centres. */
const STEP = 4

export function DotMatrix({
  label = 'Working',
  className
}: {
  /** What a screen reader hears the grid as. */
  label?: string
  className?: string
}): React.JSX.Element {
  return (
    <svg role="img" aria-label={label} viewBox="0 0 20 20" className={cn('size-4', className)}>
      {Array.from({ length: GRID * GRID }, (_, index) => {
        const row = Math.floor(index / GRID)
        const column = index % GRID
        return (
          <circle
            key={`${String(row)}:${String(column)}`}
            cx={column * STEP + STEP / 2}
            cy={row * STEP + STEP / 2}
            r={1.3}
            fill="currentColor"
            className="dot-matrix-dot"
            style={{ animationDelay: `${String((row + column) * 110)}ms` }}
          />
        )
      })}
    </svg>
  )
}
