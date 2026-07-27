import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'

import * as api from '../api.ts'
import type { Event, Profile, Tracker, TrackerType } from '../types.ts'

export const keys = {
  profiles: ['profiles'] as const,
  trackers: (profileId: string) => ['trackers', profileId] as const,
  running: (profileId: string) => ['running', profileId] as const,
}

/* -------------------------------------------------------------- profiles -- */

/**
 * Phase 1 has exactly one profile — the seeded default. We still read it from
 * the server rather than hardcoding an id, so Phase 3 only has to add a picker.
 */
export function useDefaultProfile(): UseQueryResult<Profile | null> {
  return useQuery({
    queryKey: keys.profiles,
    queryFn: api.listProfiles,
    select: (profiles: Profile[]): Profile | null =>
      profiles.find((p) => p.archivedAt === null) ?? profiles[0] ?? null,
    staleTime: 5 * 60_000,
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
): UseMutationResult<Tracker, Error, { name: string; type: TrackerType; colour?: string }> {
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
  { id: string; patch: { name?: string; colour?: string; archivedAt?: number | null } }
> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }) => api.updateTracker(id, patch),
    onMutate: async ({ id, patch }) => {
      const key = keys.trackers(profileId)
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<Tracker[]>(key)
      if (previous) {
        qc.setQueryData<Tracker[]>(
          key,
          previous.map((t) => (t.id === id ? { ...t, ...patch } : t)),
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
      void qc.invalidateQueries({ queryKey: ['events', profileId] })
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

/** Undo: hard-deletes the event that was just created. */
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
    },
  })
}
