import { safeColour } from '../lib/colours.ts'
import type { Tracker } from '../types.ts'

/**
 * One tap logs. The tile is 132px tall and half the screen wide — far past the
 * 44px minimum, because this gets hit in the dark without looking at it.
 *
 * The glyph carries the type: a filled dot is a Moment (one instant), a bar
 * with a leading cap is a Span (something that runs).
 */
export function TrackerTile({
  tracker,
  running,
  onTap,
}: {
  tracker: Tracker
  running: boolean
  onTap: () => void
}) {
  const colour = safeColour(tracker.colour)
  const isSpan = tracker.type === 'INTERVAL'

  return (
    <button
      type="button"
      onClick={onTap}
      aria-label={`${isSpan ? (running ? 'Restart' : 'Start') : 'Log'} ${tracker.name}`}
      className="tap relative flex min-h-[132px] flex-col justify-between overflow-hidden rounded-tile border p-4 text-left active:brightness-[1.25]"
      style={{
        borderColor: running
          ? `color-mix(in oklab, ${colour} 45%, transparent)`
          : `color-mix(in oklab, ${colour} 20%, transparent)`,
        background: `linear-gradient(158deg, color-mix(in oklab, ${colour} ${running ? 16 : 9}%, var(--color-ink-850)), var(--color-ink-900) 78%)`,
      }}
    >
      <div className="flex items-center gap-2">
        {isSpan ? (
          <span aria-hidden className="flex items-center gap-[3px]">
            <span className="size-[7px] rounded-full" style={{ background: colour }} />
            <span
              className="h-[3px] w-4 rounded-full"
              style={{ background: `color-mix(in oklab, ${colour} 55%, transparent)` }}
            />
          </span>
        ) : (
          <span
            aria-hidden
            className="size-[7px] rounded-full"
            style={{ background: colour, boxShadow: `0 0 10px ${colour}` }}
          />
        )}
        <span className="stencil">{isSpan ? (running ? 'Running' : 'Span') : 'Moment'}</span>
      </div>

      <h3 className="text-[20px] leading-[1.1] font-semibold tracking-[-0.025em] text-bone [overflow-wrap:anywhere]">
        {tracker.name}
      </h3>
    </button>
  )
}
