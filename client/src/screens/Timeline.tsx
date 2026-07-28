import { useCallback, useEffect, useMemo, useState } from 'react'

import { ApiError } from '../api.ts'
import { EventRow } from '../components/EventRow.tsx'
import { DayPickerSheet } from '../components/DayPickerSheet.tsx'
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
  const [pickingDay, setPickingDay] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * Whether archived trackers' events are on screen. Deliberately component
   * state and nothing more: a switch that hides part of the log and then
   * silently remembers itself across sessions is how you end up mistrusting the
   * log. Leaving the screen puts it back to hidden, which is the state the
   * count in the header always describes.
   */
  const [showArchived, setShowArchived] = useState(false)
  // Switching profile is a different set of trackers and a different set of
  // archives; carrying the reveal across would be answering a question nobody
  // asked in this context.
  useEffect(() => setShowArchived(false), [profileId])

  const trackerById = useMemo(() => {
    const map = new Map<string, Tracker>()
    for (const t of trackersQuery.data ?? []) map.set(t.id, t)
    return map
  }, [trackersQuery.data])

  /**
   * Everything that happened *during* this local day, newest first.
   *
   * Two things make this more than a filter on `startAt`. A span belongs to
   * every day it touches, not only the one it began on — an overnight feed is
   * part of both nights. And a long-running span may have started before the
   * query's lookback, so the running list is merged in and de-duplicated by id.
   *
   * Descending: the most recent entry is the one being checked or corrected, so
   * it belongs at the top where the thumb already is, without scrolling a full
   * day to reach it. A carried-over span from the previous night therefore
   * sorts to the bottom, which is where it happened.
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
    return out.sort((a, b) => b.startAt - a.startAt)
  }, [eventsQuery.data, runningQuery.data, dayStart, dayEnd])

  /**
   * Archiving a tracker is a statement that it is done with, and the Log grid
   * already honours it. The Timeline honours it too — otherwise a tracker you
   * deliberately put away goes on filling the screen it was put away from.
   *
   * An event whose tracker is *missing* is not the same thing and is not
   * hidden: deletion cascades its events away, so an unknown tracker id here
   * means the tracker list has not loaded yet, and hiding rows on that basis
   * would make the day flicker.
   */
  const isArchived = useCallback(
    (event: Event) => trackerById.get(event.trackerId)?.archivedAt != null,
    [trackerById],
  )

  const archivedCount = useMemo(() => events.filter(isArchived).length, [events, isArchived])

  /**
   * Revealed events keep their place in the day rather than collecting at the
   * bottom: the point of a timeline is when things happened, and a set-aside
   * tracker still happened at the time it happened. Dimming, not position, is
   * what says "archived".
   */
  const shown = useMemo(
    () => (showArchived ? events : events.filter((e) => !isArchived(e))),
    [events, showArchived, isArchived],
  )

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
        count={shown.length}
        archivedCount={archivedCount}
        archivedShown={showArchived}
        loading={eventsQuery.isFetching}
        onOpenCalendar={() => setPickingDay(true)}
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
        ) : shown.length === 0 ? (
          <EmptyDay
            day={day}
            isFuture={isFuture}
            profileName={profile.name}
            archivedCount={archivedCount}
            onShowArchived={() => setShowArchived(true)}
          />
        ) : (
          <>
            {truncated ? (
              <p className="mb-3 rounded-xl border border-ink-700 bg-ink-850 px-3.5 py-2.5 text-[13px] leading-snug text-text-dim">
                This day hit the {LIMIT}-entry ceiling. Some of it is not on this list.
              </p>
            ) : null}

            <div>
              {shown.map((event) => {
                const archived = isArchived(event)
                const row = (
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
                )
                // Dimmed, not restyled: it is the same row, read as set aside.
                // The group label is what carries that to a screen reader,
                // which cannot see opacity.
                return archived ? (
                  <div key={event.id} role="group" aria-label="Archived tracker" className="opacity-45">
                    {row}
                  </div>
                ) : (
                  row
                )
              })}
            </div>

            {archivedCount > 0 ? (
              <ArchivedToggle
                count={archivedCount}
                shown={showArchived}
                onToggle={() => setShowArchived((v) => !v)}
              />
            ) : null}
          </>
        )}
      </main>

      <DayPickerSheet
        open={pickingDay}
        day={day}
        profileId={profileId}
        onPick={setDay}
        onClose={() => setPickingDay(false)}
      />

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
  archivedCount,
  archivedShown,
  loading,
  onOpenCalendar,
}: {
  day: number
  onChange: (next: number) => void
  canGoForward: boolean
  /** How many rows are on screen — never how many exist. */
  count: number
  /** How many of the day's entries belong to archived trackers. */
  archivedCount: number
  archivedShown: boolean
  loading: boolean
  onOpenCalendar: () => void
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
          <button
            type="button"
            onClick={onOpenCalendar}
            aria-label="Show another day"
            className="tap flex h-12 w-full flex-col items-center justify-center rounded-xl active:bg-ink-850"
          >
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
            {relative ? <span className="stencil mt-1">{formatDay(day)}</span> : null}
          </button>
        </div>

        <Arrow direction="forward" onClick={() => onChange(addDays(day, 1))} disabled={!canGoForward} />
      </div>

      {/* The count describes the *list*, never a total the list disagrees with.
          When entries are being held back it says how many, so a short day is
          never mistaken for a lost one. */}
      <p className="stencil mt-0.5 text-center">
        {loading
          ? 'loading'
          : count === 0
            ? archivedCount === 0
              ? 'nothing logged'
              : `nothing shown · ${archivedCount} archived`
            : `${count} ${count === 1 ? 'entry' : 'entries'}${
                archivedCount === 0
                  ? ''
                  : archivedShown
                    ? ` · incl. ${archivedCount} archived`
                    : ` · ${archivedCount} archived`
              }`}
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
 * The one control for archived rows, and deliberately the quietest thing under
 * the list: it is not an action on the log, it is a statement about how much of
 * it you are looking at. Sits below the rows so it never comes between two
 * entries, and names the number so the offer is specific.
 */
function ArchivedToggle({
  count,
  shown,
  onToggle,
}: {
  count: number
  shown: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={shown}
      className="tap mt-2 mb-1 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-ink-700/70 text-[13px] text-text-dim active:bg-ink-850"
    >
      <svg viewBox="0 0 24 24" className="size-3.5 shrink-0" fill="none" aria-hidden>
        <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.6" stroke="currentColor" strokeWidth="1.7" />
        <path d="M5.5 9v8.5a2 2 0 002 2h9a2 2 0 002-2V9M10 13h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
      {shown ? `Hide ${count} archived` : `Show ${count} archived`}
    </button>
  )
}

/**
 * An empty day is three different things. A past one is a day nothing happened
 * on — normal, and worth being able to leave quickly. A future one has not
 * happened yet, and saying "nothing logged" about it would read as data loss.
 * And a day whose every entry belongs to an archived tracker is not empty at
 * all: the list is empty because of a choice made here, and the copy has to say
 * so rather than claim the day was blank.
 */
function EmptyDay({
  day,
  isFuture,
  profileName,
  archivedCount,
  onShowArchived,
}: {
  day: number
  isFuture: boolean
  profileName: string
  archivedCount: number
  onShowArchived: () => void
}) {
  if (archivedCount > 0) {
    return (
      <div className="rounded-tile hairline bg-ink-850 p-5">
        <p className="stencil">all archived</p>
        <p className="mt-2.5 text-[19px] leading-snug tracking-[-0.02em] text-balance">
          {archivedCount === 1 ? 'The one entry' : `All ${archivedCount} entries`} on {formatDay(day)}{' '}
          {archivedCount === 1 ? 'belongs' : 'belong'} to archived trackers.
        </p>
        <p className="mt-2.5 text-[15px] leading-snug text-text-dim">
          Nothing has been lost — the day is hidden, not blank.
        </p>
        <button
          type="button"
          onClick={onShowArchived}
          className="tap mt-4 h-12 w-full rounded-xl border border-ink-600 bg-ink-800 text-[15px]"
        >
          Show {archivedCount} archived
        </button>
      </div>
    )
  }

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
