/// <reference lib="webworker" />

/**
 * TickIt's service worker.
 *
 * Three jobs, in order of how much they matter:
 *
 * 1. **Open offline.** Without this, launching the app while the Pi is
 *    unreachable — rebooting, router down, out of the house — gives a browser
 *    error page rather than a degraded app. The shell is precached so the app
 *    always opens and can say what is wrong.
 * 2. **Receive push.** Reminders are delivered by Web Push, which is handled
 *    here and nowhere else.
 * 3. **Nudge the outbox.** When connectivity returns the page may not be open;
 *    a Background Sync event wakes this worker, which tells any open client to
 *    flush, and failing that the flush happens on next launch.
 *
 * `/api` is never cached. Stale health data shown as current is worse than an
 * honest error, and the outbox — not the cache — is what makes writes durable.
 */

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// Every in-app route is client-rendered, so any navigation resolves to the
// shell. `/api` is denied so a fetch to it can never be answered by index.html.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api\//],
  }),
)

self.addEventListener('install', () => {
  // A log that failed to send should not sit behind an old worker waiting for
  // every tab to close before the fix ships.
  void self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

/* ------------------------------------------------------------------ push -- */

interface PushPayload {
  title: string
  body: string
  tag?: string
}

self.addEventListener('push', (event) => {
  let payload: PushPayload = { title: 'TickIt', body: 'Something needs a look.' }
  try {
    if (event.data) payload = { ...payload, ...(event.data.json() as PushPayload) }
  } catch {
    // A malformed payload must still surface *something*: the push was sent
    // because a tracker went quiet, and silence is the failure mode we are
    // trying to prevent.
  }

  // `renotify` is supported by browsers but missing from lib.dom's
  // NotificationOptions, so the shape is widened rather than dropped: without
  // it a replaced notification updates silently and the point is missed.
  const options: NotificationOptions & { renotify?: boolean } = {
    body: payload.body,
    // A stable per-tracker tag replaces the previous notification instead of
    // stacking a column of them overnight.
    tag: payload.tag ?? 'tickit',
    renotify: Boolean(payload.tag),
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: '/' },
  }

  event.waitUntil(self.registration.showNotification(payload.title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus an existing window rather than opening a second copy of the app.
      for (const client of clients) {
        if ('focus' in client) return client.focus()
      }
      return self.clients.openWindow(url)
    }),
  )
})

/* ---------------------------------------------------------------- outbox -- */

/**
 * The worker does not own the queue — IndexedDB access and retry policy live in
 * the page, which can also update the UI as writes land. This only wakes the
 * page and asks it to flush.
 */
async function askClientsToFlush(): Promise<void> {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of clients) client.postMessage({ type: 'tickit:flush-outbox' })
}

self.addEventListener('sync', (event) => {
  const sync = event as ExtendableEvent & { tag?: string }
  if (sync.tag === 'tickit-outbox') sync.waitUntil(askClientsToFlush())
})

self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | undefined)?.type === 'tickit:skip-waiting') {
    void self.skipWaiting()
  }
})
