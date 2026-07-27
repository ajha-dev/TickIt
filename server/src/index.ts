import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { databasePath } from './db/client.js'
import { runMigrations } from './db/migrate.js'
import { seed } from './db/seed.js'
import { eventRoutes } from './routes/events.js'
import { healthRoutes } from './routes/health.js'
import { profileRoutes } from './routes/profiles.js'
import { pushRoutes } from './routes/push.js'
import { reminderRoutes } from './routes/reminders.js'
import { trackerRoutes } from './routes/trackers.js'
import { startSweep } from './reminders/sweep.js'

const here = dirname(fileURLToPath(import.meta.url))

/** `src/` and `dist/` are both one level below the server workspace root. */
const clientDist = resolve(process.env.CLIENT_DIST ?? resolve(here, '../../client/dist'))
/** serve-static resolves `root` against process.cwd(). */
const staticRoot = relative(process.cwd(), clientDist) || '.'
const indexHtml = resolve(clientDist, 'index.html')

runMigrations()
seed()

const app = new Hono()

const api = new Hono()
api.route('/', healthRoutes)
api.route('/', profileRoutes)
api.route('/', trackerRoutes)
api.route('/', eventRoutes)
api.route('/', reminderRoutes)
api.route('/', pushRoutes)

app.route('/api', api)

app.notFound((c) => {
  if (c.req.path.startsWith('/api')) return c.json({ error: 'NOT_FOUND' }, 404)
  return c.text('Not found', 404)
})

app.onError((err, c) => {
  if (err instanceof SyntaxError) return c.json({ error: 'INVALID_JSON' }, 400)
  console.error('[tickit]', err)
  return c.json({ error: 'INTERNAL_ERROR' }, 500)
})

// Built SPA — tolerated as missing during development.
app.use('/*', serveStatic({ root: staticRoot }))

app.get('/*', (c) => {
  if (c.req.path.startsWith('/api')) return c.notFound()
  if (!existsSync(indexHtml)) {
    return c.text('client build not found — run `npm run build --workspace=client`', 404)
  }
  return c.html(readFileSync(indexHtml, 'utf8'))
})

const port = Number(process.env.PORT ?? 3002)
const hostname = '0.0.0.0'

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[tickit] listening on http://${hostname}:${info.port}`)
  console.log(`[tickit] database ${databasePath}`)
  console.log(`[tickit] client dist ${clientDist}${existsSync(clientDist) ? '' : ' (missing)'}`)

  // Reminders are optional. Missing VAPID keys disable them and nothing else —
  // the app must never fail to start because a nice-to-have is unconfigured.
  if (startSweep()) {
    console.log('[tickit] reminders enabled — sweeping every 60s')
  } else {
    console.log(
      '[tickit] reminders disabled — set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable (npm run vapid:generate)',
    )
  }
})
