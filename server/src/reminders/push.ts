import webpush from 'web-push'
import type { PushSubRow } from '../db/schema.js'

/**
 * Web Push is optional. The keys are operator-supplied and there is no sane
 * default for them, so the server treats "unconfigured" as a normal state:
 * reminders are simply disabled and everything else runs. An app that refuses
 * to start because a nice-to-have is unconfigured is a worse app.
 *
 * Generate a keypair with `npm run vapid:generate` in server/.
 */
const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? ''
const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? ''
const subject = process.env.VAPID_SUBJECT?.trim() || 'mailto:admin@localhost'

let configured = false

if (publicKey && privateKey) {
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey)
    configured = true
  } catch (err) {
    console.warn(`[tickit] push disabled — VAPID keys rejected: ${(err as Error).message}`)
  }
}

/** Is Web Push usable? False means reminders never fire and `/api/push/key` 503s. */
export function isPushConfigured(): boolean {
  return configured
}

/** The VAPID public key the client needs for `pushManager.subscribe`. */
export function vapidPublicKey(): string {
  return publicKey
}

export interface NotificationPayload {
  title: string
  body: string
  /** Stable per tracker, so a re-notification replaces rather than stacks. */
  tag: string
}

export type PushOutcome =
  | { kind: 'sent' }
  | { kind: 'gone' } // 404/410 — the subscription is dead, delete it
  | { kind: 'failed'; error: string }

/**
 * Deliver one notification to one subscription.
 *
 * Never throws: the sweep pushes to every subscription in turn and one dead
 * browser must not take the rest of the round down with it.
 */
export async function sendPush(
  sub: Pick<PushSubRow, 'endpoint' | 'p256dh' | 'auth'>,
  payload: NotificationPayload,
): Promise<PushOutcome> {
  if (!configured) return { kind: 'failed', error: 'PUSH_NOT_CONFIGURED' }
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 60 * 60 },
    )
    return { kind: 'sent' }
  } catch (err) {
    const e = err as { statusCode?: number; body?: string; message?: string }
    const status = e.statusCode
    if (status === 404 || status === 410) return { kind: 'gone' }

    // `web-push` throws a WebPushError whose `.message` is always the same
    // useless string — "Received unexpected response code". Everything that
    // identifies the problem is on `.statusCode` and `.body`, so a log built
    // from `.message` alone says nothing you can act on. Ask how we know.
    const body = (e.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
    const parts = [status ? `HTTP ${status}` : e.message ?? 'unknown error']
    if (body) parts.push(body)

    // The one failure worth naming outright, because the cause is not in the
    // response. Apple validates the VAPID JWT's `sub` claim and rejects a
    // non-routable address — `mailto:tickit@localhost` fails, a real mailbox
    // does not. Every push to Apple fails with 403 and nothing says why.
    if (status === 403) {
      parts.push('— check VAPID_SUBJECT is a real mailto: or https: URL (Apple rejects non-routable ones)')
    }

    return { kind: 'failed', error: parts.join(' ') }
  }
}
