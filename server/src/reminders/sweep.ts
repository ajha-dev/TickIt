import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { events, pushSubs, reminders, trackers } from '../db/schema.js'
import { isPushConfigured, sendPush } from './push.js'
import { buildPayload, shouldFire } from './rules.js'

export const SWEEP_INTERVAL_MS = 60_000

export { shouldFire } from './rules.js'

/**
 * One pass over every enabled reminder.
 *
 * Resolves each tracker's anchor in SQL — `max(end_at ?? start_at)` — so a
 * hundred reminders are one query, not a hundred. A reminder whose tracker has
 * no events falls back to the reminder's own `createdAt`.
 */
export async function sweepOnce(now: number): Promise<void> {
  const subs = db.select().from(pushSubs).all()
  // Nothing to deliver to. Deliberately does not consume idle periods: a user
  // who subscribes tomorrow should still be told their tracker is quiet.
  if (subs.length === 0) return

  const rows = db
    .select({
      id: reminders.id,
      trackerId: reminders.trackerId,
      afterMs: reminders.afterMs,
      quietFromMin: reminders.quietFromMin,
      quietToMin: reminders.quietToMin,
      timeZone: reminders.timeZone,
      lastFiredAt: reminders.lastFiredAt,
      createdAt: reminders.createdAt,
      trackerName: trackers.name,
      lastActivity: sql<
        number | null
      >`(select max(coalesce(${events.endAt}, ${events.startAt})) from ${events} where ${events.trackerId} = ${reminders.trackerId})`,
    })
    .from(reminders)
    .innerJoin(trackers, eq(trackers.id, reminders.trackerId))
    .where(eq(reminders.enabled, true))
    .all()

  // A dead endpoint is dead for every reminder in this round, not just the one
  // that discovered it. Collect and delete once.
  const dead = new Set<string>()

  for (const r of rows) {
    const anchor = r.lastActivity ?? r.createdAt
    const decision = shouldFire({
      now,
      anchor,
      afterMs: r.afterMs,
      lastFiredAt: r.lastFiredAt,
      quietFromMin: r.quietFromMin,
      quietToMin: r.quietToMin,
      timeZone: r.timeZone,
    })

    if (decision === 'NOT_IDLE' || decision === 'ALREADY_FIRED') continue

    // Quiet hours HOLD the idle period rather than consuming it: no stamp, so
    // the first sweep after the window closes fires with a freshly computed
    // body ("Nothing logged for 10h"). Consuming it here would mean sleeping
    // through the night and being told nothing at all in the morning.
    if (decision === 'QUIET') continue

    db.update(reminders)
      .set({ lastFiredAt: now, updatedAt: now })
      .where(eq(reminders.id, r.id))
      .run()

    const payload = buildPayload(r.trackerName, r.trackerId, now - anchor)
    for (const sub of subs) {
      if (dead.has(sub.endpoint)) continue
      // One failing subscription must not abort the round for the others —
      // `sendPush` never throws, it reports.
      const outcome = await sendPush(sub, payload)
      if (outcome.kind === 'gone') {
        dead.add(sub.endpoint)
      } else if (outcome.kind === 'failed') {
        console.warn(`[tickit] push failed for ${sub.endpoint}: ${outcome.error}`)
      }
    }
  }

  for (const endpoint of dead) {
    db.delete(pushSubs).where(eq(pushSubs.endpoint, endpoint)).run()
    console.log(`[tickit] push subscription gone, removed ${endpoint}`)
  }
}

/**
 * Start the 60s sweep. Returns a stop function, or null when Web Push is not
 * configured — in which case reminders are stored and served but never fire.
 *
 * The body is wrapped and the interval is never allowed to see a rejection: an
 * unhandled throw here would silently kill the timer and reminders would stop
 * for as long as the process lived, with nothing to show for it.
 */
export function startSweep(): (() => void) | null {
  if (!isPushConfigured()) return null

  let running = false
  const tick = (): void => {
    // A slow round must not overlap the next one.
    if (running) return
    running = true
    sweepOnce(Date.now())
      .catch((err) => console.error('[tickit] reminder sweep failed', err))
      .finally(() => {
        running = false
      })
  }

  const timer = setInterval(tick, SWEEP_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
