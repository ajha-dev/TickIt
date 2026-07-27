import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'

import * as api from '../api.ts'
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

const OPTIMISTIC_PREFIX = 'optimistic:'

export function isOptimistic(event: Event): boolean {
  return event.id.startsWith(OPTIMISTIC_PREFIX)
}

function optimisticEvent(tracker: Tracker, startAt: number): Event {
  return {
    id: `${OPTIMISTIC_PREFIX}${tracker.id}:${startAt}`,
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
 * Logs a Moment. Nothing on Home renders a Moment, so the "optimism" here is
 * the toast and the haptic, which fire before the request resolves.
 */
export function useLogMoment(profileId: string): UseMutationResult<Event, Error, Tracker> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (tracker) => api.createEvent({ trackerId: tracker.id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.events(profileId) })
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
    mutationFn: ({ eventId, values }) => api.updateEvent(eventId, { values }),
    onSuccess: (event) => {
      const key = keys.running(profileId)
      const previous = qc.getQueryData<Event[]>(key)
      if (previous) {
        qc.setQueryData<Event[]>(
          key,
          previous.map((e) => (e.id === event.id ? event : e)),
        )
      }
      void qc.invalidateQueries({ queryKey: keys.events(profileId) })
    },
  })
}

/** Starts a Span. The pinned card appears before the server has answered. */
export function useStartSpan(profileId: string): UseMutationResult<Event, Error, Tracker> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (tracker) => api.createEvent({ trackerId: tracker.id }),
    onMutate: async (tracker): Promise<RunningContext> => {
      const key = keys.running(profileId)
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<Event[]>(key)
      qc.setQueryData<Event[]>(key, [...(previous ?? []), optimisticEvent(tracker, Date.now())])
      return { previous }
    },
    onError: (_err, _tracker, ctx) => {
      if (ctx) qc.setQueryData(keys.running(profileId), ctx.previous)
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.running(profileId) })
    },
  })
}

/** Stops a Span. The card leaves the pinned area on tap. */
export function useStopSpan(profileId: string): UseMutationResult<Event, Error, string> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (eventId) => api.stopEvent(eventId),
    onMutate: async (eventId): Promise<RunningContext> => {
      const key = keys.running(profileId)
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<Event[]>(key)
      qc.setQueryData<Event[]>(key, (previous ?? []).filter((e) => e.id !== eventId))
      return { previous }
    },
    onError: (_err, _eventId, ctx) => {
      if (ctx) qc.setQueryData(keys.running(profileId), ctx.previous)
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.running(profileId) })
    },
  })
}

/** Undo, and the Timeline's delete: hard-deletes the event. There is no undo. */
export function useDeleteEvent(profileId: string): UseMutationResult<void, Error, string> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (eventId) => api.deleteEvent(eventId),
    onMutate: async (eventId): Promise<RunningContext> => {
      const key = keys.running(profileId)
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<Event[]>(key)
      qc.setQueryData<Event[]>(key, (previous ?? []).filter((e) => e.id !== eventId))
      return { previous }
    },
    onError: (_err, _eventId, ctx) => {
      if (ctx) qc.setQueryData(keys.running(profileId), ctx.previous)
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.running(profileId) })
      void qc.invalidateQueries({ queryKey: keys.events(profileId) })
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
    mutationFn: ({ id, patch }) => api.updateEvent(id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.events(profileId) })
      void qc.invalidateQueries({ queryKey: keys.running(profileId) })
    },
  })
}
