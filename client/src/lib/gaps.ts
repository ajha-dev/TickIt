import type { Event, Tracker } from '../types.ts'

/**
 * The time between one span and the one before it, on a tracker with
 * `gaps` switched on — built for timing contractions (CONTRACT.md, "Gaps
 * between spans").
 *
 * Nothing here is stored. Gaps are read off the events every time, so an
 * edited start or end corrects both gaps it sits between with no bookkeeping.
 */
export interface Gap {
  /** Start to start, in ms — "every 5 minutes", the figure a midwife asks for. */
  frequency: number
  /** The previous end to this start, in ms, never negative. */
  rest: number
}

/**
 * A frequency longer than this is a break between sessions, not a gap. Without
 * it, a false alarm the evening before reads as "every 14h" on the first real
 * contraction.
 */
export const GAP_BREAK_MS = 2 * 60 * 60 * 1000

const HOUR_MS = 60 * 60 * 1000

/** Gap from `prev` to `cur`, or null when they are too far apart to be one. */
export function gapBetween(prev: Event, cur: Event): Gap | null {
  const frequency = cur.startAt - prev.startAt
  if (frequency > GAP_BREAK_MS) return null
  // A running predecessor has no end, and an overlap (an edit can make one)
  // has no rest; both read as none rather than as a negative.
  const rest = Math.max(0, cur.startAt - (prev.endAt ?? cur.startAt))
  return { frequency, rest }
}

/** One gaps tracker's spans, oldest first. */
function spansOf(events: Iterable<Event>, trackerId: string): Event[] {
  const out: Event[] = []
  for (const e of events) {
    if (e.type === 'INTERVAL' && e.trackerId === trackerId) out.push(e)
  }
  return out.sort((a, b) => a.startAt - b.startAt)
}

/**
 * For every span of a gaps tracker, its gap to the previous span of the same
 * tracker. Spans of other trackers, moments, and a tracker's first span have
 * no entry.
 *
 * Pass *every* event in reach, not just the day on screen: the first
 * contraction after midnight takes its gap from the evening before.
 */
export function gapsByEvent(
  events: Iterable<Event>,
  trackerById: Map<string, Tracker>,
): Map<string, Gap> {
  const groups = new Map<string, Event[]>()
  for (const e of events) {
    if (e.type !== 'INTERVAL' || !trackerById.get(e.trackerId)?.gaps) continue
    const group = groups.get(e.trackerId)
    if (group) group.push(e)
    else groups.set(e.trackerId, [e])
  }

  const out = new Map<string, Gap>()
  for (const group of groups.values()) {
    group.sort((a, b) => a.startAt - b.startAt)
    group.forEach((cur, i) => {
      const prev = group[i - 1]
      const gap = prev ? gapBetween(prev, cur) : null
      if (gap) out.set(cur.id, gap)
    })
  }
  return out
}

export interface RecentStats {
  /** Spans that started inside the window. */
  count: number
  /** Mean length of the finished ones; null when none has finished. */
  avgDuration: number | null
  /** Mean start-to-start across consecutive ones; null with fewer than two. */
  avgFrequency: number | null
  /** The newest span of the tracker, inside the window or not — null when it
   *  is too old to be part of this session (GAP_BREAK_MS). */
  last: Event | null
}

/**
 * How one gaps tracker has been going lately: the "last hour" card and the
 * "since last" clock on its tile.
 */
export function recentStats(
  events: Iterable<Event>,
  trackerId: string,
  now: number,
  windowMs: number = HOUR_MS,
): RecentStats {
  const spans = spansOf(events, trackerId)
  const newest = spans.at(-1) ?? null
  const last = newest && now - newest.startAt <= GAP_BREAK_MS ? newest : null

  const inWindow = spans.filter((e) => e.startAt >= now - windowMs && e.startAt <= now)

  const finished = inWindow.filter((e) => e.endAt !== null)
  const avgDuration =
    finished.length > 0
      ? finished.reduce((sum, e) => sum + ((e.endAt as number) - e.startAt), 0) / finished.length
      : null

  // The mean of consecutive start-to-starts telescopes to first-to-last over
  // the number of gaps between them.
  const first = inWindow[0]
  const newestInWindow = inWindow.at(-1)
  const avgFrequency =
    first && newestInWindow && inWindow.length > 1
      ? (newestInWindow.startAt - first.startAt) / (inWindow.length - 1)
      : null

  return { count: inWindow.length, avgDuration, avgFrequency, last }
}
