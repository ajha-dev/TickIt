import { asc, count, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/client.js'
import { events, profiles, trackers, type FieldDef } from '../db/schema.js'
import { newId } from '../lib/ids.js'
import { DEFAULT_COLOUR, DEFAULT_ICON, readJson } from '../lib/http.js'
import {
  createTrackerSchema,
  listTrackersQuerySchema,
  patchTrackerSchema,
  zodMessage,
  type FieldDefInput,
} from '../lib/validate.js'

export const trackerRoutes = new Hono()

/**
 * Turn validated field input into stored `FieldDef`s.
 *
 * A submitted field that carries the id of an existing field is an *edit of
 * that field*, so it keeps its id: values already logged under that id stay
 * attached. Ids are never regenerated on edit. A field with no id (or an id the
 * tracker has never had) is new and gets a fresh server-assigned uuidv7.
 *
 * Fields missing from the submitted list are dropped from the definition —
 * without touching any logged event. See `Deleting a field` in the contract.
 */
function resolveFields(input: FieldDefInput[], existing: FieldDef[]): FieldDef[] {
  const existingIds = new Set(existing.map((f) => f.id))
  return input.map((f) => {
    const def: FieldDef = {
      id: f.id !== undefined && existingIds.has(f.id) ? f.id : newId(),
      label: f.label,
      kind: f.kind,
    }
    if (f.unit !== undefined) def.unit = f.unit
    if (f.options !== undefined) def.options = f.options
    if (f.defaultValue !== undefined) def.defaultValue = f.defaultValue
    return def
  })
}

trackerRoutes.get('/trackers', (c) => {
  const parsed = listTrackersQuerySchema.safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400)

  const rows = db
    .select()
    .from(trackers)
    .where(eq(trackers.profileId, parsed.data.profileId))
    .orderBy(asc(trackers.sortOrder), asc(trackers.createdAt))
    .all()
  return c.json(rows)
})

trackerRoutes.post('/trackers', async (c) => {
  const parsed = createTrackerSchema.safeParse(await readJson(c))
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400)

  const profile = db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.id, parsed.data.profileId))
    .get()
  if (!profile) return c.json({ error: 'PROFILE_NOT_FOUND' }, 404)

  // Counting taps only means anything inside a span. A Moment has no duration to
  // count within, so this is refused loudly rather than stored and ignored.
  if (parsed.data.counter === true && parsed.data.type === 'INSTANT') {
    return c.json({ error: 'COUNTER_NOT_ALLOWED' }, 400)
  }

  const now = Date.now()
  const row = {
    id: newId(),
    profileId: parsed.data.profileId,
    name: parsed.data.name,
    type: parsed.data.type,
    colour: parsed.data.colour ?? DEFAULT_COLOUR,
    icon: parsed.data.icon ?? DEFAULT_ICON,
    sortOrder: 0,
    fields: resolveFields(parsed.data.fields ?? [], []),
    counter: parsed.data.counter ?? false,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  db.insert(trackers).values(row).run()
  return c.json(row)
})

trackerRoutes.patch('/trackers/:id', async (c) => {
  const id = c.req.param('id')
  const parsed = patchTrackerSchema.safeParse(await readJson(c))
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400)

  const existing = db.select().from(trackers).where(eq(trackers.id, id)).get()
  if (!existing) return c.json({ error: 'NOT_FOUND' }, 404)

  const p = parsed.data
  // `type` is immutable, so the stored row is the only authority on it.
  if (p.counter === true && existing.type === 'INSTANT') {
    return c.json({ error: 'COUNTER_NOT_ALLOWED' }, 400)
  }

  const patch: Partial<typeof existing> = { updatedAt: Date.now() }
  if ('name' in p) patch.name = p.name
  if ('colour' in p) patch.colour = p.colour
  if ('icon' in p) patch.icon = p.icon
  if ('sortOrder' in p) patch.sortOrder = p.sortOrder
  if ('archivedAt' in p) patch.archivedAt = p.archivedAt
  if (p.fields !== undefined) patch.fields = resolveFields(p.fields, existing.fields)
  // Changeable after creation, unlike `type` — it is configuration, not
  // identity. Events already logged keep their ticks either way; the app does
  // not rewrite history to match a definition change.
  if (p.counter !== undefined) patch.counter = p.counter

  db.update(trackers).set(patch).where(eq(trackers.id, id)).run()
  const row = db.select().from(trackers).where(eq(trackers.id, id)).get()
  return c.json(row)
})

trackerRoutes.delete('/trackers/:id', (c) => {
  const id = c.req.param('id')
  const existing = db.select({ id: trackers.id }).from(trackers).where(eq(trackers.id, id)).get()
  if (!existing) return c.json({ error: 'NOT_FOUND' }, 404)

  db.delete(trackers).where(eq(trackers.id, id)).run()
  return c.body(null, 204)
})

trackerRoutes.get('/trackers/:id/delete-preview', (c) => {
  const id = c.req.param('id')
  const existing = db.select({ id: trackers.id }).from(trackers).where(eq(trackers.id, id)).get()
  if (!existing) return c.json({ error: 'NOT_FOUND' }, 404)

  const eventCount =
    db.select({ n: count() }).from(events).where(eq(events.trackerId, id)).get()?.n ?? 0
  return c.json({ events: eventCount })
})
