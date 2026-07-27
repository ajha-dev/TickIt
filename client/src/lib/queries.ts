import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'

import * as api from '../api.ts'
import { AlreadyRunningError } from '../api.ts'
import { cancelPending, enqueue, flush, uuidv7 } from './outbox.ts'
import type { Event, FieldDefInput, Profile, Tracker, TrackerType } from '../types.ts'

export const keys = {
  profiles: ['profiles'] as const,
  trackers: (profileId: string) => ['trackers', profileId] as const,
  running: (profileId: string) => ['running', profileId] as const,
  events: (profileId: string) => ['events', profileId] as const,
}

/* -------------------------------------------------------------- profiles -- */

/** Every profile, archived ones included — the client decides what to hide. */
export function useProfiles(): UseQueryResult<Profile[]> {
  return useQuery({
    queryKey: keys.profiles,
    queryFn: api.listProfiles,
    staleTime: 5 * 60_000,
  })
}

export function useCreateProfile(): UseMutationResult<
  Profile,
  Error,
  { name: string; colour?: string }
> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input) => api.createProfile(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.profiles })
    },
  })
}

export function useUpdateProfile(): UseMutationResult<
  Profile,
  Error,
  { id: string; patch: { name?: string; colour?: string; archivedAt?: number | null } }
> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }) => api.updateProfile(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: keys.profiles })
      const previous = qc.getQueryData<Profile[]>(keys.profiles)
      if (previous) {
        qc.setQueryData<Profile[]>(
          keys.profiles,
          previous.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        )
      }
      return { previous }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(keys.profiles, ctx.previous)
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.profiles })
    },
  })
}

/** A real delete: the profile's trackers and every event under them go with it. */
export function useDeleteProfile(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id) => api.deleteProfile(id),
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: keys.profiles })
      qc.removeQueries({ queryKey: keys.trackers(id) })
      qc.removeQueries({ queryKey: keys.running(id) })
      qc.removeQueries({ queryKey: keys.events(id) })
    },
  })
}

/* -------------------------------------------------------------- trackers -- */

export function useTrackers(profileId: string | undefined): UseQueryResult<Tracker[]> {
  return useQuery({
    queryKey: keys.trackers(profileId ?? ''),
    queryFn: () => api.listTrackers(profileId as string),
    enabled: Boolean(profileId),
    staleTime: 30_000,
  })
}

export function useCreateTracker(
  profileId: string,
): UseMutationResult<
  Tracker,
  Error,
  { name: string; type: TrackerType; colour?: string; fields?: FieldDefInput[] }
> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input) => api.createTracker({ profileId, ...input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.trackers(profileId) })
    },
  })
}

export function useUpdateTracker(
  profileId: string,
): UseMutationResult<
  Tracker,
  Error,
  {
    id: string
    patch: {
      name?: string
      colour?: string
      archivedAt?: number | null
      fields?: FieldDefInput[]
    }
  }
> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }) => api.updateTracker(id, patch),
    onMutate: async ({ id, patch }) => {
      const key = keys.trackers(profileId)
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<Tracker[]>(key)
      if (previous) {
        // `fields` is deliberately left out of the optimistic merge: new fields
        // have no id until the server mints one, and rendering an id-less field
        // would break every lookup keyed on it. Fields settle on the refetch.
        const { fields: _fields, ...rest } = patch
        qc.setQueryData<Tracker[]>(
          key,
          previous.map((t) => (t.id === id ? { ...t, ...rest } : t)),
        )
      }
      return { previous }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(keys.trackers(profileId), ctx.previous)
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.trackers(profileId) })
    },
  })
}

export function useDeleteTracker(profileId: string): UseMutationResult<void, Error, string> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id) => api.deleteTracker(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.trackers(profileId) })
      void qc.invalidateQueries({ queryKey: keys.running(profileId) })
    },
  })
}

/* --------------------------------------------------------------- events -- */

export function useRunning(profileId: string | undefined): UseQueryResult<Event[]> {
  return useQuery({
    queryKey: keys.running(profileId ?? ''),
    queryFn: () => api.listRunning(profileId as string),
    enabled: Boolean(profileId),
    // Cheap, and it keeps a second device in sync while a span is open.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })
}


/**
 * The event exactly as it will exist on the server, built at tap time.
 *
 * `startAt` is *now* — the moment of the tap — and the outbox never recomputes
 * it. A feed logged at 03:12 with no signal must land as 03:12, not as whenever
 * the phone next found the network.
 */
function localEvent(tracker: Tracker, id: string, startAt: number): Event {
  return {
    id,
    trackerId: tracker.id,
    profileId: tracker.profileId,
    type: tracker.type,
    startAt,
    endAt: null,
    values: {},
    note: null,
    createdAt: startAt,
    updatedAt: startAt,
  }
}

interface RunningContext {
  previous: Event[] | undefined
}

/**
 * Apply a local change to every cached slice of the timeline for this profile.
 *
 * The Timeline's queries are keyed `['events', profileId, from, to, limit]`, so
 * the key itself says whether a newly logged event belongs in that slice. This
 * is what makes an offline log show up in history rather than only in the
 * running strip.
 */
function patchEventCaches(
  qc: ReturnType<typeof useQueryClient>,
  profileId: string,
  change:
    | { kind: 'insert'; event: Event }
    | { kind: 'remove'; id: string }
    | { kind: 'merge'; id: string; patch: Partial<Event> },
): void {
  for (const query of qc.getQueryCache().findAll({ queryKey: keys.events(profileId) })) {
    const rows = query.state.data as Event[] | undefined
    if (!Array.isArray(rows)) continue

    if (change.kind === 'remove') {
      qc.setQueryData<Event[]>(
        query.queryKey,
        rows.filter((e) => e.id !== change.id),
      )
      continue
    }

    if (change.kind === 'merge') {
      qc.setQueryData<Event[]>(
        query.queryKey,
        rows.map((e) => (e.id === change.id ? { ...e, ...change.patch } : e)),
      )
      continue
    }

    const [, , from, to, limit] = query.queryKey as [string, string, number?, number?, number?]
    const { startAt } = change.event
    if (typeof from === 'number' && startAt < from) continue
    if (typeof to === 'number' && startAt > to) continue

    const next = [...rows.filter((e) => e.id !== change.event.id), change.event].sort(
      (a, b) => b.startAt - a.startAt,
    )
    qc.setQueryData<Event[]>(query.queryKey, typeof limit === 'number' ? next.slice(0, limit) : next)
  }
}

/**
 * The event as it now reads on this device, for a mutation that has only been
 * queued. Callers get a real `Event` back exactly as they did when the request
 * was synchronous, so nothing downstream has to know about the queue.
 *
 * `updatedAt` is bumped here for the same reason the server bumps it: an
 * edited event carries its "edited" marker straight away rather than acquiring
 * it minutes later when the queue drains.
 */
function mergeLocally(
  qc: ReturnType<typeof useQueryClient>,
  profileId: string,
  eventId: string,
  patch: Partial<Event>,
): Event {
  const now = Date.now()
  const pools = [
    qc.getQueryData<Event[]>(keys.running(profileId)) ?? [],
    ...qc
      .getQueryCache()
      .findAll({ queryKey: keys.events(profileId) })
      .map((q) => (Array.isArray(q.state.data) ? (q.state.data as Event[]) : [])),
  ]
  for (const pool of pools) {
    const found = pool.find((e) => e.id === eventId)
    if (found) return { ...found, ...patch, updatedAt: now }
  }
  // Nothing cached for it — the queue still carries the truth, so answer with
  // the least the caller can use rather than failing the mutation.
  return {
    id: eventId,
    trackerId: '',
    profileId,
    type: 'INSTANT',
    startAt: now,
    endAt: null,
    values: {},
    note: null,
    createdAt: now,
    ...patch,
    updatedAt: now,
  }
}

/**
 * Logs a Moment.
 *
 * The write is durable in IndexedDB before this resolves, so the tap succeeds
 * with no network at all and the undo toast gets a real event id immediately
 * rather than waiting on the Pi. The send is a background detail from here.
 */
export function useLogMoment(profileId: string): UseMutationResult<Event, Error, Tracker> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (tracker) => {
      const startAt = Date.now()
      const event = localEvent(tracker, uuidv7(), startAt)
      await enqueue(
        {
          kind: 'create',
          id: event.id,
          profileId: tracker.profileId,
          label: tracker.name,
          trackerId: tracker.id,
          type: tracker.type,
          startAt,
          values: {},
          note: null,
        },
        startAt,
      )
      void flush()
      return event
    },
    onSuccess: (event) => {
      patchEventCaches(qc, profileId, { kind: 'insert', event })
    },
  })
}

/**
 * Adds captured values to an event that is *already logged*.
 *
 * This is the second half of the capture flow and never the first: the event
 * exists before this hook is ever called, so a failure here loses the values,
 * not the log.
 */
export function useCaptureValues(
  profileId: string,
): UseMutationResult<
  Event,
  Error,
  { eventId: string; values: Record<string, string | number | boolean> }
> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ eventId, values }) => {
      await enqueue({ kind: 'patch', id: eventId, profileId, label: 'Values', patch: { values } })
      void flush()
      return mergeLocally(qc, profileId, eventId, { values })
    },
    onSuccess: (event) => {
      const key = keys.running(profileId)
      const previous = qc.getQueryData<Event[]>(key)
      if (previous) {
        qc.setQueryData<Event[]>(
          key,
          previous.map((e) => (e.id === event.id ? event : e)),
        )
      }
      patchEventCaches(qc, profileId, { kind: 'merge', id: event.id, patch: { values: event.values } })
    },
  })
}

/**
 * Starts a Span. The pinned card appears immediately — with or without a
 * network, because the event is durable in IndexedDB before this resolves.
 *
 * The "already running" check happens locally against the running list rather
 * than waiting for the server's 409, so the stop-first prompt still appears
 * offline. A 409 from the server (another device started it) is a permanent
 * failure and is surfaced by the outbox instead.
 */
export function useStartSpan(profileId: string): UseMutationResult<Event, Error, Tracker> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (tracker) => {
      const key = keys.running(profileId)
      const previous = qc.getQueryData<Event[]>(key) ?? []
      const clash = previous.find((e) => e.trackerId === tracker.id && e.endAt === null)
      if (clash) throw new AlreadyRunningError(clash.id)

      const startAt = Date.now()
      const event = localEvent(tracker, uuidv7(), startAt)
      // Pinned before the write is even durable: the queue write is a
      // millisecond of IndexedDB, and rolled back below if it somehow fails.
      qc.setQueryData<Event[]>(key, [...previous, event])
      try {
        await enqueue(
          {
            kind: 'create',
            id: event.id,
            profileId: tracker.profileId,
            label: tracker.name,
            trackerId: tracker.id,
            type: tracker.type,
            startAt,
            values: {},
            note: null,
          },
          startAt,
        )
      } catch (error) {
        qc.setQueryData<Event[]>(key, previous)
        throw error
      }
      void flush()
      return event
    },
    onSuccess: (event) => {
      patchEventCaches(qc, profileId, { kind: 'insert', event })
    },
  })
}

/** Stops a Span. The card leaves the pinned area on tap. */
export function useStopSpan(profileId: string): UseMutationResult<Event | null, Error, string> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (eventId) => {
      // The moment of the tap, not the moment of sync — a span that ended at
      // 03:40 must not be recorded as ending when the phone reconnected.
      const endAt = Date.now()
      const existing = (qc.getQueryData<Event[]>(keys.running(profileId)) ?? []).find(
        (e) => e.id === eventId,
      )
      await enqueue({ kind: 'stop', id: eventId, profileId, label: 'Stop', endAt }, endAt)
      void flush()
      return existing ? { ...existing, endAt } : null
    },
    onMutate: (eventId): RunningContext => {
      const key = keys.running(profileId)
      const previous = qc.getQueryData<Event[]>(key)
      qc.setQueryData<Event[]>(key, (previous ?? []).filter((e) => e.id !== eventId))
      return { previous }
    },
    onError: (_err, _eventId, ctx) => {
      if (ctx) qc.setQueryData(keys.running(profileId), ctx.previous)
    },
    onSuccess: (event) => {
      if (event) patchEventCaches(qc, profileId, { kind: 'merge', id: event.id, patch: { endAt: event.endAt } })
    },
  })
}

/**
 * Undo, and the Timeline's delete: hard-deletes the event. There is no undo.
 *
 * An event whose create is still queued is dropped from the queue outright
 * rather than being created and then deleted — undoing a log the Pi has never
 * heard of should cost nothing.
 */
export function useDeleteEvent(profileId: string): UseMutationResult<void, Error, string> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (eventId) => {
      if (await cancelPending(eventId)) return
      await enqueue({ kind: 'delete', id: eventId, profileId, label: 'Delete' })
      void flush()
    },
    onMutate: (eventId): RunningContext => {
      const key = keys.running(profileId)
      const previous = qc.getQueryData<Event[]>(key)
      qc.setQueryData<Event[]>(key, (previous ?? []).filter((e) => e.id !== eventId))
      patchEventCaches(qc, profileId, { kind: 'remove', id: eventId })
      return { previous }
    },
    onError: (_err, _eventId, ctx) => {
      if (ctx) qc.setQueryData(keys.running(profileId), ctx.previous)
    },
  })
}

/* ------------------------------------------------------------- timeline -- */

/**
 * One bounded slice of history: `from <= startAt <= to`, newest first, straight
 * from the server's own ordering.
 *
 * Both bounds are part of the key, so stepping to another day is a new query
 * rather than a mutation of an existing one — but the key still *starts* with
 * `keys.events(profileId)`, so every existing invalidation of that prefix
 * refreshes whichever day is on screen.
 *
 * The server filters on `startAt` alone and its `to` is inclusive, so a caller
 * asking for a single day passes `endOfDay(day) - 1` and widens `from` by
 * however far back a span may have begun. Both of those are day arithmetic and
 * both belong to the caller; this hook only fetches what it is given.
 */
export function useEventRange(
  profileId: string | undefined,
  from: number,
  to: number,
  limit: number,
): UseQueryResult<Event[]> {
  return useQuery({
    queryKey: [...keys.events(profileId ?? ''), from, to, limit],
    queryFn: () => api.listEvents({ profileId: profileId as string, from, to, limit }),
    enabled: Boolean(profileId),
    staleTime: 15_000,
    // The day already on screen stays there while the next one loads, so
    // arrowing through dates never flashes an empty list between them.
    placeholderData: (previous) => previous,
  })
}

/**
 * Corrects a logged event: its times, its captured value, its note.
 *
 * Unlike `useCaptureValues` this is an admitted edit — the server bumps
 * `updatedAt`, and the row grows its "edited" marker. That is the entire audit
 * story (PLAN.md), so the marker must never be suppressed here.
 */
export function useUpdateEvent(
  profileId: string,
): UseMutationResult<
  Event,
  Error,
  {
    id: string
    patch: {
      startAt?: number
      /** Never send this for an INSTANT — the server answers 400 NOT_AN_INTERVAL. */
      endAt?: number | null
      values?: Record<string, string | number | boolean>
      note?: string | null
    }
  }
> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, patch }) => {
      await enqueue({ kind: 'patch', id, profileId, label: 'Edit', patch })
      void flush()
      return mergeLocally(qc, profileId, id, patch as Partial<Event>)
    },
    onSuccess: (event) => {
      patchEventCaches(qc, profileId, { kind: 'merge', id: event.id, patch: event })
      const key = keys.running(profileId)
      const previous = qc.getQueryData<Event[]>(key)
      if (previous) {
        qc.setQueryData<Event[]>(
          key,
          // An edit that gives a running span an end time takes it off the
          // pinned strip, exactly as stopping it would.
          previous
            .map((e) => (e.id === event.id ? event : e))
            .filter((e) => e.type !== 'INTERVAL' || e.endAt === null),
        )
      }
    },
  })
}
