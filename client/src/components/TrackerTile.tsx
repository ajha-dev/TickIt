import { safeColour, tintedBorder, tintedSurface } from '../lib/colours.ts'
import { GAP_BREAK_MS } from '../lib/gaps.ts'
import { formatDuration, useElapsed } from '../lib/time.ts'
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
  label,
  lastStartAt,
}: {
  tracker: Tracker
  running: boolean
  onTap: () => void
  /**
   * When the newest span of a `gaps` tracker began — the "since last" clock.
   * Start, not end, so it counts the same way the timeline's "every …" does
   * and the next one reads as due when it nears the usual frequency.
   */
  lastStartAt?: number | null
  /**
   * Overrides the spoken label. The same tile is a log button in normal mode
   * and a settings button in edit mode, so the default "Log Water" would tell a
   * screen-reader user the opposite of what the control now does.
   */
  label?: string
}) {
  const colour = safeColour(tracker.colour)
  const isSpan = tracker.type === 'INTERVAL'

  return (
    <button
      type="button"
      onClick={onTap}
      aria-label={label ?? `${isSpan ? (running ? 'Restart' : 'Start') : 'Log'} ${tracker.name}`}
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
        {/* Not while running: the running card already has the live clock. */}
        {lastStartAt != null && !running ? <SinceLast startAt={lastStartAt} /> : null}
      </div>
    </button>
  )
}

/** Only a tile with something to count from subscribes to the clock. */
function SinceLast({ startAt }: { startAt: number }) {
  const elapsed = useElapsed(startAt)
  // Past the break it is a new session, not a long wait — say nothing.
  if (elapsed > GAP_BREAK_MS) return null
  return (
    <p
      className="digits mt-1.5 truncate text-[11px] leading-none text-text-dim"
      aria-label={`${formatDuration(elapsed)} since the last one started`}
    >
      <span aria-hidden>since last {formatDuration(elapsed)}</span>
    </p>
  )
}
