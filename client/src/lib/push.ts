/**
 * The page half of Web Push: fetch the VAPID key, ask for permission, and
 * register the subscription with the server. The service worker already
 * handles `push` and `notificationclick`.
 *
 * Two rules shape everything here:
 *
 * 1. **Never prompt on load.** A notification prompt fired at startup is how an
 *    app gets permanently denied, and a denial cannot be undone from script.
 *    `enablePush` is only ever called from the tap that saves a reminder.
 * 2. **Nothing here may fail a save.** Push is the delivery mechanism, not the
 *    reminder. Every failure mode is reported as a value so the caller can save
 *    the reminder anyway and say plainly what will not happen.
 */

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported'

/** True when this browser could in principle receive a push here. */
export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined'
  )
}

export function notificationPermission(): NotificationPermissionState {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

/* ------------------------------------------------------------ vapid key -- */

export type VapidKey =
  | { kind: 'ok'; publicKey: string }
  /** 503 PUSH_NOT_CONFIGURED — the operator never set VAPID keys. */
  | { kind: 'not-configured' }
  | { kind: 'unsupported' }
  | { kind: 'error' }

/**
 * `GET /api/push/key`. Never throws — the result is a state the UI renders,
 * not an exception, because "the operator has not set this up" is a perfectly
 * ordinary condition and must not look like a bug.
 */
export async function fetchVapidKey(): Promise<VapidKey> {
  if (!pushSupported()) return { kind: 'unsupported' }

  let res: Response
  try {
    res = await fetch('/api/push/key')
  } catch {
    return { kind: 'error' }
  }

  if (res.status === 503) return { kind: 'not-configured' }
  if (!res.ok) return { kind: 'error' }

  const payload = (await res.json().catch(() => null)) as { publicKey?: unknown } | null
  if (!payload || typeof payload.publicKey !== 'string' || payload.publicKey.length === 0) {
    return { kind: 'error' }
  }
  return { kind: 'ok', publicKey: payload.publicKey }
}

/* ---------------------------------------------------------- subscription -- */

export type PushOutcome =
  | { kind: 'subscribed' }
  /** Blocked. Only the user can undo this, in browser settings. */
  | { kind: 'denied' }
  /** The prompt was dismissed without an answer — still askable later. */
  | { kind: 'dismissed' }
  /** No active service worker: the dev server, or a browser that refused one. */
  | { kind: 'no-service-worker' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }

const SW_READY_TIMEOUT_MS = 4000

/**
 * The active registration, or null.
 *
 * `navigator.serviceWorker.ready` never resolves when no worker is registered
 * at all — which is exactly the case in the Vite dev server, where the SW is
 * disabled by design. So it is raced against a timeout rather than awaited.
 */
async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  const existing = await navigator.serviceWorker.getRegistration().catch(() => undefined)
  if (existing?.active) return existing

  const ready = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), SW_READY_TIMEOUT_MS)),
  ]).catch(() => null)

  return ready ?? null
}

/** VAPID keys travel as URL-safe base64; `subscribe` wants the raw bytes. */
function urlBase64ToBytes(base64: string) {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  const normal = padded.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(normal)
  // Backed by an explicit ArrayBuffer so the array is not typed as possibly
  // shared — `pushManager.subscribe` will not take a SharedArrayBuffer view.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function bytesToUrlBase64(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Permission, subscription, and registration with the server, in that order.
 *
 * Call this synchronously from a user gesture: `requestPermission()` is the
 * first await inside, so the tap's activation is still live when the prompt
 * would appear. Anything fetched beforehand (the VAPID key) must already be in
 * hand — which is why the editor loads it when the sheet opens.
 */
export async function enablePush(publicKey: string): Promise<PushOutcome> {
  if (!pushSupported()) return { kind: 'unsupported' }

  if (Notification.permission === 'denied') return { kind: 'denied' }
  if (Notification.permission === 'default') {
    let permission: NotificationPermission
    try {
      permission = await Notification.requestPermission()
    } catch {
      return { kind: 'error', message: 'The permission prompt could not be shown.' }
    }
    if (permission === 'denied') return { kind: 'denied' }
    if (permission !== 'granted') return { kind: 'dismissed' }
  }

  const registration = await activeRegistration()
  if (!registration) return { kind: 'no-service-worker' }

  const applicationServerKey = urlBase64ToBytes(publicKey)

  let subscription: PushSubscription | null
  try {
    subscription = await registration.pushManager.getSubscription()

    // A subscription minted against a different VAPID key can never be
    // decrypted by this server. Replace it rather than storing a dead row.
    if (subscription) {
      const current = subscription.options.applicationServerKey
      if (!current || bytesToUrlBase64(current) !== bytesToUrlBase64(applicationServerKey.buffer)) {
        await subscription.unsubscribe().catch(() => undefined)
        subscription = null
      }
    }

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        // Required by Chrome, and honest: every push we send shows a
        // notification.
        userVisibleOnly: true,
        applicationServerKey,
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not subscribe to push.'
    // Chrome reports a blocked prompt as a NotAllowedError here rather than in
    // `requestPermission`.
    if (err instanceof Error && err.name === 'NotAllowedError') return { kind: 'denied' }
    return { kind: 'error', message }
  }

  const json = subscription.toJSON()
  const endpoint = json.endpoint
  const p256dh = json.keys?.p256dh
  const auth = json.keys?.auth
  if (!endpoint || !p256dh || !auth) {
    return { kind: 'error', message: 'The browser returned an incomplete subscription.' }
  }

  try {
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, keys: { p256dh, auth } }),
    })
    // Idempotent on the server, so a 204 is the only success and a repeat of
    // the same endpoint is not a conflict.
    if (!res.ok) return { kind: 'error', message: `The server refused the subscription (${res.status}).` }
    await res.arrayBuffer().catch(() => undefined)
  } catch {
    return { kind: 'error', message: 'Could not reach the server to register this device.' }
  }

  return { kind: 'subscribed' }
}
