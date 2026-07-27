/**
 * The pure decision logic behind the reminder sweep.
 *
 * Kept free of the database and of `web-push` on purpose: this is the part
 * that is easy to get subtly wrong, and it is the part worth testing directly.
 */

const MINUTES_PER_DAY = 1440

export type FireDecision =
  /** Idle past the threshold, outside quiet hours — send it. */
  | 'FIRE'
  /** The tracker was used more recently than `afterMs` ago. */
  | 'NOT_IDLE'
  /** This idle period has already been dealt with; wait for a new event. */
  | 'ALREADY_FIRED'
  /** Due, but inside the quiet window. Dropped, not deferred. */
  | 'QUIET'

export interface FireInput {
  /** Now, UTC epoch ms. */
  now: number
  /**
   * The tracker's most recent activity: `max(endAt ?? startAt)` over its
   * events, or the reminder's `createdAt` when it has never been used. The
   * fallback is what stops a brand-new reminder on a dormant tracker from
   * firing on the very first sweep.
   */
  anchor: number
  afterMs: number
  lastFiredAt: number | null
  /** Minutes past local midnight, or null for "no quiet hours". */
  quietFromMin: number | null
  /** Minutes past local midnight; may be < `quietFromMin`, i.e. wrap midnight. */
  quietToMin: number | null
  /** IANA zone the quiet window is expressed in. */
  timeZone: string
}

/**
 * Minutes past local midnight in `timeZone` for a UTC instant.
 *
 * This is the *only* local-time arithmetic the server does. `h23` matters:
 * `hour12: false` renders midnight as "24" under some ICU builds, which would
 * put the top of the day one full day out.
 */
export function localMinutesOfDay(now: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(now))

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  return ((hour % 24) * 60 + minute) % MINUTES_PER_DAY
}

/**
 * Is `minuteOfDay` inside the window `[from, to)`?
 *
 * The window wraps when `from > to` — 22:00 → 07:00 is the common case, and it
 * is two ranges on the clock face, not one. Half-open at `to` so a window
 * ending at 07:00 is over at 07:00 exactly.
 */
export function inQuietWindow(minuteOfDay: number, from: number, to: number): boolean {
  if (from === to) return false
  if (from < to) return minuteOfDay >= from && minuteOfDay < to
  return minuteOfDay >= from || minuteOfDay < to
}

/**
 * Should this reminder fire on this sweep?
 *
 * Two rules carry the whole feature:
 *
 * 1. **Once per idle period.** `lastFiredAt >= anchor` means this stretch of
 *    silence has already been reported. Logging an event moves the anchor
 *    forward, which re-arms the reminder. Without this the user gets a
 *    notification every 60 seconds, forever.
 * 2. **Quiet hours hold, they do not consume.** A reminder due at 03:10 inside
 *    a 01:00–07:00 window stays silent, and the caller must NOT stamp
 *    `lastFiredAt` — so it fires once at 07:00, when the window closes.
 *
 *    The worry that motivated the opposite rule was a stale message arriving
 *    hours late. That does not apply: the notification body is recomputed at
 *    send time, so the 07:00 alert reads "Nothing logged for 10h" — true, and
 *    the single most useful thing it could say. Consuming the period instead
 *    would mean sleeping through the night and being told nothing at all,
 *    which is the failure the feature exists to prevent.
 *
 *    Still exactly one notification per idle period: the first sweep after the
 *    window closes fires and stamps, and every later sweep sees ALREADY_FIRED.
 */
export function shouldFire(input: FireInput): FireDecision {
  const { now, anchor, afterMs, lastFiredAt, quietFromMin, quietToMin, timeZone } = input

  if (lastFiredAt !== null && lastFiredAt >= anchor) return 'ALREADY_FIRED'
  if (now - anchor < afterMs) return 'NOT_IDLE'

  if (quietFromMin !== null && quietToMin !== null) {
    if (inQuietWindow(localMinutesOfDay(now, timeZone), quietFromMin, quietToMin)) return 'QUIET'
  }

  return 'FIRE'
}

/**
 * "3h 20m" — how long the tracker has been idle, for the notification body.
 * Minutes are dropped past a day; "2d 4h" is as precise as anyone needs.
 */
export function formatIdle(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(totalMinutes / MINUTES_PER_DAY)
  const hours = Math.floor((totalMinutes % MINUTES_PER_DAY) / 60)
  const minutes = totalMinutes % 60

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

/** The notification a fired IDLE reminder produces. */
export function buildPayload(
  trackerName: string,
  trackerId: string,
  idleMs: number,
): { title: string; body: string; tag: string } {
  return {
    title: trackerName,
    body: `Nothing logged for ${formatIdle(idleMs)}`,
    // Stable per tracker: a second notification replaces the first rather than
    // stacking a pile of increasingly stale ones in the shade.
    tag: `tracker-${trackerId}`,
  }
}

/* ------------------------------------------------------------------ SCHEDULE */

/**
 * How late an occurrence may be and still be worth sending. Generous enough to
 * survive a reboot or a sleeping phone, short enough that a notification always
 * means *roughly now*.
 */
export const SCHEDULE_WINDOW_MS = 60 * 60_000

/**
 * How far back to look for the most recent occurrence. A schedule may name a
 * single day, so the previous occurrence can be a whole week ago; eight days
 * covers that with a day to spare for the search's own zone arithmetic.
 */
const LOOKBACK_DAYS = 8

const DAY_MS = 24 * 60 * 60_000

export type ScheduleDecision =
  /** An occurrence came due within the window and has not been dealt with. */
  | { kind: 'FIRE'; occurrenceAt: number }
  /**
   * An occurrence is outstanding but older than the window. Stamp
   * `lastFiredAt` to it and send NOTHING — "due at 09:00" arriving at 3pm says
   * something false about now, and acting on it means a double dose.
   */
  | { kind: 'CONSUME'; occurrenceAt: number }
  /** Nothing due, or everything due has already been dealt with. */
  | { kind: 'NONE' }

export interface ScheduleInput {
  /** Now, UTC epoch ms. */
  now: number
  /** Days of the week, 0..6, 0 = Sunday. */
  days: number[]
  /** Minutes past local midnight, 0..1439. */
  timesMin: number[]
  /** The occurrence timestamp last dealt with, or null if never. */
  lastFiredAt: number | null
  /** IANA zone the schedule is expressed in. */
  timeZone: string
}

/**
 * The wall-clock fields of a UTC instant, read in `timeZone`.
 *
 * `h23` matters for the same reason it does in `localMinutesOfDay`: `hour12:
 * false` renders midnight as "24" under some ICU builds.
 */
function zonedParts(
  at: number,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(at))

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '0'

  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: Math.max(0, weekdays.indexOf(get('weekday'))),
  }
}

/** The zone's offset from UTC, in ms, at the instant `at`. */
function zoneOffsetMs(at: number, timeZone: string): number {
  const p = zonedParts(at, timeZone)
  // Whole minutes only, which every IANA zone has been since 1972 — and the
  // seconds of `at` are irrelevant to an offset either way.
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  return asUtc - Math.floor(at / 60_000) * 60_000
}

/**
 * The UTC instant at which the local wall-clock time `y-m-d hh:mm` occurs in
 * `timeZone`.
 *
 * Resolved THROUGH the zone rather than by adding a fixed offset: the offset
 * that applies is the one in force at the answer, not the one in force at the
 * guess, which is exactly what differs across a DST transition. Two passes are
 * enough — the first lands within an hour of the truth, and the second uses the
 * offset actually in force there, so 09:00 stays 09:00 on both sides of a
 * change.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timeZone: string,
): number {
  const wall = Date.UTC(year, month - 1, day, 0, minuteOfDay)
  let utc = wall - zoneOffsetMs(wall, timeZone)
  utc = wall - zoneOffsetMs(utc, timeZone)
  return utc
}

/**
 * Every occurrence at or before `now`, most recent first, over the lookback.
 *
 * Walks back by local calendar date rather than by adding 24h, so a day that is
 * 23 or 25 hours long does not shift the times inside it.
 */
export function recentOccurrences(input: {
  now: number
  days: number[]
  timesMin: number[]
  timeZone: string
}): number[] {
  const { now, days, timesMin, timeZone } = input
  if (days.length === 0 || timesMin.length === 0) return []

  const wanted = new Set(days)
  const found: number[] = []

  for (let back = 0; back <= LOOKBACK_DAYS; back += 1) {
    // Midday keeps the probe clear of both ends of the day, so a DST shift can
    // never push it onto the neighbouring date.
    const probe = zonedParts(now - back * DAY_MS + 12 * 60 * 60_000, timeZone)
    if (!wanted.has(probe.weekday)) continue

    for (const minuteOfDay of timesMin) {
      const at = zonedTimeToUtc(probe.year, probe.month, probe.day, minuteOfDay, timeZone)
      if (at <= now) found.push(at)
    }
  }

  return [...new Set(found)].sort((a, b) => b - a)
}

/**
 * Should this scheduled reminder fire on this sweep?
 *
 * Only the most recent outstanding occurrence is ever sent. Stamping
 * `lastFiredAt` to *its* timestamp consumes every older one in the same stroke,
 * which is the point: two notifications at once for one tracker is noise, and
 * the older of the two is the less true one.
 *
 * Quiet hours are never consulted. A scheduled reminder fires at a time the
 * user picked deliberately; silencing it would override an explicit instruction
 * with an implicit one, and a missed 22:00 dose is the exact failure the
 * reminder was set to prevent.
 */
export function shouldFireSchedule(input: ScheduleInput): ScheduleDecision {
  const { now, days, timesMin, lastFiredAt, timeZone } = input

  const occurrences = recentOccurrences({ now, days, timesMin, timeZone })
  const latest = occurrences[0]
  if (latest === undefined) return { kind: 'NONE' }

  // Dealt with already. `>=` rather than `>` because `lastFiredAt` holds the
  // occurrence's own timestamp, so an exact match is the occurrence itself.
  if (lastFiredAt !== null && lastFiredAt >= latest) return { kind: 'NONE' }

  if (now - latest > SCHEDULE_WINDOW_MS) return { kind: 'CONSUME', occurrenceAt: latest }
  return { kind: 'FIRE', occurrenceAt: latest }
}

/** "09:00" — minutes past local midnight as a 24h wall-clock time. */
export function formatTimeOfDay(minuteOfDay: number): string {
  const m = ((minuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  const hh = String(Math.floor(m / 60)).padStart(2, '0')
  const mm = String(m % 60).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * The notification a fired SCHEDULE reminder produces.
 *
 * The time is read back out of the occurrence in the reminder's own zone, so
 * what the body claims is what the clock on the wall said.
 */
export function buildSchedulePayload(
  trackerName: string,
  trackerId: string,
  occurrenceAt: number,
  timeZone: string,
): { title: string; body: string; tag: string } {
  return {
    title: trackerName,
    body: `Due at ${formatTimeOfDay(localMinutesOfDay(occurrenceAt, timeZone))}`,
    // The same stable per-tracker tag as the idle payload: one tracker, one
    // notification in the shade.
    tag: `tracker-${trackerId}`,
  }
}
