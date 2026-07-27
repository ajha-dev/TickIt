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
  reminderFieldsForKindError,
  sortTimes,
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

  const { trackerId, kind, timeZone } = parsed.data

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
  const isSchedule = kind === 'SCHEDULE'
  const row: ReminderRow = {
    id: newId(),
    trackerId: tracker.id,
    // Denormalised from the tracker, like Event.profileId — the client lists
    // reminders by profile and should not need a join to do it.
    profileId: tracker.profileId,
    kind,
    // Exactly one half of the row is populated. The schema allowed only the
    // matching fields through, so the other half is null by construction.
    afterMs: isSchedule ? null : (parsed.data.afterMs ?? null),
    quietFromMin: isSchedule ? null : (parsed.data.quietFromMin ?? null),
    quietToMin: isSchedule ? null : (parsed.data.quietToMin ?? null),
    days: isSchedule ? (parsed.data.days ?? null) : null,
    timesMin: isSchedule ? sortTimes(parsed.data.timesMin ?? []) : null,
    timeZone,
    enabled: true,
    // Never fired. For IDLE the sweep anchors a brand-new reminder on
    // `createdAt`, so a dormant tracker stays quiet until it has genuinely been
    // idle `afterMs`; for SCHEDULE the first occurrence inside the window is
    // the first thing it can send.
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
  const nextKind = p.kind ?? existing.kind
  const kindChanged = nextKind !== existing.kind

  // The fields must belong to the kind the row ENDS UP as, not the one it
  // started as: `{ kind: 'SCHEDULE', days, timesMin }` on an idle reminder is
  // the whole point of allowing a kind change.
  const fieldsError = reminderFieldsForKindError(nextKind, p)
  if (fieldsError) return c.json({ error: fieldsError }, 400)

  const patch: Partial<ReminderRow> = { updatedAt: Date.now() }

  if (kindChanged) {
    patch.kind = nextKind
    // The new kind has never fired. Carrying the old kind's `lastFiredAt` over
    // would either suppress the first occurrence or, for IDLE, claim an idle
    // period had been reported when it never was.
    patch.lastFiredAt = null
    // Clear the kind being left, so the row cannot hold a stale threshold and a
    // stale schedule at once.
    if (nextKind === 'SCHEDULE') {
      patch.afterMs = null
      patch.quietFromMin = null
      patch.quietToMin = null
    } else {
      patch.days = null
      patch.timesMin = null
    }
  }

  if (nextKind === 'SCHEDULE') {
    const nextDays = p.days ?? (kindChanged ? undefined : (existing.days ?? undefined))
    const nextTimes = p.timesMin ?? (kindChanged ? undefined : (existing.timesMin ?? undefined))
    // Becoming a SCHEDULE means bringing a schedule with you; there is nothing
    // on the row to fall back to.
    if (nextDays === undefined) return c.json({ error: 'DAYS_REQUIRED' }, 400)
    if (nextTimes === undefined) return c.json({ error: 'TIMES_REQUIRED' }, 400)
    if (p.days !== undefined) patch.days = nextDays
    if (p.timesMin !== undefined) patch.timesMin = sortTimes(nextTimes)
  } else {
    const nextAfterMs = p.afterMs ?? (kindChanged ? undefined : (existing.afterMs ?? undefined))
    if (nextAfterMs === undefined) return c.json({ error: 'AFTER_MS_REQUIRED' }, 400)
    if (p.afterMs !== undefined) patch.afterMs = p.afterMs

    // Quiet hours are all-or-nothing, checked against the merged row: sending
    // only `quietToMin` to a reminder that already has a `quietFromMin` is a
    // legitimate edit, and sending one end to a reminder with no window is not.
    const base = kindChanged ? null : existing.quietFromMin
    const baseTo = kindChanged ? null : existing.quietToMin
    const nextFrom = 'quietFromMin' in p ? (p.quietFromMin ?? null) : base
    const nextTo = 'quietToMin' in p ? (p.quietToMin ?? null) : baseTo
    const quietError = quietHoursError(nextFrom, nextTo)
    if (quietError) return c.json({ error: quietError }, 400)
    if ('quietFromMin' in p || 'quietToMin' in p) {
      patch.quietFromMin = nextFrom
      patch.quietToMin = nextTo
    }
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
