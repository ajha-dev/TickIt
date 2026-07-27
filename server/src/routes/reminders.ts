import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/client.js'
import { reminders, trackers, type ReminderRow } from '../db/schema.js'
import { readJson } from '../lib/http.js'
import { newId } from '../lib/ids.js'
import {
  createReminderSchema,
  listRemindersQuerySchema,
  patchReminderSchema,
  zodMessage,
} from '../lib/validate.js'

export const reminderRoutes = new Hono()

/**
 * Quiet hours are all-or-nothing. On PATCH the check has to run against the
 * *merged* row: sending only `quietToMin` on a reminder that already has a
 * `quietFromMin` is a legitimate edit, and sending only one end to a reminder
 * with no window at all is not.
 */
function quietHoursError(from: number | null, to: number | null): string | null {
  if ((from === null) !== (to === null)) return 'QUIET_HOURS_INCOMPLETE'
  if (from !== null && to !== null && from === to) return 'BAD_QUIET_HOURS'
  return null
}

reminderRoutes.get('/reminders', (c) => {
  const parsed = listRemindersQuerySchema.safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400)

  const rows = db
    .select()
    .from(reminders)
    .where(eq(reminders.profileId, parsed.data.profileId))
    .orderBy(asc(reminders.createdAt))
    .all()
  return c.json(rows)
})

reminderRoutes.post('/reminders', async (c) => {
  const parsed = createReminderSchema.safeParse(await readJson(c))
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400)

  const { trackerId, afterMs, timeZone } = parsed.data

  const tracker = db
    .select({ id: trackers.id, profileId: trackers.profileId })
    .from(trackers)
    .where(eq(trackers.id, trackerId))
    .get()
  if (!tracker) return c.json({ error: 'TRACKER_NOT_FOUND' }, 404)

  // One tracker, one reminder. The unique index is the real guarantee; this
  // check is what turns it into the contract's 409 instead of a 500.
  const existing = db
    .select({ id: reminders.id })
    .from(reminders)
    .where(eq(reminders.trackerId, trackerId))
    .get()
  if (existing) return c.json({ error: 'REMINDER_EXISTS', reminderId: existing.id }, 409)

  const now = Date.now()
  const row: ReminderRow = {
    id: newId(),
    trackerId: tracker.id,
    // Denormalised from the tracker, like Event.profileId — the client lists
    // reminders by profile and should not need a join to do it.
    profileId: tracker.profileId,
    afterMs,
    quietFromMin: parsed.data.quietFromMin ?? null,
    quietToMin: parsed.data.quietToMin ?? null,
    timeZone,
    enabled: true,
    // Never fired. The sweep anchors a brand-new reminder on `createdAt`, so a
    // dormant tracker stays quiet until it has genuinely been idle `afterMs`.
    lastFiredAt: null,
    createdAt: now,
    updatedAt: now,
  }
  db.insert(reminders).values(row).run()
  return c.json(row)
})

reminderRoutes.patch('/reminders/:id', async (c) => {
  const id = c.req.param('id')
  const parsed = patchReminderSchema.safeParse(await readJson(c))
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400)

  const existing = db.select().from(reminders).where(eq(reminders.id, id)).get()
  if (!existing) return c.json({ error: 'NOT_FOUND' }, 404)

  const p = parsed.data
  const nextFrom = 'quietFromMin' in p ? (p.quietFromMin ?? null) : existing.quietFromMin
  const nextTo = 'quietToMin' in p ? (p.quietToMin ?? null) : existing.quietToMin
  const quietError = quietHoursError(nextFrom, nextTo)
  if (quietError) return c.json({ error: quietError }, 400)

  const patch: Partial<ReminderRow> = { updatedAt: Date.now() }
  if (p.afterMs !== undefined) patch.afterMs = p.afterMs
  if ('quietFromMin' in p || 'quietToMin' in p) {
    patch.quietFromMin = nextFrom
    patch.quietToMin = nextTo
  }
  if (p.timeZone !== undefined) patch.timeZone = p.timeZone
  if (p.enabled !== undefined) patch.enabled = p.enabled

  db.update(reminders).set(patch).where(eq(reminders.id, id)).run()
  const row = db.select().from(reminders).where(eq(reminders.id, id)).get()
  return c.json(row)
})

reminderRoutes.delete('/reminders/:id', (c) => {
  const id = c.req.param('id')
  const existing = db.select({ id: reminders.id }).from(reminders).where(eq(reminders.id, id)).get()
  if (!existing) return c.json({ error: 'NOT_FOUND' }, 404)

  db.delete(reminders).where(eq(reminders.id, id)).run()
  return c.body(null, 204)
})
