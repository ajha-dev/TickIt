import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'wouter'

import { ApiError } from '../api.ts'
import { EventRow } from '../components/EventRow.tsx'
import { EventSheet, type EventPatch } from '../components/EventSheet.tsx'
import { addDays, endOfDay, formatDayHeading, startOfDay } from '../lib/days.ts'
import { hapticUndo } from '../lib/haptics.ts'
import { useDeleteEvent, useEventRange, useRunning, useTrackers, useUpdateEvent } from '../lib/queries.ts'
import { formatDay } from '../lib/time.ts'
import type { Event, Profile, Tracker } from '../types.ts'

/**
 * How far before a day the query has to reach to catch a span that began
 * earlier and is still going when the day starts. Two days covers an overnight
 * plus a long nap either side of it; anything still open beyond that is a
 * *running* span, and those arrive separately from `/events/running` where no
 * lookback can miss them.
 *
 * Deliberately defined here rather than imported: this is the Timeline's own
 * assumption about its own query.
 */
const SPAN_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000

/**
 * The contract's ceiling. A single day plus a 48h lookback is never going to
 * reach it in a personal log — but "never going to" is not "cannot", and a
 * silently truncated day would be a day you could not correct. The guard stays.
 */
const LIMIT = 1000

export function TimelineScreen({ profile }: { profile: Profile }) {
  const profileId = profile.id

  // Which local day is on screen, held as its own midnight so every comparison
  // below is an equality rather than a range check.
  const [day, setDay] = useState(() => startOfDay(Date.now()))
  // Switching profile is switching context entirely — it should land on today,
  // not on whatever date the last profile was being read at.
  useEffect(() => setDay(startOfDay(Date.now())), [profileId])

  const dayStart = day
  const dayEnd = endOfDay(day)
  const today = startOfDay(Date.now())
  const isFuture = day > today

  const eventsQuery = useEventRange(
    profileId,
    dayStart - SPAN_LOOKBACK_MS,
    // The server's `to` is inclusive and filters on `startAt`, while `endOfDay`
    // is the *next* midnight. Without the -1 an event logged at exactly 00:00
    // would be claimed by both days.
    dayEnd - 1,
    LIMIT,
  )
  const runningQuery = useRunning(profileId)
  const trackersQuery = useTrackers(profileId)
  const updateEvent = useUpdateEvent(profileId)
  const deleteEvent = useDeleteEvent(profileId)

  const [editing, setEditing] = useState<Event | null>(null)
  const [error, setError] = useState<string | null>(null)

  const trackerById = useMemo(() => {
    const map = new Map<string, Tracker>()
    for (const t of trackersQuery.data ?? []) map.set(t.id, t)
    return map
  }, [trackersQuery.data])

  /**
   * Everything that happened *during* this local day, earliest first.
   *
   * Two things make this more than a filter on `startAt`. A span belongs to
   * every day it touches, not only the one it began on — an overnight feed is
   * part of both nights. And a long-running span may have started before the
   * query's lookback, so the running list is merged in and de-duplicated by id.
   *
   * Ascending, deliberately: a day is read forwards. The first feed of the
   * morning is where the story starts, and the gaps between rows only mean
   * anything when time runs down the page.
   */
  const events = useMemo(() => {
    const byId = new Map<string, Event>()
    for (const e of eventsQuery.data ?? []) byId.set(e.id, e)
    for (const e of runningQuery.data ?? []) byId.set(e.id, e)

    const now = Date.now()
    const out: Event[] = []
    for (const e of byId.values()) {
      if (e.startAt >= dayEnd) continue
      if (e.startAt >= dayStart) {
        out.push(e)
        continue
      }
      // Started before this day: it only belongs here if it was still open when
      // the day began. A running span is open until now, so it reaches every
      // day up to today and no further.
      if (e.type !== 'INTERVAL') continue
      const finishedAt = e.endAt ?? now
      if (finishedAt > dayStart) out.push(e)
    }
    return out.sort((a, b) => a.startAt - b.startAt)
  }, [eventsQuery.data, runningQuery.data, dayStart, dayEnd])

  const truncated = (eventsQuery.data?.length ?? 0) >= LIMIT

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
      <header className="pad-safe-top pad-safe-x pb-2">
        <h1 className="lockup text-[15px] font-semibold tracking-[-0.02em]">Timeline</h1>
        <p className="stencil mt-1.5">{profile.name}</p>
      </header>

      <DayPicker
        day={day}
        onChange={setDay}
        // There is nothing to page forward into: today is the last day that can
        // have happened. A future date is still reachable through the picker,
        // because an event can be logged ahead of itself.
        canGoForward={day < today}
        count={events.length}
        loading={eventsQuery.isFetching}
      />

      <main className="pad-safe-x pad-tabs flex-1 pt-3">
        {eventsQuery.isPending ? (
          <p className="stencil">loading</p>
        ) : eventsQuery.isError ? (
          <div className="rounded-tile hairline bg-ink-850 p-5">
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
        ) : events.length === 0 ? (
          <EmptyDay day={day} isFuture={isFuture} profileName={profile.name} />
        ) : (
          <>
            {truncated ? (
              <p className="mb-3 rounded-xl border border-ink-700 bg-ink-850 px-3.5 py-2.5 text-[13px] leading-snug text-text-dim">
                This day hit the {LIMIT}-entry ceiling. Some of it is not on this list.
              </p>
            ) : null}

            <div>
              {events.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  tracker={trackerById.get(event.trackerId)}
                  onOpen={() => openEvent(event)}
                  above={
                    event.startAt < dayStart
                      ? `started ${formatDayHeading(event.startAt).toLowerCase()}`
                      : undefined
                  }
                  below={
                    event.type === 'INTERVAL' && event.endAt === null
                      ? 'still running'
                      : event.endAt !== null && event.endAt >= dayEnd
                        ? `continues into ${dayWord(dayEnd)}`
                        : undefined
                  }
                />
              ))}
            </div>
          </>
        )}
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
 * The day this screen is showing, and the only way to change it.
 *
 * Arrows step a day at a time — the common move, one thumb, no aiming. The
 * label between them is itself the target for a native date picker, so a day
 * three months back is one tap away instead of ninety. The whole bar sticks to
 * the top: knowing *which* day you are reading matters as much on row forty as
 * on row one.
 */
function DayPicker({
  day,
  onChange,
  canGoForward,
  count,
  loading,
}: {
  day: number
  onChange: (next: number) => void
  canGoForward: boolean
  count: number
  loading: boolean
}) {
  const heading = formatDayHeading(day)
  const today = startOfDay(Date.now())
  // "Today" and "Yesterday" name a day without dating it, so those two get the
  // calendar date spelled out underneath. Every other heading already is one.
  const relative = day === today || day === addDays(today, -1)

  return (
    <div className="pad-safe-x sticky top-0 z-30 border-b border-ink-700 bg-ink-900/92 pb-2.5 backdrop-blur-md">
      <div className="flex items-center gap-2">
        <Arrow direction="back" onClick={() => onChange(addDays(day, -1))} />

        <div className="relative min-w-0 flex-1">
          <label className="tap flex h-12 w-full cursor-pointer flex-col items-center justify-center rounded-xl active:bg-ink-850">
            <span className="flex max-w-full items-center gap-1.5">
              <span className="truncate text-[17px] leading-tight font-semibold tracking-[-0.02em]">
                {heading}
              </span>
              {/* The only hint that the label is a target rather than a caption. */}
              <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 text-text-dim" fill="none" aria-hidden>
                <rect x="3.5" y="5" width="17" height="15.5" rx="3" stroke="currentColor" strokeWidth="1.7" />
                <path d="M3.5 10h17M8 3.5v3M16 3.5v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </span>
            {relative ? (
              <span className="stencil mt-1">{formatDay(day)}</span>
            ) : null}

            {/* The native picker, laid invisibly over its own label: the phone's
                own calendar, opened by tapping the date it is showing. */}
            <input
              type="date"
              aria-label="Show another day"
              value={toDateInput(day)}
              onChange={(e) => {
                const next = fromDateInput(e.target.value)
                if (next !== null) onChange(next)
              }}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
        </div>

        <Arrow direction="forward" onClick={() => onChange(addDays(day, 1))} disabled={!canGoForward} />
      </div>

      <p className="stencil mt-0.5 text-center">
        {loading ? 'loading' : count === 0 ? 'nothing logged' : `${count} ${count === 1 ? 'entry' : 'entries'}`}
      </p>
    </div>
  )
}

function Arrow({
  direction,
  onClick,
  disabled,
}: {
  direction: 'back' | 'forward'
  onClick: () => void
  disabled?: boolean
}) {
  const back = direction === 'back'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={back ? 'Previous day' : 'Next day'}
      // Disabled keeps its box: the bar should not go lopsided the moment it
      // lands on today, and a greyed control still reads as "not now" rather
      // than "gone".
      className="tap flex size-12 shrink-0 items-center justify-center rounded-xl border border-ink-700 bg-ink-850 text-text-dim active:bg-ink-800 disabled:opacity-30"
    >
      <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
        <path
          d={back ? 'M14.5 5.5L8 12l6.5 6.5' : 'M9.5 5.5L16 12l-6.5 6.5'}
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

/**
 * An empty day is two different things. A past one is a day nothing happened
 * on — normal, and worth being able to leave quickly. A future one has not
 * happened yet, and saying "nothing logged" about it would read as data loss.
 */
function EmptyDay({
  day,
  isFuture,
  profileName,
}: {
  day: number
  isFuture: boolean
  profileName: string
}) {
  if (isFuture) {
    return (
      <div className="rounded-tile hairline bg-ink-850 p-5">
        <p className="stencil">not yet</p>
        <p className="mt-2.5 text-[19px] leading-snug tracking-[-0.02em] text-balance">
          {formatDay(day)} hasn’t happened yet.
        </p>
        <p className="mt-2.5 text-[15px] leading-snug text-text-dim">
          Nothing is missing — this day is simply ahead of the clock. Anything logged for it will
          appear here.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-tile hairline bg-ink-850 p-5">
      <p className="stencil">nothing on this day</p>
      <p className="mt-2.5 text-[19px] leading-snug tracking-[-0.02em] text-balance">
        {profileName} has no entries for {formatDay(day)}.
      </p>
      <p className="mt-2.5 text-[15px] leading-snug text-text-dim">
        Step back a day with the arrow, or pick a date from the calendar above.
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
 * A day named the way a sentence would name it. `formatDayHeading` covers
 * "Today" and "Yesterday" because those are the only two a *log* looks back
 * at; a span running off the bottom of a day points forwards instead, so
 * "tomorrow" is added here rather than in `lib/days.ts`, which nothing else
 * needs it in.
 */
function dayWord(ms: number): string {
  const today = startOfDay(Date.now())
  if (startOfDay(ms) === addDays(today, 1)) return 'tomorrow'
  return formatDayHeading(ms).toLowerCase()
}

/* ------------------------------------------------- local date ⇄ midnight -- */

/**
 * `<input type="date">` speaks `YYYY-MM-DD` and nothing else. Both directions
 * go through the `Date` constructor's local-time semantics — the same bridge
 * the edit sheet uses — so the value the picker shows is the day the rest of
 * the screen is resolving, in the device's zone, with no offset arithmetic.
 */
function toDateInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fromDateInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const [year, month, dayOfMonth] = match.slice(1).map(Number) as [number, number, number]
  const d = new Date(year, month - 1, dayOfMonth, 0, 0, 0, 0)
  // The constructor rolls 31 February into March rather than refusing it.
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== dayOfMonth) {
    return null
  }
  return d.getTime()
}
