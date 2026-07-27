import { safeColour, tintedBorder, tintedSurface } from '../lib/colours.ts'
import type { Tracker } from '../types.ts'

/**
 * One tap logs. The tile is 132px tall and half the screen wide — far past the
 * 44px minimum, because this gets hit in the dark without looking at it.
 *
 * The glyph carries the type: a filled dot is a Moment (one instant), a bar
 * with a leading cap is a Span (something that runs).
 *
 * Colour discipline (THEME.md): the tracker colour appears at 9–14% mixed into
 * --ink-850 for the field, at full chroma only in the 7px glyph and the 1px
 * border, and never in the label — the name is always --text, because no pastel
 * clears 4.5:1 as text on a tinted tile.
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
      className="tap relative flex min-h-[132px] flex-col justify-between overflow-hidden rounded-tile border p-4 text-left active:brightness-[1.3]"
      style={{
        borderColor: tintedBorder(colour, running ? 44 : 20),
        background: `linear-gradient(158deg, ${tintedSurface(colour, running ? 14 : 9)}, var(--ink-900) 82%)`,
      }}
    >
      <div className="flex items-center gap-2">
        {isSpan ? (
          <span aria-hidden className="flex items-center gap-[3px]">
            <span className="size-[7px] rounded-full" style={{ background: colour }} />
            <span
              className="h-[3px] w-4 rounded-full"
              style={{ background: tintedBorder(colour, 55) }}
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

      <div>
        <h3 className="text-[20px] leading-[1.1] font-semibold tracking-[-0.025em] text-text [overflow-wrap:anywhere]">
          {tracker.name}
        </h3>
        {/* Names the question rather than counting fields — with one field
            there is a real answer to "what will it ask me?". "asks" not
            "requires": the sheet opens after the event is already saved. */}
        {tracker.fields[0] ? (
          <p className="mt-1.5 truncate text-[11px] leading-none text-text-dim">
            asks {tracker.fields[0].label.toLowerCase()}
          </p>
        ) : null}
      </div>
    </button>
  )
}
