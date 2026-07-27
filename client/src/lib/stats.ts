/**
 * Dashboard arithmetic — everything the month grid and the day ribbon need to
 * turn a bag of events into geometry and numbers.
 *
 * Two rules govern this whole file:
 *
 * 1. **Days are local.** The database is UTC epoch ms; every boundary here comes
 *    from `lib/days.ts`, which resolves them in the device's zone. Nothing below
 *    divides by 86_400_000 — the two days a year that are 23 or 25 hours long
 *    would silently draw past the edge of the ribbon.
 * 2. **A Span belongs to every day it touches.** A feed from 23:40 to 00:15 is
 *    part of both nights and is counted, drawn and measured on both — clipped to
 *    each day's own bounds, never dropped and never overflowing.
 */

import { dayLengthMs, endOfDay, startOfDay } from './days.ts'
import type { Event, Tracker } from '../types.ts'

/**
 * How far before a window's start we have to look for events. The events
 * endpoint filters on `startAt` only, so a Span that began yesterday and ends
 * inside today is invisible to a query that starts at midnight.
 *
 * 48 hours covers any realistic closed span — an overnight feed, a long nap, a
 * night's sleep. A *running* span has no bound at all, which is why the screens
 * merge `GET /api/events/running` in separately rather than widening this.
 */
export const SPAN_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000

/**
 * When an event finished. A running Span (INTERVAL with no `endAt`) has not
 * finished, so it is measured up to `now`; a Moment ends the instant it starts.
 */
export function eventEnd(event: Event, now: number): number {
  if (event.type === 'INTERVAL') return event.endAt ?? Math.max(now, event.startAt)
  return event.endAt ?? event.startAt
}

export function isRunning(event: Event): boolean {
  return event.type === 'INTERVAL' && event.endAt === null
}

/** Does the event occupy any part of the local day starting at `dayStart`? */
export function touchesDay(event: Event, dayStart: number, now: number): boolean {
  const start = startOfDay(dayStart)
  const end = endOfDay(start)

  if (event.startAt >= start && event.startAt < end) return true
  if (event.type !== 'INTERVAL') return false

  // Began before this day — it belongs here only if it was still running once
  // the day started. `> start` and not `>=`: a span that finishes exactly at
  // midnight belongs to the night it ran through, not to the day that begins.
  return event.startAt < start && eventEnd(event, now) > start
}

/**
 * Where `ms` sits in the local day starting at `dayStart`, as a 0–1 fraction.
 *
 * The companion to `dayFraction` in `lib/days.ts`, which resolves the day from
 * the instant itself and so returns 0 for the exclusive midnight at a day's
 * *end*. Clipped spans routinely land exactly there, and a bar that ends at
 * 00:00 must draw at the right edge, not the left.
 */
export function fractionOfDay(ms: number, dayStart: number): number {
  const span = dayLengthMs(dayStart)
  if (span <= 0) return 0
  return Math.min(1, Math.max(0, (ms - dayStart) / span))
}

/** One event as it appears on one day: real times clipped to that day's bounds. */
export interface DaySegment {
  event: Event
  /** Clipped start — never earlier than midnight. */
  from: number
  /** Clipped end — never later than the next midnight. Equals `from` for a Moment. */
  to: number
  /** The event actually began before this day. */
  clippedStart: boolean
  /** The event actually continues past this day. */
  clippedEnd: boolean
  running: boolean
}

/**
 * Every event that touches the local day containing `dayStart`, clipped to it
 * and sorted by clipped start. Feed it a window wider than the day — a span
 * from the previous night is the whole point.
 */
export function daySegments(events: Event[], dayStart: number, now: number): DaySegment[] {
  const start = startOfDay(dayStart)
  const end = endOfDay(start)
  const segments: DaySegment[] = []

  for (const event of events) {
    if (!touchesDay(event, start, now)) continue

    if (event.type !== 'INTERVAL') {
      segments.push({
        event,
        from: event.startAt,
        to: event.startAt,
        clippedStart: false,
        clippedEnd: false,
        running: false,
      })
      continue
    }

    const realEnd = eventEnd(event, now)
    segments.push({
      event,
      from: Math.max(event.startAt, start),
      to: Math.min(realEnd, end),
      clippedStart: event.startAt < start,
      clippedEnd: realEnd > end,
      running: isRunning(event),
    })
  }

  segments.sort((a, b) => a.from - b.from || a.to - b.to)
  return segments
}

/** The summary numbers under the ribbon, for one tracker on one day. */
export interface TrackerDayStats {
  tracker: Tracker
  segments: DaySegment[]
  count: number
  /** Total time inside this day, Spans only. Null for a Moment tracker. */
  totalMs: number | null
  /** Mean clipped duration, Spans only. */
  averageMs: number | null
  /** The longest stretch of this day with nothing logged — null under 2 events. */
  longestGapMs: number | null
  gapFrom: number | null
  gapTo: number | null
  /** When the last event on this day finished (its own instant, for a Moment). */
  lastAt: number | null
  running: boolean
}

/**
 * Per-tracker summary for one local day.
 *
 * **Longest gap** is measured between consecutive events *within this day*,
 * from the end of one to the start of the next, using the clipped times — so it
 * is always a stretch of this day and never silently reaches into yesterday.
 * Overlapping spans collapse (a nap inside a nap is not a gap), and a day with
 * fewer than two events has no gap at all rather than a misleading zero.
 */
export function trackerDayStats(
  tracker: Tracker,
  events: Event[],
  dayStart: number,
  now: number,
): TrackerDayStats {
  const segments = daySegments(
    events.filter((e) => e.trackerId === tracker.id),
    dayStart,
    now,
  )

  const isSpan = tracker.type === 'INTERVAL'
  let total = 0
  let longest: number | null = null
  let gapFrom: number | null = null
  let gapTo: number | null = null
  let cursor: number | null = null
  let lastAt: number | null = null
  let running = false

  for (const segment of segments) {
    total += segment.to - segment.from
    if (segment.running) running = true

    if (cursor !== null && segment.from > cursor) {
      const gap = segment.from - cursor
      if (longest === null || gap > longest) {
        longest = gap
        gapFrom = cursor
        gapTo = segment.from
      }
    }
    cursor = cursor === null ? segment.to : Math.max(cursor, segment.to)
    lastAt = lastAt === null ? segment.to : Math.max(lastAt, segment.to)
  }

  const count = segments.length
  return {
    tracker,
    segments,
    count,
    totalMs: isSpan && count > 0 ? total : null,
    averageMs: isSpan && count > 0 ? total / count : null,
    longestGapMs: longest,
    gapFrom,
    gapTo,
    lastAt,
    running,
  }
}

/** One cell of the month grid: how much was logged that day, and of what. */
export interface DayDensity {
  /** Local midnight of the day. */
  day: number
  total: number
  /** Counts in tracker order — the same order as the ribbon's lanes. */
  byTracker: { tracker: Tracker; count: number }[]
}

/**
 * Density for a run of days. A Span spanning midnight is counted on both days,
 * matching what the ribbon draws, so tapping through from a cell never shows
 * fewer bars than the cell promised.
 */
export function monthDensity(
  days: number[],
  trackers: Tracker[],
  events: Event[],
  now: number,
): Map<number, DayDensity> {
  const order = new Map(trackers.map((t, i) => [t.id, i]))
  const densities = new Map<number, DayDensity>()

  for (const day of days) {
    densities.set(day, { day, total: 0, byTracker: [] })
  }

  // One pass per event over the days it touches, rather than a full scan per
  // day: a month grid is 42 cells and a busy month is a thousand events.
  for (const event of events) {
    const index = order.get(event.trackerId)
    if (index === undefined) continue

    const first = startOfDay(event.startAt)
    const last = startOfDay(eventEnd(event, now))

    for (let day = first; day <= last; day = endOfDay(day)) {
      const density = densities.get(day)
      if (density === undefined) continue
      if (!touchesDay(event, day, now)) continue

      density.total += 1
      const existing = density.byTracker.find((b) => b.tracker.id === event.trackerId)
      if (existing) existing.count += 1
      else density.byTracker.push({ tracker: trackers[index] as Tracker, count: 1 })
    }
  }

  for (const density of densities.values()) {
    density.byTracker.sort(
      (a, b) => (order.get(a.tracker.id) ?? 0) - (order.get(b.tracker.id) ?? 0),
    )
  }
  return densities
}

/** The busiest day in a grid — the scale every density bar is drawn against. */
export function peakDensity(densities: Map<number, DayDensity>): number {
  let peak = 0
  for (const density of densities.values()) peak = Math.max(peak, density.total)
  return peak
}
