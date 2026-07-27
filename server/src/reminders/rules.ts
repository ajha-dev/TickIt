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

/** The notification a fired reminder produces. */
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
