import { useCallback, useMemo, useState } from 'react'
import { Link } from 'wouter'

import { isAlreadyRunning } from '../api.ts'
import { CaptureSheet } from '../components/CaptureSheet.tsx'
import { RunningCard } from '../components/RunningCard.tsx'
import { Sheet, SheetButton } from '../components/Sheet.tsx'
import { TrackerTile } from '../components/TrackerTile.tsx'
import { UndoToast, type ToastState } from '../components/UndoToast.tsx'
import { safeColour } from '../lib/colours.ts'
import { hapticLog, hapticStop, hapticUndo } from '../lib/haptics.ts'
import {
  isOptimistic,
  useCaptureValues,
  useDeleteEvent,
  useLogMoment,
  useRunning,
  useStartSpan,
  useStopSpan,
  useTrackers,
} from '../lib/queries.ts'
import { formatClock } from '../lib/time.ts'
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
  const deleteEvent = useDeleteEvent(profileId)
  const captureValues = useCaptureValues(profileId)

  const [toast, setToast] = useState<ToastState | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [capture, setCapture] = useState<Capture | null>(null)
  const [switching, setSwitching] = useState(false)

  const trackers = useMemo(
    () => (trackersQuery.data ?? []).filter((t) => t.archivedAt === null),
    [trackersQuery.data],
  )
  const running = runningQuery.data ?? []

  const trackerById = useMemo(() => {
    const map = new Map<string, Tracker>()
    for (const t of trackersQuery.data ?? []) map.set(t.id, t)
    return map
  }, [trackersQuery.data])

  const runningTrackerIds = useMemo(() => new Set(running.map((e) => e.trackerId)), [running])

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
              ? { ...current, eventId: event.id, clock: formatClock(event.startAt) }
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
    [logMoment, startTracker, offerCapture],
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

  return (
    <div className="relative z-10 flex min-h-dvh flex-col">
      <header className="pad-safe-top pad-safe-x flex items-start justify-between gap-3 pb-2">
        <div>
          <p className="lockup text-[15px] leading-none font-semibold tracking-[-0.02em]">TickIt</p>
          <p className="stencil mt-1.5">
            {running.length > 0 ? `${running.length} running` : 'ready'}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setSwitching(true)}
          aria-label={`Profile: ${profile.name}. Switch profile`}
          className="tap -mt-1.5 -mr-1 flex h-11 max-w-[58%] items-center gap-2 rounded-full border border-ink-700 bg-ink-850 pr-3 pl-3.5 active:bg-ink-800"
        >
          <span
            aria-hidden
            className="size-2.5 shrink-0 rounded-full"
            style={{
              background: safeColour(profile.colour),
              boxShadow: `0 0 10px ${safeColour(profile.colour)}`,
            }}
          />
          <span className="truncate text-[15px] font-medium tracking-[-0.01em]">{profile.name}</span>
          <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 text-text-dim" fill="none" aria-hidden>
            <path
              d="M7 10l5 5 5-5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
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
                pending={isOptimistic(event)}
                onStop={() => onStop(event.id)}
              />
            ))}
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
        ) : trackers.length === 0 ? (
          <div className="rounded-tile hairline bg-ink-850 p-5">
            <p className="stencil">no trackers in {profile.name}</p>
            <p className="mt-2.5 text-[19px] leading-snug tracking-[-0.02em] text-balance">
              TickIt ships with no opinions. Describe the first thing worth logging.
            </p>
            <Link
              href="/trackers"
              className="tap mt-5 flex h-[60px] w-full items-center justify-center rounded-2xl bg-periwinkle text-[17px] font-semibold text-ink-900"
            >
              Create a tracker
            </Link>
          </div>
        ) : (
          <section aria-label="Trackers" className="grid grid-cols-2 gap-3">
            {trackers.map((tracker) => (
              <TrackerTile
                key={tracker.id}
                tracker={tracker}
                running={runningTrackerIds.has(tracker.id)}
                onTap={() => onTapTracker(tracker)}
              />
            ))}
          </section>
        )}
      </main>

      {toast ? <UndoToast toast={toast} onUndo={onUndo} onDismiss={dismissToast} /> : null}

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
          saving={captureValues.isPending}
          onSave={onSaveCapture}
          onClose={() => setCapture(null)}
        />
      ) : null}
    </div>
  )
}
