/**
 * Dashboard — the read side of the app, in two levels.
 *
 * *Month* is a calendar grid where each cell carries a density indicator, so a
 * month reads at a glance and a day is one tap away. *Day* is the point of the
 * section: a 24-hour ribbon, one lane per tracker, with the summary numbers
 * under it.
 *
 * Two things are load-bearing and easy to get wrong:
 *
 * - **Every boundary is local.** The database is UTC; `lib/days.ts` resolves
 *   days in the device's zone, including the 23- and 25-hour ones.
 * - **The events endpoint filters on `startAt` only.** A span that began last
 *   night and ended this morning would be invisible to a query starting at
 *   midnight, so every window here reaches back `SPAN_LOOKBACK_MS` and the
 *   running spans are merged in separately — they have no upper bound at all.
 */

import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent } from 'react'
import { useLocation } from 'wouter'

import { listEvents } from '../api.ts'
import { DayRibbon, type RibbonLane } from '../components/DayRibbon.tsx'
import { DayStats } from '../components/DayStats.tsx'
import { MonthGrid, MonthLegend } from '../components/MonthGrid.tsx'
import {
  addDays,
  addMonths,
  endOfDay,
  formatDayHeading,
  formatMonthHeading,
  isToday,
  monthGrid,
  startOfDay,
  startOfMonth,
} from '../lib/days.ts'
import { useRunning, useTrackers } from '../lib/queries.ts'
import {
  daySegments,
  monthDensity,
  peakDensity,
  trackerDayStats,
  SPAN_LOOKBACK_MS,
} from '../lib/stats.ts'
import { useNow } from '../lib/time.ts'
import type { Event, Profile, Tracker } from '../types.ts'

/** The endpoint's ceiling. Asking for it is how we find out we hit it. */
const EVENT_LIMIT = 1000

/**
 * Events in a window, plus every running span.
 *
 * The query key is prefixed `['events', profileId, …]` so the mutations
 * elsewhere in the app, which invalidate `['events', profileId]`, invalidate
 * these ranges too.
 */
function useWindowEvents(profileId: string, from: number, to: number, enabled = true) {
  const events = useQuery({
    queryKey: ['events', profileId, 'range', from, to],
    queryFn: () => listEvents({ profileId, from, to, limit: EVENT_LIMIT }),
    enabled: enabled && Boolean(profileId),
    staleTime: 30_000,
  })
  const running = useRunning(profileId)

  return useMemo(() => {
    const merged = new Map<string, Event>()
    for (const event of events.data ?? []) merged.set(event.id, event)
    // A span running since before the window's lookback would otherwise be
    // missing entirely — it has a start but no end to bound it.
    for (const event of running.data ?? []) merged.set(event.id, event)

    return {
      events: [...merged.values()],
      isPending: events.isPending,
      isError: events.isError,
      refetch: () => void events.refetch(),
      /** The window returned exactly the cap, so older events were dropped. */
      capped: (events.data?.length ?? 0) >= EVENT_LIMIT,
    }
  }, [events.data, events.isPending, events.isError, events.refetch, running.data])
}

export function CalendarScreen({ profile }: { profile: Profile }) {
  const profileId = profile.id
  const now = useNow(30_000)

  const [month, setMonth] = useState(() => startOfMonth(Date.now()))
  const [day, setDay] = useState<number | null>(null)

  const trackersQuery = useTrackers(profileId)
  const trackers = useMemo(() => trackersQuery.data ?? [], [trackersQuery.data])

  const grid = useMemo(() => monthGrid(month), [month])
  const gridFrom = (grid[0] ?? month) - SPAN_LOOKBACK_MS
  const gridTo = endOfDay(grid[grid.length - 1] ?? month)
  const monthWindow = useWindowEvents(profileId, gridFrom, gridTo)

  // The day gets its own, much narrower window rather than reusing the month's,
  // so a month busy enough to hit the 1000-event cap still shows an exact day.
  const dayWindow = useWindowEvents(
    profileId,
    (day ?? month) - SPAN_LOOKBACK_MS,
    endOfDay(day ?? month),
    day !== null,
  )

  const openDay = useCallback((next: number) => {
    setDay(startOfDay(next))
    setMonth(startOfMonth(next))
  }, [])

  const stepDay = useCallback((delta: number) => {
    setDay((current) => {
      if (current === null) return current
      const next = addDays(current, delta)
      setMonth(startOfMonth(next))
      return next
    })
  }, [])

  // Arrow keys move between days on a desktop; Escape comes back to the month.
  useEffect(() => {
    if (day === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') stepDay(-1)
      else if (e.key === 'ArrowRight') stepDay(1)
      else if (e.key === 'Escape') setDay(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [day, stepDay])

  return (
    <div className="relative z-10 flex min-h-dvh flex-col">
      <header className="pad-safe-top pad-safe-x pb-3">
        <h1 className="lockup text-[15px] font-semibold tracking-[-0.02em]">Dashboard</h1>
        <p className="stencil mt-1.5">{profile.name}</p>
      </header>

      {day === null ? (
        <MonthView
          month={month}
          grid={grid}
          trackers={trackers}
          window={monthWindow}
          trackersPending={trackersQuery.isPending}
          now={now}
          onMonth={setMonth}
          onOpenDay={openDay}
        />
      ) : (
        <DayView
          day={day}
          trackers={trackers}
          window={dayWindow}
          now={now}
          onStep={stepDay}
          onClose={() => setDay(null)}
        />
      )}
    </div>
  )
}

type Window = ReturnType<typeof useWindowEvents>

/* ------------------------------------------------------------------ month -- */

function MonthView({
  month,
  grid,
  trackers,
  window: monthWindow,
  trackersPending,
  now,
  onMonth,
  onOpenDay,
}: {
  month: number
  grid: number[]
  trackers: Tracker[]
  window: Window
  trackersPending: boolean
  now: number
  onMonth: (next: number) => void
  onOpenDay: (day: number) => void
}) {
  const densities = useMemo(
    () => monthDensity(grid, trackers, monthWindow.events, now),
    [grid, trackers, monthWindow.events, now],
  )
  const peak = useMemo(() => peakDensity(densities), [densities])

  // Totals for this month only — the grid's first and last rows belong to the
  // neighbouring months and must not be counted twice across two screens.
  const legend = useMemo(() => {
    const counts = new Map<string, number>()
    for (const density of densities.values()) {
      if (startOfMonth(density.day) !== startOfMonth(month)) continue
      for (const { tracker, count } of density.byTracker) {
        counts.set(tracker.id, (counts.get(tracker.id) ?? 0) + count)
      }
    }
    return trackers
      .filter((t) => t.archivedAt === null || (counts.get(t.id) ?? 0) > 0)
      .map((tracker) => ({ tracker, count: counts.get(tracker.id) ?? 0 }))
  }, [densities, month, trackers])

  const total = useMemo(() => legend.reduce((sum, e) => sum + e.count, 0), [legend])

  const thisMonth = startOfMonth(now) === startOfMonth(month)

  return (
    <main className="pad-safe-x pad-tabs anim-fade flex-1">
      <div className="flex items-center gap-1 pb-4">
        <h2 className="min-w-0 flex-1 truncate text-[22px] leading-none font-semibold tracking-[-0.03em]">
          {formatMonthHeading(month)}
        </h2>
        <Stepper label="Previous month" direction="prev" onClick={() => onMonth(addMonths(month, -1))} />
        <Stepper
          label="Next month"
          direction="next"
          onClick={() => onMonth(addMonths(month, 1))}
          disabled={thisMonth}
        />
      </div>

      {monthWindow.isError ? (
        <ErrorCard onRetry={monthWindow.refetch} />
      ) : (
        <>
          <MonthGrid
            month={month}
            days={grid}
            densities={densities}
            peak={peak}
            selected={null}
            onSelect={onOpenDay}
          />

          <p className="stencil mt-4">
            {monthWindow.isPending || trackersPending
              ? 'loading'
              : `${total} ${total === 1 ? 'event' : 'events'} · bar length is the day against the busiest`}
          </p>

          {monthWindow.capped ? <CapNotice /> : null}

          {total > 0 ? (
            <div className="mt-6 rounded-2xl border border-ink-700 bg-ink-850 p-4">
              <p className="stencil pb-3">legend · {formatMonthHeading(month).split(' ')[0]}</p>
              <MonthLegend entries={legend} />
            </div>
          ) : null}

          {!monthWindow.isPending && trackers.length === 0 ? (
            <p className="mt-5 text-[17px] leading-snug text-balance text-text-dim">
              No trackers in this profile yet, so there is nothing to plot.
            </p>
          ) : null}

          {!monthWindow.isPending && trackers.length > 0 && total === 0 ? (
            <p className="mt-5 text-[17px] leading-snug text-balance text-text-dim">
              Nothing logged this month.
            </p>
          ) : null}
        </>
      )}
    </main>
  )
}

/* -------------------------------------------------------------------- day -- */

function DayView({
  day,
  trackers,
  window: dayWindow,
  now,
  onStep,
  onClose,
}: {
  day: number
  trackers: Tracker[]
  window: Window
  now: number
  onStep: (delta: number) => void
  onClose: () => void
}) {
  const [, setLocation] = useLocation()

  /**
   * Lanes are the active trackers, plus any archived one that actually logged
   * something on this day — archiving hides a tracker from the home grid, it
   * does not erase its history. The order is the tracker order, so the lanes
   * and the month cells' stacked segments always line up.
   */
  const lanes: RibbonLane[] = useMemo(() => {
    const segmentsFor = (tracker: Tracker) =>
      daySegments(
        dayWindow.events.filter((e) => e.trackerId === tracker.id),
        day,
        now,
      )

    return trackers
      .map((tracker) => ({ tracker, segments: segmentsFor(tracker) }))
      .filter((lane) => lane.tracker.archivedAt === null || lane.segments.length > 0)
  }, [trackers, dayWindow.events, day, now])

  const stats = useMemo(
    () =>
      lanes.map((lane) => trackerDayStats(lane.tracker, dayWindow.events, day, now)),
    [lanes, dayWindow.events, day, now],
  )

  // Swipe between days — the ribbon's own gesture, matching the arrows.
  const touch = useRef<{ x: number; y: number } | null>(null)
  const onTouchStart = (e: TouchEvent) => {
    const point = e.touches[0]
    touch.current = point ? { x: point.clientX, y: point.clientY } : null
  }
  const onTouchEnd = (e: TouchEvent) => {
    const start = touch.current
    const point = e.changedTouches[0]
    touch.current = null
    if (!start || !point) return
    const dx = point.clientX - start.x
    const dy = point.clientY - start.y
    if (Math.abs(dx) > 56 && Math.abs(dy) < 42) onStep(dx < 0 ? 1 : -1)
  }

  const openInTimeline = (event: Event) => {
    setLocation(`/timeline?event=${encodeURIComponent(event.id)}`)
  }

  const today = isToday(day)

  return (
    <main
      className="pad-safe-x pad-tabs anim-fade flex-1"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="flex items-center gap-1 pb-4">
        <button
          type="button"
          onClick={onClose}
          className="tap -ml-2 flex size-10 shrink-0 items-center justify-center rounded-full text-text-dim active:bg-ink-800"
          aria-label="Back to the month"
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
            <path
              d="M14 6l-6 6 6 6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <h2 className="min-w-0 flex-1 truncate text-[22px] leading-none font-semibold tracking-[-0.03em]">
          {formatDayHeading(day)}
        </h2>

        <Stepper label="Previous day" direction="prev" onClick={() => onStep(-1)} />
        <Stepper label="Next day" direction="next" onClick={() => onStep(1)} disabled={today} />
      </div>

      {dayWindow.isError ? (
        <ErrorCard onRetry={dayWindow.refetch} />
      ) : lanes.length === 0 ? (
        <p className="text-[17px] leading-snug text-balance text-text-dim">
          {dayWindow.isPending ? 'Loading…' : 'No trackers in this profile yet.'}
        </p>
      ) : (
        <>
          <DayRibbon day={day} lanes={lanes} now={now} showNow={today} onSelect={openInTimeline} />

          <p className="stencil mt-4">
            full 24 hours, always · swipe or use the arrows for another day
          </p>

          {dayWindow.capped ? <CapNotice /> : null}

          <div className="mt-6">
            <DayStats stats={stats} day={day} now={now} />
          </div>
        </>
      )}
    </main>
  )
}

/* ------------------------------------------------------------------ parts -- */

function Stepper({
  label,
  direction,
  onClick,
  disabled = false,
}: {
  label: string
  direction: 'prev' | 'next'
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="tap flex size-10 shrink-0 items-center justify-center rounded-full border border-ink-700 bg-ink-850 text-text-dim active:bg-ink-800 disabled:opacity-30"
    >
      <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden>
        <path
          d={direction === 'prev' ? 'M14 6l-6 6 6 6' : 'M10 6l6 6-6 6'}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

/**
 * The events endpoint caps at 1000 and drops the *oldest* first, so a window
 * that hit the cap is missing its beginning. Saying so is the only honest
 * option — a chart that quietly plots 1000 of 1400 events is worse than none.
 */
function CapNotice() {
  return (
    <p className="mt-3 rounded-xl border border-ink-700 bg-ink-850 px-3.5 py-3 text-[13px] leading-snug text-text-dim">
      Showing the {EVENT_LIMIT} most recent events in this range — the earliest ones are not
      drawn. Open a single day for the exact picture.
    </p>
  )
}

function ErrorCard({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-tile hairline bg-ink-850 p-5">
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
