/**
 * The numbers under the ribbon — one card per tracker that logged anything.
 *
 * The hierarchy is deliberate. Count, total and average are the arithmetic you
 * would expect; **longest gap** is the one that answers a real question at 4am
 * ("how long did she actually go?"), so it gets the large digits and the window
 * it happened in. Everything else is a small caption around it.
 *
 * Text never wears the tracker colour — a pastel at 80% lightness is not a
 * legible label. Identity comes from the dot beside it, as everywhere else.
 */

import { tintedBorder, tintedSurface, safeColour } from '../lib/colours.ts'
import { endOfDay, isToday } from '../lib/days.ts'
import type { TrackerDayStats } from '../lib/stats.ts'
import { formatClock, formatDuration } from '../lib/time.ts'

export function DayStats({
  stats,
  day,
  now,
}: {
  stats: TrackerDayStats[]
  /** Local midnight of the day shown — decides whether "since last" is meaningful. */
  day: number
  now: number
}) {
  const logged = stats.filter((s) => s.count > 0)
  const silent = stats.filter((s) => s.count === 0)

  if (logged.length === 0) {
    return (
      <p className="text-[17px] leading-snug text-balance text-text-dim">
        Nothing logged on this day.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2.5">
      {logged.map((entry) => (
        <StatCard key={entry.tracker.id} entry={entry} day={day} now={now} />
      ))}

      {silent.length > 0 ? (
        <p className="stencil pt-1">
          nothing logged · {silent.map((s) => s.tracker.name).join(' · ')}
        </p>
      ) : null}
    </div>
  )
}

function StatCard({
  entry,
  day,
  now,
}: {
  entry: TrackerDayStats
  day: number
  now: number
}) {
  const colour = safeColour(entry.tracker.colour)
  const isSpan = entry.tracker.type === 'INTERVAL'
  const today = isToday(day)

  return (
    <article
      className="rounded-2xl border p-4"
      style={{ background: tintedSurface(colour, 7), borderColor: tintedBorder(colour, 20) }}
    >
      <header className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ background: colour, boxShadow: `0 0 8px ${colour}` }}
        />
        <h3 className="min-w-0 flex-1 truncate text-[16px] leading-none font-medium tracking-[-0.02em]">
          {entry.tracker.name}
        </h3>
        <span className="stencil">{isSpan ? 'span' : 'moment'}</span>
      </header>

      {/* The number the section exists for. */}
      <div className="mt-3.5 border-b border-ink-700/70 pb-3.5">
        <p className="stencil">longest gap</p>
        <p className="digits mt-1.5 text-[26px] leading-none tracking-[-0.02em]">
          {entry.longestGapMs === null ? (
            <span className="text-[17px] text-text-dim">
              {entry.count === 1 ? 'one event — no gap yet' : 'no gap'}
            </span>
          ) : (
            formatDuration(entry.longestGapMs)
          )}
        </p>
        {entry.longestGapMs !== null && entry.gapFrom !== null && entry.gapTo !== null ? (
          <p className="digits mt-1.5 text-[12px] text-text-dim">
            {formatClock(entry.gapFrom)} → {formatClock(entry.gapTo)}
          </p>
        ) : null}
      </div>

      <dl className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-3">
        <Stat label="count" value={`${entry.count}`} />

        {today ? (
          <Stat
            label="since last"
            value={entry.lastAt === null ? '—' : entry.running ? 'running' : formatDuration(now - entry.lastAt)}
          />
        ) : (
          <Stat label="last at" value={endClock(entry.lastAt, day)} />
        )}

        {isSpan ? (
          <>
            <Stat label="total" value={formatDuration(entry.totalMs ?? 0)} />
            <Stat label="average" value={formatDuration(entry.averageMs ?? 0)} />
          </>
        ) : null}
      </dl>

      {isSpan && entry.segments.some((s) => s.clippedStart || s.clippedEnd) ? (
        <p className="mt-3 text-[12px] leading-snug text-text-dim">
          A span crosses midnight — totals count only the part inside this day.
        </p>
      ) : null}
    </article>
  )
}

/**
 * The clock time an event finished at, on this day. A span clipped at the
 * day's end lands exactly on the next midnight, which `formatClock` would
 * render as `00:00` — the *start* of the day, which is the opposite of what
 * happened. It reads as `24:00` instead.
 */
function endClock(lastAt: number | null, day: number): string {
  if (lastAt === null) return '—'
  return lastAt >= endOfDay(day) ? '24:00' : formatClock(lastAt)
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="stencil">{label}</dt>
      <dd className="digits mt-1.5 text-[15px] leading-none">{value}</dd>
    </div>
  )
}
