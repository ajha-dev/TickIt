/**
 * A bounded window of events, for the charts that need one.
 *
 * The Timeline reaches backwards from a start with no upper bound; the
 * Dashboard needs a *closed* range, and needs it to be complete. Two things
 * make that harder than it looks, and both are handled here:
 *
 * - **The endpoint filters on `startAt`.** A Span that began the night before
 *   the window and ended inside it never matches, so the request reaches back
 *   `SPAN_LOOKBACK_MS` and the caller clips what comes out.
 * - **A running Span has no end at all.** One started a week before the window
 *   is still on screen today, and no lookback bounds it, so the running list is
 *   merged in separately and de-duplicated by id.
 *
 * The query key starts with `['events', profileId, …]`, matching
 * `lib/queries.ts`, so every existing invalidation of that prefix refreshes
 * these ranges too.
 */

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { listEvents } from '../api.ts'
import { useRunning } from './queries.ts'
import type { Event } from '../types.ts'

/** The contract's ceiling. Asking for it is how we find out we hit it. */
export const EVENT_LIMIT = 1000

export interface EventWindow {
  events: Event[]
  isPending: boolean
  isError: boolean
  refetch: () => void
  /** The window returned exactly the cap, so the oldest events were dropped. */
  capped: boolean
}

export function useEventRange(
  profileId: string,
  from: number,
  to: number,
  enabled = true,
): EventWindow {
  const events = useQuery({
    queryKey: ['events', profileId, 'range', from, to],
    queryFn: () => listEvents({ profileId, from, to, limit: EVENT_LIMIT }),
    enabled: enabled && Boolean(profileId),
    staleTime: 30_000,
    // A range already fetched stays on screen while a wider one loads, so
    // widening the chart never blanks the picture being read.
    placeholderData: (previous) => previous,
  })
  const running = useRunning(profileId)

  return useMemo(() => {
    const merged = new Map<string, Event>()
    for (const event of events.data ?? []) merged.set(event.id, event)
    for (const event of running.data ?? []) merged.set(event.id, event)

    return {
      events: [...merged.values()],
      isPending: events.isPending,
      isError: events.isError,
      refetch: () => void events.refetch(),
      capped: (events.data?.length ?? 0) >= EVENT_LIMIT,
    }
  }, [events.data, events.isPending, events.isError, events.refetch, running.data])
}
