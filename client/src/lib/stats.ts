/**
 * Dashboard arithmetic: turning a bag of events into the marks of an actogram.
 *
 * The chart is days across, time-of-day down, so the only real work here is
 * deciding which day-column a piece of an event belongs to and where in that
 * column it sits. Two rules govern it:
 *
 * 1. **Days are local.** The database is UTC epoch ms and the server never
 *    computes a boundary; every boundary here comes from `lib/days.ts`, which
 *    resolves them in the device's zone. Nothing below divides by 86_400_000 —
 *    the two days a year that run 23 or 25 hours would draw past the axis.
 * 2. **A Span belongs to every day it touches.** A feed from 23:40 to 00:15 is
 *    drawn twice, clipped to each day's own bounds: once at the bottom of one
 *    column and once at the top of the next. Dropping it would lose a feed;
 *    drawing it whole in one column would put it outside the axis.
 */

import { addDays, dayLengthMs, endOfDay, startOfDay } from './days.ts'
import type { Event } from '../types.ts'

/**
 * How far before a window's start we have to look for events. The events
 * endpoint filters on `startAt` only, so a Span that began the night before the
 * range and ends inside it is invisible to a query that starts at midnight.
 *
 * 48 hours covers any realistic closed span — an overnight feed, a long nap, a
 * night's sleep. A *running* span has no bound at all, which is why the screen
 * merges `GET /api/events/running` in separately rather than widening this.
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

/**
 * Where `ms` sits in the local day starting at `dayStart`, as a 0–1 fraction.
 *
 * The companion to `dayFraction` in `lib/days.ts`, which resolves the day from
 * the instant itself and so returns 0 for the exclusive midnight at a day's
 * *end*. Clipped spans land exactly there, and a bar that ends at midnight must
 * draw at the bottom of its column, not the top.
 */
export function fractionOfDay(ms: number, dayStart: number): number {
  const span = dayLengthMs(dayStart)
  if (span <= 0) return 0
  return Math.min(1, Math.max(0, (ms - dayStart) / span))
}

/** One event's presence in one day-column, clipped to that day's bounds. */
export interface DayMark {
  event: Event
  /** Local midnight of the column this mark belongs to. */
  day: number
  /** Clipped start — never earlier than the column's midnight. */
  from: number
  /** Clipped end — never later than the next midnight. Equals `from` for a Moment. */
  to: number
  /** The event actually began before this column. */
  clippedStart: boolean
  /** The event actually continues past this column. */
  clippedEnd: boolean
  /** This piece is the live end of a running span. */
  running: boolean
}

/**
 * An event as one mark per local day it touches. A Moment is always exactly one
 * mark; a Span is one per day, split at each midnight it crosses, and a running
 * span is clipped to `now` rather than running to the end of the chart.
 */
export function splitAcrossDays(event: Event, now: number): DayMark[] {
  if (event.type !== 'INTERVAL') {
    return [
      {
        event,
        day: startOfDay(event.startAt),
        from: event.startAt,
        to: event.startAt,
        clippedStart: false,
        clippedEnd: false,
        running: false,
      },
    ]
  }

  const realEnd = eventEnd(event, now)
  const first = startOfDay(event.startAt)
  const last = startOfDay(realEnd)
  const marks: DayMark[] = []

  for (let day = first; day <= last; day = endOfDay(day)) {
    const dayEnd = endOfDay(day)
    const from = Math.max(event.startAt, day)
    const to = Math.min(realEnd, dayEnd)

    // A span that finishes exactly at midnight belongs to the night it ran
    // through, not to the day that has only just begun — so the final column is
    // skipped when nothing of the span actually falls inside it.
    if (day > first && to <= day) break

    marks.push({
      event,
      day,
      from,
      to,
      clippedStart: event.startAt < day,
      clippedEnd: realEnd > dayEnd,
      running: isRunning(event) && realEnd <= dayEnd,
    })

    // A corrupt row (an end long before its start, say) must not loop forever.
    if (marks.length > 400) break
  }

  return marks
}

/** The local midnights from `first` to `last` inclusive — the chart's columns. */
export function dayRange(first: number, last: number): number[] {
  const days: number[] = []
  const end = startOfDay(last)
  for (let day = startOfDay(first); day <= end; day = addDays(day, 1)) {
    days.push(day)
    if (days.length > 400) break
  }
  return days
}

/**
 * Marks grouped by day-column, for exactly the days given.
 *
 * Every day in `days` gets an entry even when it is empty: a day with nothing
 * logged still occupies a column, or the x-axis quietly lies about how much
 * time passed between two clusters.
 */
export function columnsFor(events: Event[], days: number[], now: number): Map<number, DayMark[]> {
  const columns = new Map<number, DayMark[]>()
  for (const day of days) columns.set(day, [])

  for (const event of events) {
    for (const mark of splitAcrossDays(event, now)) {
      const column = columns.get(mark.day)
      if (column) column.push(mark)
    }
  }

  for (const column of columns.values()) column.sort((a, b) => a.from - b.from)
  return columns
}
