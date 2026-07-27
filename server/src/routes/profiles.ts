import { asc, count, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/client.js'
import { events, profiles, trackers } from '../db/schema.js'
import { newId } from '../lib/ids.js'
import { DEFAULT_COLOUR, DEFAULT_ICON, readJson } from '../lib/http.js'
import { createProfileSchema, patchProfileSchema, zodMessage } from '../lib/validate.js'

export const profileRoutes = new Hono()

profileRoutes.get('/profiles', (c) => {
  const rows = db
    .select()
    .from(profiles)
    .orderBy(asc(profiles.sortOrder), asc(profiles.createdAt))
    .all()
  return c.json(rows)
})

profileRoutes.post('/profiles', async (c) => {
  const parsed = createProfileSchema.safeParse(await readJson(c))
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400)

  const now = Date.now()
  const row = {
    id: newId(),
    name: parsed.data.name,
    colour: parsed.data.colour ?? DEFAULT_COLOUR,
    icon: parsed.data.icon ?? DEFAULT_ICON,
    sortOrder: 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  db.insert(profiles).values(row).run()
  return c.json(row)
})

profileRoutes.patch('/profiles/:id', async (c) => {
  const id = c.req.param('id')
  const parsed = patchProfileSchema.safeParse(await readJson(c))
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400)

  const existing = db.select().from(profiles).where(eq(profiles.id, id)).get()
  if (!existing) return c.json({ error: 'NOT_FOUND' }, 404)

  const p = parsed.data
  const patch: Partial<typeof existing> = { updatedAt: Date.now() }
  if ('name' in p) patch.name = p.name
  if ('colour' in p) patch.colour = p.colour
  if ('icon' in p) patch.icon = p.icon
  if ('sortOrder' in p) patch.sortOrder = p.sortOrder
  if ('archivedAt' in p) patch.archivedAt = p.archivedAt

  db.update(profiles).set(patch).where(eq(profiles.id, id)).run()
  const row = db.select().from(profiles).where(eq(profiles.id, id)).get()
  return c.json(row)
})

profileRoutes.delete('/profiles/:id', (c) => {
  const id = c.req.param('id')
  const existing = db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, id)).get()
  if (!existing) return c.json({ error: 'NOT_FOUND' }, 404)

  db.delete(profiles).where(eq(profiles.id, id)).run()
  return c.body(null, 204)
})

profileRoutes.get('/profiles/:id/delete-preview', (c) => {
  const id = c.req.param('id')
  const existing = db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, id)).get()
  if (!existing) return c.json({ error: 'NOT_FOUND' }, 404)

  const trackerCount =
    db.select({ n: count() }).from(trackers).where(eq(trackers.profileId, id)).get()?.n ?? 0
  const eventCount =
    db.select({ n: count() }).from(events).where(eq(events.profileId, id)).get()?.n ?? 0

  return c.json({ trackers: trackerCount, events: eventCount })
})
