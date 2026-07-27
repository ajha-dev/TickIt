/**
 * Dashboard — one tracker, charted over time.
 *
 * The question this screen answers is "when do feeds happen?", and the shape
 * that answers it is an actogram: days across, time of day down, every event a
 * mark in its day's column. A calendar of counts was tried here first and could
 * not answer it — a day cell can say *how many*, never *when*.
 *
 * One tracker at a time is the deliberate constraint. Overlaying two trackers
 * on the same 24-hour field turns a legible raster into confetti, and the
 * comparison it appears to offer is not one anybody asked for.
 */

import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'wouter'

import { Actogram, ActogramLegend } from '../components/Actogram.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { safeColour } from '../lib/colours.ts'
import { addDays, endOfDay, startOfDay } from '../lib/days.ts'
import { useEventRange, EVENT_LIMIT } from '../lib/eventWindow.ts'
import { useTrackers } from '../lib/queries.ts'
import { seriesScheme } from '../lib/series.ts'
import { columnsFor, dayRange, SPAN_LOOKBACK_MS } from '../lib/stats.ts'
import { useNow } from '../lib/time.ts'
import type { Event, Profile, Tracker } from '../types.ts'

/** A fortnight is what a pattern needs to be visible without being a wall. */
const RANGES = [14, 30, 60] as const
type Range = (typeof RANGES)[number]

export function DashboardScreen({ profile }: { profile: Profile }) {
  const profileId = profile.id
  // A minute is plenty: the only live thing here is the open end of a running
  // span, and it moves a pixel an hour on this scale.
  const now = useNow(60_000)

  const [range, setRange] = useState<Range>(14)
  const [trackerId, setTrackerId] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)

  const trackersQuery = useTrackers(profileId)
  const trackers = useMemo(() => trackersQuery.data ?? [], [trackersQuery.data])

  // Chartable trackers are the active ones, plus whichever is being shown —
  // archiving hides a tracker from the home grid, it does not erase its
  // history, so a chart already open on one stays open.
  const selectable = useMemo(
    () => trackers.filter((t) => t.archivedAt === null || t.id === trackerId),
    [trackers, trackerId],
  )

  const tracker: Tracker | null =
    selectable.find((t) => t.id === trackerId) ?? selectable[0] ?? null

  // The remembered choice is per profile: switching context should not leave a
  // dangling id from the last one.
  useEffect(() => {
    setTrackerId(null)
  }, [profileId])

  const days = useMemo(() => {
    const last = startOfDay(now)
    return dayRange(addDays(last, -(range - 1)), last)
  }, [range, now])

  const first = days[0] ?? startOfDay(now)
  const window = useEventRange(
    profileId,
    first - SPAN_LOOKBACK_MS,
    endOfDay(days[days.length - 1] ?? first),
    tracker !== null,
  )

  const events = useMemo(
    () => (tracker === null ? [] : window.events.filter((e) => e.trackerId === tracker.id)),
    [window.events, tracker],
  )

  const scheme = useMemo(() => (tracker === null ? null : seriesScheme(tracker)), [tracker])
  const columns = useMemo(() => columnsFor(events, days, now), [events, days, now])

  const marks = useMemo(() => {
    let total = 0
    for (const column of columns.values()) total += column.length
    return total
  }, [columns])

  const [, setLocation] = useLocation()
  const openInTimeline = (event: Event) => {
    setLocation(`/timeline?event=${encodeURIComponent(event.id)}`)
  }

  return (
    // `h-dvh`, not `min-h-dvh`: this screen is sized TO the viewport rather than
    // by its content, which is what lets the chart claim the leftover height.
    // With min-height the flex child would happily grow past the bottom.
    <div className="relative z-10 flex h-dvh flex-col overflow-hidden">
      <header className="pad-safe-top pad-safe-x pb-3">
        <h1 className="lockup text-[15px] font-semibold tracking-[-0.02em]">Dashboard</h1>
        <p className="stencil mt-1.5">{profile.name}</p>
      </header>

      {/* A flex column that owns the viewport: the picker and range sit at their
          natural height, the chart takes everything left over, and the legend
          rests on the bottom above the tab bar. `min-h-0` is what stops the
          chart pushing the legend off-screen. */}
      <main className="pad-safe-x pad-tabs flex min-h-0 flex-1 flex-col">
        {trackersQuery.isPending ? (
          <p className="stencil">loading</p>
        ) : tracker === null ? (
          <NoTrackers />
        ) : (
          <>
            <button
              type="button"
              onClick={() => setPicking(true)}
              className="tap flex min-h-[60px] w-full items-center gap-3 rounded-2xl border border-ink-700 bg-ink-850 px-4 text-left active:bg-ink-800"
              aria-label={`Charting ${tracker.name}. Choose another tracker`}
            >
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full"
                style={{
                  background: safeColour(tracker.colour),
                  boxShadow: `0 0 10px ${safeColour(tracker.colour)}`,
                }}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[18px] leading-tight font-medium tracking-[-0.02em]">
                  {tracker.name}
                </span>
                <span className="stencil mt-1.5 block">
                  {tracker.type === 'INTERVAL' ? 'span' : 'moment'} · {marks}{' '}
                  {marks === 1 ? 'mark' : 'marks'}
                </span>
              </span>
              <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-text-dim" fill="none" aria-hidden>
                <path
                  d="M7 10l5 5 5-5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>

            <RangePicker value={range} onChange={setRange} />

            {window.isError ? (
              <ErrorCard onRetry={window.refetch} />
            ) : scheme === null ? null : (
              <>
                <div className="mt-4 flex min-h-0 flex-1 flex-col">
                  <Actogram
                    tracker={tracker}
                    days={days}
                    columns={columns}
                    scheme={scheme}
                    onSelect={openInTimeline}
                  />
                </div>

                {marks === 0 && !window.isPending ? (
                  <p className="mt-3 shrink-0 text-[15px] leading-snug text-balance text-text-dim">
                    Nothing logged for {tracker.name} in the last {range} days. The grid above is
                    the range it looked in.
                  </p>
                ) : null}

                {/* Pinned below the chart rather than floating after it. */}
                <div className="shrink-0">
                  <ActogramLegend scheme={scheme} />
                  {window.capped ? <CapNotice /> : null}
                </div>
              </>
            )}
          </>
        )}
      </main>

      <Sheet
        open={picking}
        onClose={() => setPicking(false)}
        eyebrow="chart"
        title="Which tracker?"
        body="One at a time — two trackers on one 24-hour field stop being readable."
      >
        {selectable.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => {
              setTrackerId(candidate.id)
              setPicking(false)
            }}
            aria-current={candidate.id === tracker?.id ? 'true' : undefined}
            className={`tap flex h-[60px] w-full items-center gap-3 rounded-2xl border px-4 text-left text-[17px] ${
              candidate.id === tracker?.id
                ? 'border-mauve/55 bg-mauve/10'
                : 'border-ink-600 bg-ink-700'
            }`}
          >
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full"
              style={{ background: safeColour(candidate.colour) }}
            />
            <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
            <span className="stencil">{candidate.type === 'INTERVAL' ? 'span' : 'moment'}</span>
          </button>
        ))}
      </Sheet>
    </div>
  )
}

function RangePicker({ value, onChange }: { value: Range; onChange: (next: Range) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Range"
      className="mt-2.5 flex gap-1 rounded-2xl border border-ink-700 bg-ink-850 p-1"
    >
      {RANGES.map((days) => {
        const selected = days === value
        return (
          <button
            key={days}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(days)}
            className={`tap h-11 flex-1 rounded-xl text-[15px] ${
              selected ? 'bg-ink-700 font-medium text-text' : 'text-text-dim'
            }`}
          >
            {days} days
          </button>
        )
      })}
    </div>
  )
}

/**
 * The events endpoint caps at 1000 and drops the *oldest* first, so a range
 * that hit the cap is missing its left-hand side. Saying so is the only honest
 * option — a chart quietly plotting 1000 of 1400 events is worse than none.
 */
function CapNotice() {
  return (
    <p className="mt-4 rounded-xl border border-ink-700 bg-ink-850 px-3.5 py-3 text-[13px] leading-snug text-text-dim">
      This profile logged more than {EVENT_LIMIT} events in this range, so the earliest columns are
      incomplete. Narrow the range for an exact picture.
    </p>
  )
}

function NoTrackers() {
  return (
    <div className="rounded-tile hairline bg-ink-850 p-5">
      <p className="stencil">nothing to chart</p>
      <p className="mt-2.5 text-[19px] leading-snug tracking-[-0.02em] text-balance">
        This profile has no trackers yet, so there is no pattern to look for.
      </p>
    </div>
  )
}

function ErrorCard({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-tile hairline mt-5 bg-ink-850 p-5">
      <p className="stencil">offline</p>
      <p className="mt-2 text-[17px] leading-snug">Can’t reach the server.</p>
      <button
        type="button"
        onClick={onRetry}
        className="tap mt-4 h-12 w-full rounded-xl border border-ink-600 bg-ink-800 text-[15px]"
      >
        Try again
      </button>
    </div>
  )
}
