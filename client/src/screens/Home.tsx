import { useCallback, useMemo, useState } from 'react'
import { Link } from 'wouter'

import { isAlreadyRunning } from '../api.ts'
import { CaptureSheet } from '../components/CaptureSheet.tsx'
import { RunningCard } from '../components/RunningCard.tsx'
import { Sheet, SheetButton } from '../components/Sheet.tsx'
import { TrackerSheets, type TrackerSheetState } from '../components/TrackerSheets.tsx'
import { TrackerTile } from '../components/TrackerTile.tsx'
import { UndoToast, type ToastState } from '../components/UndoToast.tsx'
import { safeColour } from '../lib/colours.ts'
import { useGridReorder } from '../lib/gridReorder.ts'
import { hapticLog, hapticStop, hapticUndo } from '../lib/haptics.ts'
import { isPending, useOutbox } from '../lib/outbox.ts'
import {
  useCaptureValues,
  useCountSpan,
  useDeleteEvent,
  useLogMoment,
  useRunning,
  useStartSpan,
  useStopSpan,
  useTrackers,
} from '../lib/queries.ts'
import { formatClock } from '../lib/time.ts'
import { useReorderTrackers } from '../lib/trackerOrder.ts'
import type { Event, Profile, Tracker } from '../types.ts'

interface Conflict {
  tracker: Tracker
  eventId: string
}

/** An event that exists on the server, with a sheet open over it. */
interface Capture {
  tracker: Tracker
  event: Event
}

/**
 * The Log screen, and the only screen that matters.
 *
 * It has two modes, and the separation between them is the whole point:
 *
 * - **Normal.** A tile is a log target. One tap logs. Nothing intercepts,
 *   delays or arbitrates that tap — PLAN's first principle, unchanged.
 * - **Edit** (the pencil). A tile is a thing to manage: tapping opens its
 *   drawer, a grip appears for reordering, and archived trackers surface at the
 *   bottom so there is a route back from archiving one.
 *
 * Managing trackers used to be its own tab. Folding it in here means the grid
 * you arrange is literally the grid you log from, rather than a list that
 * claims to be it.
 */
export function Home({
  profile,
  profiles,
  onSelectProfile,
}: {
  profile: Profile
  profiles: Profile[]
  onSelectProfile: (id: string) => void
}) {
  const profileId = profile.id

  const trackersQuery = useTrackers(profileId)
  const runningQuery = useRunning(profileId)

  const logMoment = useLogMoment(profileId)
  const startSpan = useStartSpan(profileId)
  const stopSpan = useStopSpan(profileId)
  const countSpan = useCountSpan(profileId)
  const deleteEvent = useDeleteEvent(profileId)
  const captureValues = useCaptureValues(profileId)

  const [toast, setToast] = useState<ToastState | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [capture, setCapture] = useState<Capture | null>(null)
  const [switching, setSwitching] = useState(false)
  const [editing, setEditing] = useState(false)
  const [sheet, setSheet] = useState<TrackerSheetState>(null)

  const all = useMemo(() => trackersQuery.data ?? [], [trackersQuery.data])
  const trackers = useMemo(() => all.filter((t) => t.archivedAt === null), [all])
  const archived = useMemo(() => all.filter((t) => t.archivedAt !== null), [all])

  const trackerById = useMemo(() => {
    const map = new Map<string, Tracker>()
    for (const t of all) map.set(t.id, t)
    return map
  }, [all])

  /**
   * What is running, from both places it can be known.
   *
   * The server's list is the authority for anything that reached the Pi. A span
   * started with no signal reached nothing, so it lives only in the outbox
   * queue — and the optimistic pin the mutation made died when the app was
   * closed. Merging the queue's reconstruction back in is what keeps the card
   * on screen across a restart instead of silently dropping a session that is
   * still being timed.
   *
   * Deduped by id, which is safe precisely because the id is minted on this
   * device and is the id the server stores: the moment the create lands, the
   * server's row and the queued one are the same event, not two.
   */
  const { queuedRunning } = useOutbox()
  const running = useMemo(() => {
    const server = runningQuery.data ?? []
    const known = new Set(server.map((e) => e.id))
    const extra = queuedRunning.filter((e) => e.profileId === profileId && !known.has(e.id))
    if (extra.length === 0) return server
    return [...server, ...extra]
      .map((e) =>
        // A counted span rebuilt from a queue holding no `count` op yet has no
        // ticks — but it was born holding its opening tap, and only the tracker
        // says so. Without this the card would render as a plain stopwatch and
        // lose the count it is actually keeping.
        e.ticks === null && trackerById.get(e.trackerId)?.counter
          ? { ...e, ticks: [e.startAt] }
          : e,
      )
      .sort((a, b) => a.startAt - b.startAt)
  }, [runningQuery.data, queuedRunning, profileId, trackerById])

  /**
   * The answer is not in yet — no cached list, no queued span, still fetching.
   *
   * This is its own state and must not render as "nothing is running". On a
   * cold start over a tailnet the fetch is visibly slow, and an empty strip
   * under a header saying `ready` is indistinguishable from a span that has
   * vanished. Once anything is known — cache, queue, or answer — it is gone.
   */
  const checkingRunning = runningQuery.isPending && running.length === 0

  const runningTrackerIds = useMemo(() => new Set(running.map((e) => e.trackerId)), [running])

  /**
   * Reorder writes the same `sortOrder` the server sorts on, so the grid you
   * arrange here *is* the order every other view sees. Armed only in edit mode.
   */
  const reorderTrackers = useReorderTrackers(profileId)
  const trackerIds = useMemo(() => trackers.map((t) => t.id), [trackers])
  const grid = useGridReorder(trackerIds, reorderTrackers, editing)

  const dismissToast = useCallback(() => setToast(null), [])

  /** Opens the capture sheet — but only ever *after* the event is on the server. */
  const offerCapture = useCallback((tracker: Tracker, event: Event) => {
    if ((tracker.fields?.length ?? 0) === 0) return
    setCapture({ tracker, event })
  }, [])

  const startTracker = useCallback(
    (tracker: Tracker) => {
      startSpan.mutate(tracker, {
        onSuccess: (event) => offerCapture(tracker, event),
        onError: (error) => {
          if (isAlreadyRunning(error)) {
            setConflict({ tracker, eventId: error.eventId })
          }
        },
      })
    },
    [startSpan, offerCapture],
  )

  const onTapTracker = useCallback(
    (tracker: Tracker) => {
      // In edit mode a tile is not a log target. Nothing below this line runs.
      if (editing) {
        setSheet({ kind: 'actions', tracker })
        return
      }

      hapticLog()

      if (tracker.type === 'INTERVAL') {
        startTracker(tracker)
        return
      }

      // Moment: the toast is up before the request leaves the device. The tap
      // logs; fields, if any, are offered only once the server has answered.
      const key = Date.now()
      setToast({
        key,
        trackerName: tracker.name,
        colour: safeColour(tracker.colour),
        clock: formatClock(key),
        eventId: null,
        fields: tracker.fields,
      })

      logMoment.mutate(tracker, {
        onSuccess: (event) => {
          setToast((current) =>
            current && current.key === key
              ? {
                  ...current,
                  eventId: event.id,
                  clock: formatClock(event.startAt),
                }
              : current,
          )
          offerCapture(tracker, event)
        },
        onError: () => {
          setToast((current) =>
            current && current.key === key ? { ...current, failed: true } : current,
          )
        },
      })
    },
    [editing, logMoment, startTracker, offerCapture],
  )

  const onSaveCapture = useCallback(
    (values: Record<string, string | number | boolean>) => {
      if (!capture) return
      const { event } = capture
      captureValues.mutate(
        { eventId: event.id, values },
        {
          onSuccess: (saved) => {
            setCapture(null)
            // If the undo toast for this event is still on screen, let it show
            // what was just captured rather than going quietly stale.
            setToast((current) =>
              current && current.eventId === saved.id
                ? { ...current, values: saved.values }
                : current,
            )
          },
        },
      )
    },
    [capture, captureValues],
  )

  const onUndo = useCallback(() => {
    const eventId = toast?.eventId
    if (!eventId) return
    hapticUndo()
    setToast(null)
    setCapture((current) => (current?.event.id === eventId ? null : current))
    deleteEvent.mutate(eventId)
  }, [toast, deleteEvent])

  const onStop = useCallback(
    (eventId: string) => {
      hapticStop()
      stopSpan.mutate(eventId)
    },
    [stopSpan],
  )

  const onCount = useCallback(
    (event: Event, ticks: number[]) => {
      countSpan.mutate({
        eventId: event.id,
        ticks,
        label: trackerById.get(event.trackerId)?.name ?? 'Count',
      })
    },
    [countSpan, trackerById],
  )

  const resolveConflict = useCallback(
    (restart: boolean) => {
      if (!conflict) return
      const { tracker, eventId } = conflict
      setConflict(null)
      hapticStop()
      stopSpan.mutate(eventId, {
        onSuccess: () => {
          if (restart) startTracker(tracker)
        },
      })
    },
    [conflict, stopSpan, startTracker],
  )

  const openCreate = () => setSheet({ kind: 'form', tracker: null })

  const toggleEditing = () => {
    // Leaving edit mode must not leave a drawer behind it.
    if (editing) setSheet(null)
    setEditing((e) => !e)
  }

  /**
   * The header never claims `ready` before it knows. `ready` is a statement
   * that nothing is running, and until the running query has answered that is
   * a claim the screen cannot make.
   */
  const status = editing
    ? 'edit mode'
    : running.length > 0
      ? `${running.length} running`
      : checkingRunning
        ? 'checking'
        : runningQuery.isError
          ? 'running spans unknown'
          : 'ready'

  return (
    <div className="relative z-10 flex min-h-dvh flex-col">
      {/* Profile on the left, the two management controls on the right. The
          left column is `min-w-0 flex-1` and the chip truncates inside it, so a
          long profile name can never push the pencil or the plus off-screen. */}
      <header className="pad-safe-top pad-safe-x flex items-start justify-between gap-2 pb-2">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setSwitching(true)}
            aria-label={`Profile: ${profile.name}. Switch profile`}
            className="tap -ml-1 flex h-11 max-w-full items-center gap-2 rounded-full border border-ink-700 bg-ink-850 pr-3 pl-3.5 active:bg-ink-800"
          >
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full"
              style={{
                background: safeColour(profile.colour),
                boxShadow: `0 0 10px ${safeColour(profile.colour)}`,
              }}
            />
            <span className="truncate text-[15px] font-medium tracking-[-0.01em]">
              {profile.name}
            </span>
            <svg
              viewBox="0 0 24 24"
              className="size-3.5 shrink-0 text-text-dim"
              fill="none"
              aria-hidden
            >
              <path
                d="M7 10l5 5 5-5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <p className={`stencil mt-2 ml-0.5 ${editing ? 'text-mauve' : ''}`}>{status}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={toggleEditing}
            disabled={all.length === 0}
            aria-pressed={editing}
            aria-label={editing ? 'Done editing trackers' : 'Edit trackers'}
            className={`tap flex size-11 items-center justify-center rounded-full border disabled:opacity-30 ${
              editing
                ? 'border-mauve/60 bg-mauve/18 text-mauve'
                : 'border-ink-700 bg-ink-850 text-text-dim active:bg-ink-800'
            }`}
          >
            <svg viewBox="0 0 24 24" className="size-[19px]" fill="none" aria-hidden>
              <path
                d="M14.8 5.4l3.8 3.8M4.5 19.5l4.6-.9 9.2-9.2-3.7-3.7-9.2 9.2-.9 4.6z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          <button
            type="button"
            onClick={openCreate}
            aria-label="New tracker"
            className="tap flex size-11 items-center justify-center rounded-full border border-periwinkle/45 bg-periwinkle/15 text-periwinkle active:bg-periwinkle/25"
          >
            <svg viewBox="0 0 24 24" className="size-[21px]" fill="none" aria-hidden>
              <path
                d="M12 5.6v12.8M5.6 12h12.8"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </header>

      {/* Content is bottom-anchored so the tiles sit in the thumb arc — but
          `pad-tabs` keeps the lowest row a clear 30px above the tab bar, which
          is the whole reason the original design had no nav bar at all. */}
      <main className="pad-safe-x pad-tabs flex flex-1 flex-col justify-end gap-3 pt-2">
        {running.length > 0 ? (
          <section aria-label="Running" className="flex flex-col gap-2.5">
            {running.map((event) => (
              <RunningCard
                key={event.id}
                event={event}
                tracker={trackerById.get(event.trackerId)}
                pending={isPending(event.id)}
                onCount={(ticks) => onCount(event, ticks)}
                onStop={() => onStop(event.id)}
              />
            ))}
          </section>
        ) : checkingRunning ? (
          /* Not a decorative skeleton: it says, in words, that the question is
             still open. An empty strip during the fetch must not look like an
             empty strip after it. */
          <section
            aria-label="Checking for running spans"
            aria-busy="true"
            className="anim-fade flex min-h-[76px] items-center gap-2.5 rounded-tile border border-ink-700 bg-ink-850 px-5 py-4"
          >
            <span aria-hidden className="anim-pulse size-[7px] shrink-0 rounded-full bg-lavender" />
            <p className="stencil">checking for a running span</p>
          </section>
        ) : null}

        {trackersQuery.isPending ? (
          <div className="grid grid-cols-2 gap-3" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="anim-fade min-h-[132px] rounded-tile border border-ink-700 bg-ink-850"
                style={{ animationDelay: `${i * 60}ms` }}
              />
            ))}
          </div>
        ) : trackersQuery.isError ? (
          <div className="rounded-tile hairline bg-ink-850 p-5">
            <p className="stencil">offline</p>
            <p className="mt-2 text-[17px] leading-snug">
              Can’t reach the server. Nothing was logged.
            </p>
            <button
              type="button"
              onClick={() => void trackersQuery.refetch()}
              className="tap mt-4 h-12 w-full rounded-xl border border-ink-600 bg-ink-800 text-[15px]"
            >
              Try again
            </button>
          </div>
        ) : all.length === 0 ? (
          <div className="rounded-tile hairline bg-ink-850 p-5">
            <p className="stencil">no trackers in {profile.name}</p>
            <p className="mt-2.5 text-[19px] leading-snug tracking-[-0.02em] text-balance">
              TickIt ships with no opinions. Describe the first thing worth logging.
            </p>
            <button
              type="button"
              onClick={openCreate}
              className="tap mt-5 flex h-[60px] w-full items-center justify-center rounded-2xl bg-periwinkle text-[17px] font-semibold text-ink-900 active:bg-wisteria"
            >
              Create a tracker
            </button>
          </div>
        ) : (
          <>
            {/* Every tracker in this profile is archived. Without this the Log
                screen would be blank with nothing to explain it, and the way
                back would be a pencil nobody had a reason to press. */}
            {trackers.length === 0 && !editing ? (
              <div className="rounded-tile hairline bg-ink-850 p-5">
                <p className="stencil">everything here is archived</p>
                <p className="mt-2.5 text-[19px] leading-snug tracking-[-0.02em] text-balance">
                  Nothing is showing on the log. Archived trackers keep every event they ever
                  had — bring one back, or start something new.
                </p>
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="tap mt-5 flex h-[60px] w-full items-center justify-center rounded-2xl border border-mauve/55 bg-mauve/12 text-[17px] font-semibold"
                >
                  Show the archived ones
                </button>
              </div>
            ) : null}

            {trackers.length > 0 ? (
              <section
                ref={grid.containerRef}
                aria-label="Trackers"
                className="grid grid-cols-2 gap-3"
              >
                {trackers.map((tracker, index) => (
                  // The wrapper is what gets dragged; `grid` makes it stretch
                  // the tile to the cell so a row stays level while a
                  // neighbour moves under it.
                  <div
                    key={tracker.id}
                    className={`relative grid rounded-tile ${editing ? 'ring-1 ring-mauve/35' : ''}`}
                    {...grid.itemProps(index)}
                  >
                    <TrackerTile
                      tracker={tracker}
                      running={runningTrackerIds.has(tracker.id)}
                      onTap={() => onTapTracker(tracker)}
                      label={editing ? `Edit ${tracker.name}` : undefined}
                    />

                    {editing && trackers.length > 1 ? (
                      <button
                        type="button"
                        aria-label={`Reorder ${tracker.name}. Position ${index + 1} of ${trackers.length}. Drag, or press the arrow keys.`}
                        className="absolute top-1.5 right-1.5 flex size-10 items-center justify-center rounded-xl border border-ink-600 bg-ink-800/85 text-text-dim backdrop-blur-sm active:bg-ink-700"
                        {...grid.handleProps(index)}
                      >
                        <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" aria-hidden>
                          <path
                            d="M5 9h14M5 15h14"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    ) : null}
                  </div>
                ))}
              </section>
            ) : null}

            {editing ? (
              <p className="stencil text-center">tap a tile to change it · drag to reorder</p>
            ) : null}

            {/* Archiving a tracker hides it from the grid. This is the way
                back — without it, folding the Trackers screen away would
                strand every archived tracker with no route to restore it. */}
            {editing && archived.length > 0 ? (
              <section aria-label="Archived trackers" className="mt-2">
                <p className="stencil mb-2.5">archived · hidden from the log</p>
                <div className="grid grid-cols-2 gap-3">
                  {archived.map((tracker) => (
                    <div
                      key={tracker.id}
                      role="group"
                      aria-label={`Archived: ${tracker.name}`}
                      className="grid rounded-tile opacity-45"
                    >
                      <TrackerTile
                        tracker={tracker}
                        running={false}
                        onTap={() => setSheet({ kind: 'actions', tracker })}
                        label={`Archived: ${tracker.name}. Open options`}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}
      </main>

      {toast ? <UndoToast toast={toast} onUndo={onUndo} onDismiss={dismissToast} /> : null}

      {/* Create, edit, reminder, archive and the counted delete confirm — the
          same sheets, from the one place that manages a tracker. */}
      <TrackerSheets profileId={profileId} trackers={all} state={sheet} onState={setSheet} />

      {/* ------------------------------------------------- profile switcher -- */}
      <Sheet
        open={switching}
        onClose={() => setSwitching(false)}
        eyebrow="profile"
        title="What are you logging?"
        body="Profiles are fully independent — separate trackers, separate events, nothing shared."
      >
        {profiles.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => {
              onSelectProfile(candidate.id)
              setSwitching(false)
            }}
            aria-current={candidate.id === profile.id ? 'true' : undefined}
            className={`tap flex h-[60px] w-full items-center gap-3 rounded-2xl border px-4 text-left text-[17px] ${
              candidate.id === profile.id
                ? 'border-mauve/55 bg-mauve/10'
                : 'border-ink-600 bg-ink-700'
            }`}
          >
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full"
              style={{ background: safeColour(candidate.colour) }}
            />
            <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
            {candidate.id === profile.id ? <span className="stencil">showing</span> : null}
          </button>
        ))}

        <Link
          href="/profiles"
          onClick={() => setSwitching(false)}
          className="tap flex h-[60px] w-full items-center justify-center rounded-2xl border border-ink-600 bg-ink-700 text-[17px] text-text-dim"
        >
          Manage profiles
        </Link>
      </Sheet>

      {/* The only modal in the logging path. */}
      <Sheet
        open={conflict !== null}
        onClose={() => setConflict(null)}
        eyebrow="already running"
        title={`${conflict?.tracker.name ?? ''} is already running`}
        body="A tracker can only have one open span at a time. Stop the current one first."
      >
        <SheetButton tone="primary" onClick={() => resolveConflict(true)}>
          Stop it and start a new one
        </SheetButton>
        <SheetButton tone="quiet" onClick={() => resolveConflict(false)}>
          Just stop it
        </SheetButton>
        <SheetButton tone="quiet" onClick={() => setConflict(null)}>
          Leave it running
        </SheetButton>
      </Sheet>

      {/* Opens over an event that is already saved. Dismissing it changes
          nothing about the log. */}
      {capture ? (
        <CaptureSheet
          tracker={capture.tracker}
          event={capture.event}
          onSave={onSaveCapture}
          onClose={() => setCapture(null)}
        />
      ) : null}
    </div>
  )
}
