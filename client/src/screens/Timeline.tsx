import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'wouter'

import { ApiError } from '../api.ts'
import { EventRow } from '../components/EventRow.tsx'
import { EventSheet, type EventPatch } from '../components/EventSheet.tsx'
import { addDays, formatDayHeading, startOfDay } from '../lib/days.ts'
import { hapticUndo } from '../lib/haptics.ts'
import { useDeleteEvent, useEventWindow, useTrackers, useUpdateEvent } from '../lib/queries.ts'
import type { Event, Profile, Tracker } from '../types.ts'

/** A fortnight is what "recently" means for a log you check daily. */
const INITIAL_DAYS = 14
/** Each "load older" reaches back a month further. */
const STEP_DAYS = 30
/** The contract's ceiling. Hitting it is reported, never hidden. */
const LIMIT = 1000

interface DayGroup {
  day: number
  events: Event[]
}

export function TimelineScreen({ profile }: { profile: Profile }) {
  const profileId = profile.id

  const [windowDays, setWindowDays] = useState(INITIAL_DAYS)
  // Reaching further back is per-profile: switching context should not inherit
  // the last one's depth.
  useEffect(() => setWindowDays(INITIAL_DAYS), [profileId])

  const from = useMemo(
    () => startOfDay(addDays(Date.now(), -(windowDays - 1))),
    [windowDays],
  )

  const eventsQuery = useEventWindow(profileId, from, LIMIT)
  const trackersQuery = useTrackers(profileId)
  const updateEvent = useUpdateEvent(profileId)
  const deleteEvent = useDeleteEvent(profileId)

  const [editing, setEditing] = useState<Event | null>(null)
  const [error, setError] = useState<string | null>(null)

  const events = useMemo(() => eventsQuery.data ?? [], [eventsQuery.data])

  const trackerById = useMemo(() => {
    const map = new Map<string, Tracker>()
    for (const t of trackersQuery.data ?? []) map.set(t.id, t)
    return map
  }, [trackersQuery.data])

  /**
   * The server already sorts `startAt DESC`, so grouping is a single pass with
   * no re-sorting. The boundary comes from `lib/days.ts` and therefore from the
   * device's zone: an event at 00:20 belongs to the day it felt like, not to
   * whichever UTC date it happens to carry.
   */
  const groups = useMemo(() => {
    const out: DayGroup[] = []
    for (const event of events) {
      const day = startOfDay(event.startAt)
      const last = out[out.length - 1]
      if (last && last.day === day) last.events.push(event)
      else out.push({ day, events: [event] })
    }
    return out
  }, [events])

  const truncated = events.length >= LIMIT

  const openEvent = useCallback((event: Event) => {
    setError(null)
    setEditing(event)
  }, [])

  const closeSheet = useCallback(() => {
    setError(null)
    setEditing(null)
  }, [])

  const onSave = useCallback(
    (patch: EventPatch) => {
      if (!editing) return
      setError(null)
      updateEvent.mutate(
        { id: editing.id, patch },
        {
          onSuccess: () => setEditing(null),
          onError: (e) => setError(e instanceof ApiError ? e.code : 'UNKNOWN'),
        },
      )
    },
    [editing, updateEvent],
  )

  const onDelete = useCallback(() => {
    if (!editing) return
    hapticUndo()
    deleteEvent.mutate(editing.id)
    setEditing(null)
  }, [editing, deleteEvent])

  return (
    <div className="relative z-10 flex min-h-dvh flex-col">
      <header className="pad-safe-top pad-safe-x pb-3">
        <h1 className="lockup text-[15px] font-semibold tracking-[-0.02em]">Timeline</h1>
        <p className="stencil mt-1.5">
          {profile.name}
          {events.length > 0 ? ` · ${events.length} logged` : ''}
        </p>
      </header>

      <main className="pad-safe-x pad-tabs flex-1">
        {eventsQuery.isPending ? (
          <p className="stencil mt-4">loading</p>
        ) : eventsQuery.isError ? (
          <div className="rounded-tile hairline mt-2 bg-ink-850 p-5">
            <p className="stencil">offline</p>
            <p className="mt-2 text-[17px] leading-snug">
              Can’t reach the server, so nothing can be shown or corrected yet.
            </p>
            <button
              type="button"
              onClick={() => void eventsQuery.refetch()}
              className="tap mt-4 h-12 w-full rounded-xl border border-ink-600 bg-ink-800 text-[15px]"
            >
              Try again
            </button>
          </div>
        ) : groups.length === 0 ? (
          <EmptyWindow profileName={profile.name} windowDays={windowDays} />
        ) : (
          <>
            {truncated ? (
              <p className="mb-3 rounded-xl border border-ink-700 bg-ink-850 px-3.5 py-2.5 text-[13px] leading-snug text-text-dim">
                Only the {LIMIT} most recent entries in this range are shown — the
                oldest of them are not on this list.
              </p>
            ) : null}

            {groups.map((group) => (
              <section key={group.day} aria-label={formatDayHeading(group.day)}>
                {/* Sticky so the day you are reading names itself the whole way
                    down its own group, instead of scrolling off at the first row. */}
                <h2 className="sticky top-0 z-20 -mx-4 flex items-baseline justify-between gap-3 bg-ink-900/92 px-4 pt-3 pb-2 backdrop-blur-md">
                  <span className="text-[15px] leading-none font-semibold tracking-[-0.02em]">
                    {formatDayHeading(group.day)}
                  </span>
                  <span className="stencil">
                    {group.events.length} {group.events.length === 1 ? 'entry' : 'entries'}
                  </span>
                </h2>

                <div className="pb-1">
                  {group.events.map((event) => (
                    <EventRow
                      key={event.id}
                      event={event}
                      tracker={trackerById.get(event.trackerId)}
                      onOpen={() => openEvent(event)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}

        {!eventsQuery.isPending && !eventsQuery.isError ? (
          <Older
            from={from}
            loading={eventsQuery.isFetching}
            onLoad={() => setWindowDays((d) => d + STEP_DAYS)}
          />
        ) : null}
      </main>

      {editing ? (
        <EventSheet
          event={editing}
          tracker={trackerById.get(editing.trackerId)}
          onSave={onSave}
          onDelete={onDelete}
          onClose={closeSheet}
          saving={updateEvent.isPending}
          error={error}
        />
      ) : null}
    </div>
  )
}

/**
 * The window is empty. That is two different situations — nothing has ever been
 * logged, or nothing was logged lately — and the useful thing to say differs,
 * so both the way to log and the way to look further back are offered.
 */
function EmptyWindow({ profileName, windowDays }: { profileName: string; windowDays: number }) {
  return (
    <div className="rounded-tile hairline mt-2 bg-ink-850 p-5">
      <p className="stencil">nothing in the last {windowDays} days</p>
      <p className="mt-2.5 text-[19px] leading-snug tracking-[-0.02em] text-balance">
        Every tap on Home lands here. This is where “the feed actually started at 3:40” gets
        fixed.
      </p>
      <p className="mt-2.5 text-[15px] leading-snug text-text-dim">
        {profileName} has nothing logged in this window. Log something, or reach further back.
      </p>
      <Link
        href="/"
        className="tap mt-5 flex h-[60px] w-full items-center justify-center rounded-2xl bg-periwinkle text-[17px] font-semibold text-ink-900"
      >
        Go and log something
      </Link>
    </div>
  )
}

/**
 * History is never silently truncated: the list always ends by naming the exact
 * day it currently reaches back to, and always offers to go further.
 *
 * There is deliberately no "that's everything" state. A widened window that
 * returns nothing new only proves that *that* window is empty — an event can be
 * backdated to any instant, so "nothing exists before this" is not something
 * the contract can be asked. Stating the reach is true; guessing at the end of
 * history would not be.
 */
function Older({ from, loading, onLoad }: { from: number; loading: boolean; onLoad: () => void }) {
  return (
    <div className="mt-6 flex flex-col items-center gap-2.5 pb-2">
      <p className="stencil text-center">back to {formatDayHeading(from).toLowerCase()}</p>
      <button
        type="button"
        onClick={onLoad}
        disabled={loading}
        className="tap h-12 w-full max-w-[240px] rounded-xl border border-ink-700 bg-ink-850 text-[15px] text-text-dim active:bg-ink-800 disabled:opacity-50"
      >
        {loading ? 'Loading…' : `Load ${STEP_DAYS} days older`}
      </button>
    </div>
  )
}
