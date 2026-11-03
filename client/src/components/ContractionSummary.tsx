import { safeColour } from '../lib/colours.ts'
import { recentStats } from '../lib/gaps.ts'
import { formatDuration, useNow } from '../lib/time.ts'
import type { Event, Tracker } from '../types.ts'

/**
 * The last hour of one `gaps` tracker at a glance — how many, how long, how
 * often. These are the three numbers a midwife asks for on the phone, so they
 * are written out rather than charted.
 *
 * Renders nothing until there are two in the hour: one contraction has a
 * length but no rhythm yet, and "every —" would be a card that says nothing.
 *
 * Colour discipline as on every surface (THEME.md): the tracker colour lives
 * only in the dot.
 */
export function ContractionSummary({ tracker, events }: { tracker: Tracker; events: Event[] }) {
  // The hour slides; a quarter-minute is fine-grained enough for an average.
  const now = useNow(15_000)
  const stats = recentStats(events, tracker.id, now)
  if (stats.count < 2) return null

  const colour = safeColour(tracker.colour)
  const parts = [
    `${stats.count} ${tracker.name.toLowerCase()}`,
    stats.avgDuration !== null ? `avg ${formatDuration(stats.avgDuration)} long` : null,
    stats.avgFrequency !== null ? `every ${formatDuration(stats.avgFrequency)}` : null,
  ].filter((p): p is string => p !== null)

  return (
    <section
      aria-label={`${tracker.name}, last hour: ${parts.join(', ')}`}
      className="anim-fade rounded-tile hairline bg-ink-850 px-5 py-3.5"
    >
      <div aria-hidden className="flex items-center gap-2">
        <span className="size-[7px] rounded-full" style={{ background: colour }} />
        <span className="stencil">last hour</span>
      </div>
      <p aria-hidden className="digits mt-1.5 text-[15px] leading-snug tracking-[-0.01em]">
        {parts.map((part, i) => (
          <span key={part}>
            {i > 0 ? <span className="text-text-dim opacity-55">{' · '}</span> : null}
            {part}
          </span>
        ))}
      </p>
    </section>
  )
}
