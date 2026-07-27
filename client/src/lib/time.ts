/**
 * Every time string in TickIt is produced here.
 *
 * The database stores UTC epoch milliseconds and nothing else — no zone, no
 * formatted dates. Every render resolves those millis in the *device's current
 * zone* via Intl. There is deliberately no manual offset arithmetic in this
 * file, and there must never be any elsewhere.
 */

import { useEffect, useRef, useState } from 'react'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The device's current zone, resolved at call time (it can change on travel). */
export function deviceZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
})

/** UTC epoch ms → local wall clock, e.g. `03:41`. */
export function formatClock(ms: number): string {
  return clockFormat.format(new Date(ms))
}

/** UTC epoch ms → local day label, e.g. `Sat 27 Jul`. */
export function formatDay(ms: number): string {
  return dayFormat.format(new Date(ms))
}

/** True when the two instants fall on the same local calendar day. */
export function isSameLocalDay(a: number, b: number): boolean {
  return dayFormat.format(new Date(a)) === dayFormat.format(new Date(b))
}

/**
 * A duration in ms → a compact human string.
 *
 *   45_000      → `45s`
 *   252_000     → `4m 12s`
 *   5_040_000   → `1h 24m`
 *   180_000_000 → `2d 2h`
 *
 * Always exactly two units, largest first, so the width stays predictable.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms))

  if (total >= DAY) {
    const days = Math.floor(total / DAY)
    const hours = Math.floor((total % DAY) / HOUR)
    return `${days}d ${hours}h`
  }
  if (total >= HOUR) {
    const hours = Math.floor(total / HOUR)
    const minutes = Math.floor((total % HOUR) / MINUTE)
    return `${hours}h ${minutes}m`
  }
  if (total >= MINUTE) {
    const minutes = Math.floor(total / MINUTE)
    const seconds = Math.floor((total % MINUTE) / SECOND)
    return `${minutes}m ${seconds}s`
  }
  return `${Math.floor(total / SECOND)}s`
}

/**
 * A duration in ms → a fixed-width stopwatch readout, `H:MM:SS` or `MM:SS`.
 * Used for the live counter on a running Span, where digits should not jump.
 */
export function formatStopwatch(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * `Date.now()`, re-rendered on an interval. The tick is aligned to the wall
 * second so a stopwatch flips when the clock does, not 400ms after it.
 */
export function useNow(intervalMs = SECOND): number {
  const [now, setNow] = useState(() => Date.now())
  const intervalRef = useRef(intervalMs)
  intervalRef.current = intervalMs

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>
    let cancelled = false

    const schedule = () => {
      const period = intervalRef.current
      const delay = period - (Date.now() % period)
      timeout = setTimeout(() => {
        if (cancelled) return
        setNow(Date.now())
        schedule()
      }, delay)
    }
    schedule()

    // Coming back from a locked screen: catch up immediately.
    const resync = () => {
      if (document.visibilityState === 'visible') setNow(Date.now())
    }
    document.addEventListener('visibilitychange', resync)

    return () => {
      cancelled = true
      clearTimeout(timeout)
      document.removeEventListener('visibilitychange', resync)
    }
  }, [])

  return now
}

/** Live elapsed milliseconds since `startAt`, updated once a second. */
export function useElapsed(startAt: number): number {
  const now = useNow(SECOND)
  return Math.max(0, now - startAt)
}
