import type { QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'

import { ApiError } from '../api.ts'
import * as api from '../api.ts'
import type { Event, TrackerType } from '../types.ts'

/**
 * The offline outbox.
 *
 * Every write the logging path makes is appended to an IndexedDB queue first
 * and sent from there. A tap therefore never depends on the network: with the
 * Pi rebooting, the router down, or the phone out of the house, the log is
 * already durable on the device and the send is a background detail.
 *
 * Three properties carry the whole feature:
 *
 * 1. **The id is minted here.** A UUIDv7 generated at tap time is sent as the
 *    event's id, so a retry after a lost response is recognised by the server
 *    as a replay rather than inserted a second time. Without a client id there
 *    is no safe retry at all — a dropped response is indistinguishable from a
 *    dropped request.
 * 2. **`startAt` is the moment of the tap.** It is stamped when the queue entry
 *    is created and never recomputed. A feed logged at 03:12 with no signal
 *    lands as 03:12 when the phone reconnects at 07:00, not as 07:00. A health
 *    log whose times drift to whenever the network came back is worse than no
 *    log.
 * 3. **Order is preserved and never skipped.** A `stop` for an event whose
 *    `create` is still queued would 404 if it went first, so the queue is
 *    strictly in order and halts on the first transient failure rather than
 *    stepping over it.
 */

/* -------------------------------------------------------------- uuid v7 -- */

let lastMs = 0
let seq = 0

/**
 * A UUIDv7: 48 bits of millisecond timestamp, then a 12-bit counter, then
 * randomness. Time-sortable, so queue keys sort into tap order for free, and
 * the same format the server mints (`uuid`'s `v7`) so ids are indistinguishable
 * whichever side made them.
 *
 * The counter is what makes two taps inside the same millisecond still order
 * correctly — plain randomness there would sort arbitrarily.
 */
export function uuidv7(): string {
  const now = Date.now()
  if (now > lastMs) {
    lastMs = now
    // Seeded low so there is room to count up inside the millisecond.
    seq = Math.floor(Math.random() * 0x400)
  } else {
    seq = (seq + 1) & 0xfff
    if (seq === 0) lastMs += 1
  }
  const ms = lastMs

  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff
  bytes[5] = ms & 0xff
  bytes[6] = 0x70 | ((seq >>> 8) & 0x0f) // version 7
  bytes[7] = seq & 0xff
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f) // variant 10xx

  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/* ------------------------------------------------------------------ ops -- */

export type EventValues = Record<string, string | number | boolean>

interface OpBase {
  /** The event this operation is about. Always the client-minted UUIDv7. */
  id: string
  profileId: string
  /** The tracker's name, kept so a permanent failure can name what was lost. */
  label: string
}

export type OutboxOp =
  | (OpBase & {
      kind: 'create'
      trackerId: string
      type: TrackerType
      /** The moment of the tap. Never the moment of sync. */
      startAt: number
      values: EventValues
      note: string | null
    })
  | (OpBase & { kind: 'stop'; endAt: number })
  | (OpBase & {
      /**
       * The taps of a counted span, **absolute**. Because it is the whole array
       * rather than an increment, replaying it is idempotent for free — three
       * sends of the same op leave the same count — and the same op serves both
       * incrementing and undoing.
       */
      kind: 'count'
      ticks: number[]
    })
  | (OpBase & {
      kind: 'patch'
      patch: {
        startAt?: number
        endAt?: number | null
        values?: EventValues
        note?: string | null
        ticks?: number[]
      }
    })
  | (OpBase & { kind: 'delete' })

interface Entry {
  /** UUIDv7 — the queue's sort key, so entries replay in the order they were made. */
  key: string
  op: OutboxOp
  /** When the user tapped. Distinct from `startAt` for stop/patch/delete. */
  tappedAt: number
  attempts: number
  /** Epoch ms before which this entry must not be retried. */
  nextAttemptAt: number
  lastError: string | null
}

export interface OutboxFailure {
  key: string
  op: OutboxOp
  code: string
  failedAt: number
}

/* --------------------------------------------------------------- indexeddb */

const DB_NAME = 'tickit-outbox'
const DB_VERSION = 1
const QUEUE = 'queue'
const FAILURES = 'failures'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(QUEUE)) db.createObjectStore(QUEUE, { keyPath: 'key' })
      if (!db.objectStoreNames.contains(FAILURES)) db.createObjectStore(FAILURES, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IDB_OPEN_FAILED'))
  }).catch((error: unknown) => {
    // A failed open must not be cached as a permanent verdict — private mode
    // and quota states recover, and the next tap should try again.
    dbPromise = null
    throw error
  })
  return dbPromise
}

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IDB_REQUEST_FAILED'))
  })
}

async function readAll<T>(store: string): Promise<T[]> {
  const db = await openDb()
  return wrap<T[]>(db.transaction(store, 'readonly').objectStore(store).getAll() as IDBRequest<T[]>)
}

async function put(store: string, value: unknown): Promise<void> {
  const db = await openDb()
  await wrap(db.transaction(store, 'readwrite').objectStore(store).put(value))
}

async function remove(store: string, key: string): Promise<void> {
  const db = await openDb()
  await wrap(db.transaction(store, 'readwrite').objectStore(store).delete(key))
}

/* ---------------------------------------------------------------- state -- */

export interface OutboxSnapshot {
  /** Writes waiting to reach the Pi. */
  pending: number
  /** A send is in flight right now. */
  syncing: boolean
  /** The last attempt failed transiently — we are waiting to retry. */
  stalled: boolean
  failures: OutboxFailure[]
  /** Ids of events that exist on this device but not yet on the server. */
  pendingIds: ReadonlySet<string>
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>()

let snapshot: OutboxSnapshot = {
  pending: 0,
  syncing: false,
  stalled: false,
  failures: [],
  pendingIds: EMPTY_IDS,
}

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function setSnapshot(patch: Partial<OutboxSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  emit()
}

/** Recompute the parts of the snapshot that are derived from the stores. */
async function refresh(): Promise<void> {
  const [entries, failures] = await Promise.all([
    readAll<Entry>(QUEUE).catch(() => [] as Entry[]),
    readAll<OutboxFailure>(FAILURES).catch(() => [] as OutboxFailure[]),
  ])
  const pendingIds = new Set<string>()
  for (const entry of entries) {
    if (entry.op.kind === 'create') pendingIds.add(entry.op.id)
  }
  setSnapshot({
    pending: entries.length,
    failures: failures.sort((a, b) => b.failedAt - a.failedAt),
    pendingIds,
  })
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSnapshot(): OutboxSnapshot {
  return snapshot
}

export function useOutbox(): OutboxSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Is this event still only on this device?
 *
 * Read during render without subscribing, deliberately: the callers that care
 * (the running card's "pending" dot) re-render when the running list changes,
 * which is exactly when the answer changes.
 */
export function isPending(eventId: string): boolean {
  return snapshot.pendingIds.has(eventId)
}

/* ------------------------------------------------------------ enqueueing -- */

let queryClient: QueryClient | null = null

/** Ask the service worker to wake us when connectivity returns, if it can. */
function registerBackgroundSync(): void {
  if (!('serviceWorker' in navigator)) return
  void navigator.serviceWorker.ready
    .then(async (registration) => {
      // Background Sync does not exist on iOS Safari. Feature-detected rather
      // than assumed: the outbox is fully functional without it, driven by the
      // online / visibility / startup triggers instead.
      const sync = (registration as ServiceWorkerRegistration & {
        sync?: { register(tag: string): Promise<void> }
      }).sync
      if (!sync) return
      await sync.register('tickit-outbox')
    })
    .catch(() => {
      // Permission denied or unsupported. Not a failure worth surfacing.
    })
}

/**
 * Append one write to the queue. Resolves once it is durable in IndexedDB —
 * which is the point at which the log can no longer be lost.
 */
export async function enqueue(op: OutboxOp, tappedAt: number = Date.now()): Promise<void> {
  const entry: Entry = {
    key: uuidv7(),
    op,
    tappedAt,
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
  }
  await put(QUEUE, entry)
  await refresh()
  registerBackgroundSync()
}

/**
 * Append — or *replace* — a counted span's taps.
 *
 * Forty kicks logged with no signal must not become forty queued requests and
 * forty round trips on reconnect. The op is an absolute set, so a newer array
 * wholly supersedes an older queued one for the same event: a six-tap offline
 * session drains as three entries — create, one merged count, stop — rather
 * than eight.
 *
 * The merged entry **keeps its original key**. The key is the queue's sort
 * order, and holding it is what keeps the count behind its own `create` and in
 * front of any later `stop`. Minting a new one would let a count outlive the
 * stop it preceded.
 *
 * An entry that is mid-flight is never rewritten — it may already have reached
 * the server — so a new entry is appended instead. The newer array supersedes
 * it on arrival regardless of which of the two lands last, because the later
 * key is sent later.
 */
export async function enqueueCount(op: Extract<OutboxOp, { kind: 'count' }>): Promise<void> {
  const existing = (await readAll<Entry>(QUEUE)).find(
    (e) => e.op.kind === 'count' && e.op.id === op.id && e.key !== inFlightKey,
  )
  if (existing) {
    await put(QUEUE, {
      ...existing,
      op,
      tappedAt: Date.now(),
      // The superseding array has never been rejected, so it must not inherit
      // the backoff of the array it replaces.
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
    } satisfies Entry)
    await refresh()
    registerBackgroundSync()
    return
  }
  await enqueue(op)
}

/**
 * Undo for something that never left the device.
 *
 * If the event's `create` is still queued, the whole thing — and anything
 * queued against it — is simply dropped: there is nothing on the server to
 * delete, and sending a create followed by a delete would be a round trip to
 * achieve nothing. Returns true when it handled the deletion.
 */
export async function cancelPending(eventId: string): Promise<boolean> {
  const entries = await readAll<Entry>(QUEUE)
  const create = entries.find((e) => e.op.kind === 'create' && e.op.id === eventId)
  // An entry that is mid-flight may already have reached the server, so it is
  // never cancellable — that write has to be undone by a real DELETE.
  if (!create || create.key === inFlightKey) return false

  for (const entry of entries) {
    if (entry.op.id === eventId && entry.key !== inFlightKey) await remove(QUEUE, entry.key)
  }
  await refresh()
  return true
}

export async function dismissFailure(key: string): Promise<void> {
  await remove(FAILURES, key)
  await refresh()
}

export async function dismissAllFailures(): Promise<void> {
  for (const failure of snapshot.failures) await remove(FAILURES, failure.key)
  await refresh()
}

/* ------------------------------------------------------------- flushing -- */

/**
 * Backoff for transient failures. Starts fast, because the common case is a Pi
 * that rebooted and is seconds from answering, and tops out at five minutes so
 * a phone left offline overnight is not burning radio every second.
 */
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000, 300_000]

function backoffFor(attempts: number): number {
  const base = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] ?? 300_000
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

type Verdict =
  | { kind: 'ok'; event: Event | null }
  | { kind: 'transient'; code: string }
  | { kind: 'permanent'; code: string }

function send(op: OutboxOp): Promise<Event | null> {
  switch (op.kind) {
    case 'create':
      return api.createEvent({
        id: op.id,
        trackerId: op.trackerId,
        startAt: op.startAt,
        values: op.values,
        note: op.note ?? undefined,
      })
    case 'stop':
      return api.stopEvent(op.id, op.endAt)
    case 'count':
      return api.countEvent(op.id, op.ticks)
    case 'patch':
      return api.updateEvent(op.id, op.patch)
    case 'delete':
      return api.deleteEvent(op.id).then(() => null)
  }
}

/**
 * Which failures are worth retrying?
 *
 * Network errors and 5xx are the Pi being unreachable or unhappy — the exact
 * conditions this queue exists for, and they resolve on their own. 408 and 429
 * are explicit "try again" answers. Everything else in the 4xx range is a
 * statement about the request itself: it will fail identically forever, so
 * retrying it is a queue that never drains and a log the user is never told
 * about.
 */
function classify(op: OutboxOp, error: unknown): Verdict {
  if (!(error instanceof ApiError)) return { kind: 'transient', code: 'UNKNOWN' }

  const { status, code } = error
  if (status === 0 || status >= 500 || status === 408 || status === 429) {
    return { kind: 'transient', code }
  }

  // Replays of an operation that already landed. A stop that is answered
  // ALREADY_STOPPED did stop; a delete answered NOT_FOUND is deleted. Treating
  // these as failures would report a phantom loss for a write that succeeded.
  if (op.kind === 'stop' && (code === 'ALREADY_STOPPED' || status === 404)) {
    return { kind: 'ok', event: null }
  }
  if ((op.kind === 'delete' || op.kind === 'patch') && status === 404) {
    return { kind: 'ok', event: null }
  }

  // A count answered 404 is already handled: the create failed permanently and
  // `fail()` dropped every sibling queued against it, so this entry is the tail
  // of a write the user has already been told about. Reporting it again would
  // be one lost log announced twice.
  //
  // ALREADY_STOPPED on a count is the opposite, and is the reason this is not
  // written the way `stop` is: the tap did **not** land. The span closed at its
  // previous last tick and this one is gone. That is a real loss and belongs in
  // the failures list where the user can see it.
  if (op.kind === 'count' && status === 404) {
    return { kind: 'ok', event: null }
  }

  return { kind: 'permanent', code }
}

let flushing: Promise<void> | null = null
let flushAgain = false
let resetOnNextRun = false
let inFlightKey: string | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null

function scheduleRetry(delay: number): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    retryTimer = null
    void flush()
  }, Math.max(250, delay))
}

/** Reconcile the caches with a write that has now actually landed. */
function applied(op: OutboxOp, event: Event | null): void {
  const qc = queryClient
  if (!qc) return
  const runningKey = ['running', op.profileId]

  if (op.kind === 'create' && event) {
    qc.setQueryData<Event[]>(runningKey, (previous) => {
      if (!previous) return previous
      const rest = previous.filter((e) => e.id !== event.id)
      // A create replayed after its span was already stopped comes back with an
      // endAt — it is no longer running, and must not be re-pinned.
      if (event.type !== 'INTERVAL' || event.endAt !== null) return rest
      return [...rest, event].sort((a, b) => a.startAt - b.startAt)
    })
  }

  // The server is the authority on a counted span's ticks — it validates and
  // may clamp them — so its answer, not the optimistic array, is what the
  // running card ends up showing.
  if (op.kind === 'count' && event) {
    qc.setQueryData<Event[]>(runningKey, (previous) =>
      previous
        ? previous.map((e) => (e.id === event.id ? { ...e, ticks: event.ticks } : e))
        : previous,
    )
  }

  if (op.kind === 'stop' || op.kind === 'delete') {
    qc.setQueryData<Event[]>(runningKey, (previous) =>
      previous ? previous.filter((e) => e.id !== op.id) : previous,
    )
  }
}

async function fail(entry: Entry, code: string): Promise<void> {
  const failure: OutboxFailure = {
    key: entry.key,
    op: entry.op,
    code,
    failedAt: Date.now(),
  }
  await put(FAILURES, failure)
  await remove(QUEUE, entry.key)

  // Anything queued against an event whose create will never exist is doomed
  // too. Dropping it here is what stops one bad write from wedging the queue
  // behind a 404 that can never clear.
  if (entry.op.kind === 'create') {
    const rest = await readAll<Entry>(QUEUE)
    for (const other of rest) {
      if (other.op.id === entry.op.id) await remove(QUEUE, other.key)
    }
  }
}

async function run(resetBackoff: boolean): Promise<void> {
  setSnapshot({ syncing: true })
  let stalled = false

  try {
    // An explicit "the network is back" signal beats the backoff clock. Backoff
    // exists to stop a doomed retry loop hammering a Pi that is not answering;
    // it must not make a phone that just reconnected sit out the remaining five
    // minutes before writing anything.
    if (resetBackoff) {
      for (const entry of await readAll<Entry>(QUEUE)) {
        if (entry.nextAttemptAt > 0) await put(QUEUE, { ...entry, nextAttemptAt: 0 } satisfies Entry)
      }
    }

    for (;;) {
      const entries = (await readAll<Entry>(QUEUE)).sort((a, b) => (a.key < b.key ? -1 : 1))
      if (entries.length === 0) break

      const entry = entries[0]
      if (!entry) break

      const now = Date.now()
      if (entry.nextAttemptAt > now) {
        // Head of line is still in backoff. Nothing behind it may go first:
        // a stop must never overtake the create it depends on.
        stalled = true
        scheduleRetry(entry.nextAttemptAt - now)
        break
      }

      inFlightKey = entry.key
      let verdict: Verdict
      try {
        verdict = { kind: 'ok', event: await send(entry.op) }
      } catch (error) {
        verdict = classify(entry.op, error)
      } finally {
        inFlightKey = null
      }

      if (verdict.kind === 'ok') {
        await remove(QUEUE, entry.key)
        applied(entry.op, verdict.event)
        await refresh()
        continue
      }

      if (verdict.kind === 'permanent') {
        await fail(entry, verdict.code)
        await refresh()
        continue
      }

      const attempts = entry.attempts + 1
      await put(QUEUE, {
        ...entry,
        attempts,
        nextAttemptAt: Date.now() + backoffFor(attempts),
        lastError: verdict.code,
      } satisfies Entry)
      stalled = true
      scheduleRetry(backoffFor(attempts))
      break
    }
  } catch {
    // IndexedDB itself is unavailable. Retry rather than drop: the queue is the
    // only copy of these writes.
    stalled = true
    scheduleRetry(5_000)
  }

  await refresh().catch(() => undefined)
  setSnapshot({ syncing: false, stalled })

  // Only once the queue has fully drained is the server's answer the whole
  // truth. Invalidating earlier would refetch a list that is still missing the
  // writes behind it and wipe the optimistic rows off the screen.
  if (snapshot.pending === 0 && queryClient) {
    void queryClient.invalidateQueries({ queryKey: ['running'] })
    void queryClient.invalidateQueries({ queryKey: ['events'] })
  }
}

/**
 * Send everything that is waiting, in order. Safe to call from anywhere.
 *
 * `resetBackoff` is for the triggers that carry real information about the
 * network — reconnecting, the tab coming back, Background Sync waking us — as
 * opposed to the backoff timer simply coming round again.
 */
export function flush({ resetBackoff = false } = {}): Promise<void> {
  if (flushing) {
    // A flush already walking the queue will pick up whatever was just added,
    // unless it is past that point — so ask it to go round once more.
    flushAgain = true
    if (resetBackoff) resetOnNextRun = true
    return flushing
  }
  const current = run(resetBackoff).finally(() => {
    flushing = null
    if (flushAgain) {
      flushAgain = false
      const reset = resetOnNextRun
      resetOnNextRun = false
      void flush({ resetBackoff: reset })
    }
  })
  flushing = current
  return current
}

/* ---------------------------------------------------------------- wiring -- */

let installed = false

/**
 * Start the outbox. Flushes now, and on every signal that the network may have
 * come back: the `online` event, the tab becoming visible again, and the
 * service worker's Background Sync message.
 */
export function installOutbox(qc: QueryClient): void {
  queryClient = qc
  if (installed) return
  installed = true

  // Every one of these means something changed about the network, so each one
  // clears the backoff rather than waiting it out.
  const kick = (): void => {
    void flush({ resetBackoff: true })
  }

  window.addEventListener('online', kick)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick()
  })

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
      if ((event.data as { type?: string } | undefined)?.type === 'tickit:flush-outbox') kick()
    })
  }

  void refresh().then(kick)
  registerBackgroundSync()
}
