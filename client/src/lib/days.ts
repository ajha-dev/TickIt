/**
 * Local-day arithmetic.
 *
 * The database stores UTC epoch milliseconds and the server never computes a
 * day boundary — that is deliberate (see CONTRACT.md). Every notion of "which
 * day did this happen on" is resolved here, in the device's current zone, at
 * render time.
 *
 * This matters more than it looks. A feed at 00:20 local is the previous UTC
 * day for anyone west of Greenwich; grouping by UTC would scatter a single
 * night across two rows and make the Dashboard's "longest gap" wrong. Every
 * boundary below is computed with the Date constructor's local-time semantics
 * rather than by dividing epoch millis by 86_400_000, which silently breaks on
 * DST transitions — the two days a year a night actually is 23 or 25 hours.
 */

/** Midnight at the start of the local day containing `ms`. */
export function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Midnight at the start of the NEXT local day — an exclusive upper bound. */
export function endOfDay(ms: number): number {
  return startOfDay(addDays(ms, 1))
}

/**
 * `ms` shifted by `n` calendar days, local time. Uses setDate rather than
 * adding 86_400_000 so a DST boundary keeps the wall-clock time intact.
 */
export function addDays(ms: number, n: number): number {
  const d = new Date(ms)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

/** Length of the local day containing `ms`. Usually 24h — not on DST days. */
export function dayLengthMs(ms: number): number {
  return endOfDay(ms) - startOfDay(ms)
}

/**
 * Where `ms` falls within its local day, as a 0–1 fraction. This is what the
 * day ribbon positions bars and ticks with; using the true day length keeps a
 * 23-hour day from drawing past its own right edge.
 */
export function dayFraction(ms: number): number {
  const start = startOfDay(ms)
  return Math.min(1, Math.max(0, (ms - start) / dayLengthMs(ms)))
}

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b)
}

export function isToday(ms: number): boolean {
  return isSameDay(ms, Date.now())
}

/** Midnight on the 1st of the local month containing `ms`. */
export function startOfMonth(ms: number): number {
  const d = new Date(ms)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Exclusive upper bound: midnight on the 1st of the following month. */
export function endOfMonth(ms: number): number {
  const d = new Date(startOfMonth(ms))
  d.setMonth(d.getMonth() + 1)
  return d.getTime()
}

export function addMonths(ms: number, n: number): number {
  const d = new Date(startOfMonth(ms))
  d.setMonth(d.getMonth() + n)
  return d.getTime()
}

/**
 * The calendar grid for the month containing `ms`: whole weeks, so the first
 * and last rows include days from the neighbouring months. Each entry is the
 * local midnight of that day.
 *
 * `weekStartsOn` is 1 (Monday) by default — matching most of the world outside
 * the US, and the locale's own preference is not reliably exposed by Intl.
 */
export function monthGrid(ms: number, weekStartsOn: 0 | 1 = 1): number[] {
  const first = startOfMonth(ms)
  const offset = (new Date(first).getDay() - weekStartsOn + 7) % 7
  const gridStart = addDays(first, -offset)

  const days: number[] = []
  for (let i = 0; i < 42; i += 1) {
    const day = addDays(gridStart, i)
    days.push(day)
    // Stop at a whole week once the month is finished — a 5-week month should
    // not render a trailing row belonging entirely to the next month.
    if (i >= 27 && (i + 1) % 7 === 0 && day >= endOfMonth(ms)) break
  }
  return days
}

/** Weekday initials for a header row, in the same order as `monthGrid`. */
export function weekdayLabels(weekStartsOn: 0 | 1 = 1): string[] {
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' })
  // 2024-01-07 was a Sunday, so this walks a real week in the right order.
  const sunday = new Date(2024, 0, 7).getTime()
  return Array.from({ length: 7 }, (_, i) => fmt.format(addDays(sunday, i + weekStartsOn)))
}

/** "Today", "Yesterday", or a written date — for timeline day headings. */
export function formatDayHeading(ms: number): string {
  const today = startOfDay(Date.now())
  const day = startOfDay(ms)
  if (day === today) return 'Today'
  if (day === addDays(today, -1)) return 'Yesterday'
  const sameYear = new Date(day).getFullYear() === new Date(today).getFullYear()
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(day)
}

export function formatMonthHeading(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(ms)
}
