import { and, asc, desc, eq, gte, isNull, lte } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, sqlite } from '../db/client.js'
import { events, trackers, type EventRow } from '../db/schema.js'
import { newId } from '../lib/ids.js'
import { readJson } from '../lib/http.js'
import {
  createEventSchema,
  listEventsQuerySchema,
  patchEventSchema,
  runningEventsQuerySchema,
  stopEventSchema,
  zodMessage,
} from '../lib/validate.js'

export const eventRoutes = new Hono()

const DEFAULT_LIMIT = 200

eventRoutes.get('/events/running', (c) => {
  const parsed = runningEventsQuerySchema.safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400)

  const rows = db
    .select()
    .from(events)
    .where(
      and(
        eq(events.profileId, parsed.data.profileId),
        eq(events.type, 'INTERVAL'),
        isNull(events.endAt),
      ),
    )
    .orderBy(asc(events.startAt))
    .all()
  return c.json(rows)
})

eventRoutes.get('/events', (c) => {
  const parsed = listEventsQuerySchema.safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400)

  const { profileId, from, to, limit } = parsed.data
  const filters = [eq(events.profileId, profileId)]
  if (from !== undefined) filters.push(gte(events.startAt, from))
  if (to !== undefined) filters.push(lte(events.startAt, to))

  const rows = db
    .select()
    .from(events)
    .where(and(...filters))
    .orderBy(desc(events.startAt))
    .limit(limit ?? DEFAULT_LIMIT)
    .all()
  return c.json(rows)
})

eventRoutes.post('/events', async (c) => {
  const parsed = createEventSchema.safeParse(await readJson(c))
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400)

  const { trackerId, startAt, values, note } = parsed.data

  type Outcome =
    | { kind: 'created'; row: EventRow }
    | { kind: 'no-tracker' }
    | { kind: 'already-running'; eventId: string }

  // The running check and the insert must not straddle a write from elsewhere.
  const create = sqlite.transaction((): Outcome => {
    const tracker = db.select().from(trackers).where(eq(trackers.id, trackerId)).get()
    if (!tracker) return { kind: 'no-tracker' }

    if (tracker.type === 'INTERVAL') {
      const running = db
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.trackerId, trackerId), isNull(events.endAt)))
        .get()
      if (running) return { kind: 'already-running', eventId: running.id }
    }

    const now = Date.now()
    const row: EventRow = {
      id: newId(),
      trackerId: tracker.id,
      profileId: tracker.profileId,
      type: tracker.type,
      startAt: startAt ?? now,
      endAt: null,
      values: values ?? {},
      note: note ?? null,
      createdAt: now,
      updatedAt: now,
    }
    db.insert(events).values(row).run()
    return { kind: 'created', row }
  })

  const result = create()
  if (result.kind === 'no-tracker') return c.json({ error: 'TRACKER_NOT_FOUND' }, 404)
  if (result.kind === 'already-running') {
    return c.json({ error: 'ALREADY_RUNNING', eventId: result.eventId }, 409)
  }
  return c.json(result.row, 201)
})

eventRoutes.post('/events/:id/stop', async (c) => {
  const id = c.req.param('id')
  const parsed = stopEventSchema.safeParse(await readJson(c))
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400)

  const existing = db.select().from(events).where(eq(events.id, id)).get()
  if (!existing) return c.json({ error: 'NOT_FOUND' }, 404)
  if (existing.type === 'INSTANT') return c.json({ error: 'NOT_AN_INTERVAL' }, 400)
  if (existing.endAt !== null) return c.json({ error: 'ALREADY_STOPPED' }, 400)

  const endAt = parsed.data.endAt ?? Date.now()
  if (endAt < existing.startAt) return c.json({ error: 'END_BEFORE_START' }, 400)

  // Deliberately does NOT touch updatedAt. Stopping is how a Span normally
  // completes, not a correction to it — and `updatedAt !== createdAt` is what
  // drives the client's "edited" marker. Bumping it here would put that marker
  // on every Span ever finished, which makes it meaningless. Only PATCH edits.
  db.update(events).set({ endAt }).where(eq(events.id, id)).run()
  const row = db.select().from(events).where(eq(events.id, id)).get()
  return c.json(row)
})

eventRoutes.patch('/events/:id', async (c) => {
  const id = c.req.param('id')
  const parsed = patchEventSchema.safeParse(await readJson(c))
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400)

  const existing = db.select().from(events).where(eq(events.id, id)).get()
  if (!existing) return c.json({ error: 'NOT_FOUND' }, 404)

  const p = parsed.data
  const nextStartAt = 'startAt' in p && p.startAt !== undefined ? p.startAt : existing.startAt
  const nextEndAt = 'endAt' in p ? (p.endAt ?? null) : existing.endAt
  if (nextEndAt !== null && nextEndAt < nextStartAt) {
    return c.json({ error: 'END_BEFORE_START' }, 400)
  }
  // A Moment has no duration, by definition. Letting a patch set endAt on an
  // INSTANT would silently turn it into a Span whose tracker still says
  // INSTANT — the denormalised `type` and the data would disagree forever.
  if (existing.type === 'INSTANT' && nextEndAt !== null) {
    return c.json({ error: 'NOT_AN_INTERVAL' }, 400)
  }

  const patch: Partial<EventRow> = { updatedAt: Date.now() }
  if ('startAt' in p) patch.startAt = nextStartAt
  if ('endAt' in p) patch.endAt = nextEndAt
  if ('values' in p) patch.values = p.values
  if ('note' in p) patch.note = p.note ?? null

  db.update(events).set(patch).where(eq(events.id, id)).run()
  const row = db.select().from(events).where(eq(events.id, id)).get()
  return c.json(row)
})

eventRoutes.delete('/events/:id', (c) => {
  const id = c.req.param('id')
  const existing = db.select({ id: events.id }).from(events).where(eq(events.id, id)).get()
  if (!existing) return c.json({ error: 'NOT_FOUND' }, 404)

  db.delete(events).where(eq(events.id, id)).run()
  return c.body(null, 204)
})
