import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { events, pushSubs, reminders, trackers } from '../db/schema.js'
import { isPushConfigured, sendPush } from './push.js'
import { buildPayload, buildSchedulePayload, shouldFire, shouldFireSchedule } from './rules.js'

export const SWEEP_INTERVAL_MS = 60_000

export { shouldFire, shouldFireSchedule } from './rules.js'

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
      kind: reminders.kind,
      afterMs: reminders.afterMs,
      days: reminders.days,
      timesMin: reminders.timesMin,
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
    // What to send, and what to stamp `lastFiredAt` with. The two are decided
    // together because a SCHEDULE can stamp without sending — an occurrence too
    // old to be true is consumed silently.
    let payload: { title: string; body: string; tag: string } | null = null
    let stampAt: number | null = null

    if (r.kind === 'SCHEDULE') {
      // A SCHEDULE row without a schedule cannot occur through the routes; if
      // one ever does, silence is the right failure.
      if (!r.days || !r.timesMin) continue

      const decision = shouldFireSchedule({
        now,
        days: r.days,
        timesMin: r.timesMin,
        lastFiredAt: r.lastFiredAt,
        timeZone: r.timeZone,
      })
      if (decision.kind === 'NONE') continue

      // Both FIRE and CONSUME stamp, and both stamp THE OCCURRENCE'S OWN
      // timestamp rather than `now`: that is what makes a second sweep in the
      // same minute a no-op and stops a clock adjustment resurrecting it. It
      // also consumes every older outstanding occurrence in one stroke, so a Pi
      // that was off all week sends one notification, not thirty.
      stampAt = decision.occurrenceAt
      if (decision.kind === 'FIRE') {
        payload = buildSchedulePayload(
          r.trackerName,
          r.trackerId,
          decision.occurrenceAt,
          r.timeZone,
        )
      }
      // Quiet hours are deliberately not consulted here. See the contract: a
      // scheduled reminder fires at a time the user picked.
    } else {
      // An IDLE row always has a threshold; the column is nullable only because
      // a SCHEDULE has no use for it.
      if (r.afterMs === null) continue

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

      stampAt = now
      payload = buildPayload(r.trackerName, r.trackerId, now - anchor)
    }

    if (stampAt !== null) {
      db.update(reminders)
        .set({ lastFiredAt: stampAt, updatedAt: now })
        .where(eq(reminders.id, r.id))
        .run()
    }

    if (!payload) continue

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
