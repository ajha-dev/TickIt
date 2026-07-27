import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/client.js'
import { pushSubs } from '../db/schema.js'
import { readJson } from '../lib/http.js'
import { newId } from '../lib/ids.js'
import { isPushConfigured, vapidPublicKey } from '../reminders/push.js'
import { subscribePushSchema, unsubscribePushSchema, zodMessage } from '../lib/validate.js'

export const pushRoutes = new Hono()

pushRoutes.get('/push/key', (c) => {
  // 503 rather than an empty string: the client can tell "the operator has not
  // set this up" apart from "I got a key", and show the right thing.
  if (!isPushConfigured()) return c.json({ error: 'PUSH_NOT_CONFIGURED' }, 503)
  return c.json({ publicKey: vapidPublicKey() })
})

pushRoutes.post('/push/subscribe', async (c) => {
  const parsed = subscribePushSchema.safeParse(await readJson(c))
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400)

  const { endpoint, keys } = parsed.data
  const now = Date.now()

  // Idempotent on `endpoint`. A browser re-subscribes on every load and rotates
  // its keys when the push service asks it to, so the same endpoint arriving
  // twice is the normal case, not a conflict — refresh the row, never add one.
  db.insert(pushSubs)
    .values({
      id: newId(),
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      createdAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: pushSubs.endpoint,
      set: { p256dh: keys.p256dh, auth: keys.auth, lastSeenAt: now },
    })
    .run()

  return c.body(null, 204)
})

pushRoutes.post('/push/unsubscribe', async (c) => {
  const parsed = unsubscribePushSchema.safeParse(await readJson(c))
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400)

  // 204 whether or not the row existed. Unsubscribing is a statement about the
  // desired end state, and a browser that already lost its subscription asking
  // again is not an error.
  db.delete(pushSubs).where(eq(pushSubs.endpoint, parsed.data.endpoint)).run()
  return c.body(null, 204)
})
