import { useCallback, useMemo, useState } from 'react'
import { Link } from 'wouter'

import { isAlreadyRunning } from '../api.ts'
import { RunningCard } from '../components/RunningCard.tsx'
import { Sheet, SheetButton } from '../components/Sheet.tsx'
import { TrackerTile } from '../components/TrackerTile.tsx'
import { UndoToast, type ToastState } from '../components/UndoToast.tsx'
import { safeColour } from '../lib/colours.ts'
import { hapticLog, hapticStop, hapticUndo } from '../lib/haptics.ts'
import {
  isOptimistic,
  useDeleteEvent,
  useLogMoment,
  useRunning,
  useStartSpan,
  useStopSpan,
  useTrackers,
} from '../lib/queries.ts'
import { formatClock } from '../lib/time.ts'
import type { Tracker } from '../types.ts'

interface Conflict {
  tracker: Tracker
  eventId: string
}

export function Home({ profileId }: { profileId: string }) {
  const trackersQuery = useTrackers(profileId)
  const runningQuery = useRunning(profileId)

  const logMoment = useLogMoment(profileId)
  const startSpan = useStartSpan(profileId)
  const stopSpan = useStopSpan(profileId)
  const deleteEvent = useDeleteEvent(profileId)

  const [toast, setToast] = useState<ToastState | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)

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

  const runningTrackerIds = useMemo(
    () => new Set(running.map((e) => e.trackerId)),
    [running],
  )

  const dismissToast = useCallback(() => setToast(null), [])

  const startTracker = useCallback(
    (tracker: Tracker) => {
      startSpan.mutate(tracker, {
        onError: (error) => {
          if (isAlreadyRunning(error)) {
            setConflict({ tracker, eventId: error.eventId })
          }
        },
      })
    },
    [startSpan],
  )

  const onTapTracker = useCallback(
    (tracker: Tracker) => {
      hapticLog()

      if (tracker.type === 'INTERVAL') {
        startTracker(tracker)
        return
      }

      // Moment: the toast is up before the request leaves the device.
      const key = Date.now()
      setToast({
        key,
        trackerName: tracker.name,
        colour: safeColour(tracker.colour),
        clock: formatClock(key),
        eventId: null,
      })

      logMoment.mutate(tracker, {
        onSuccess: (event) => {
          setToast((current) =>
            current && current.key === key
              ? { ...current, eventId: event.id, clock: formatClock(event.startAt) }
              : current,
          )
        },
        onError: () => {
          setToast((current) =>
            current && current.key === key ? { ...current, failed: true } : current,
          )
        },
      })
    },
    [logMoment, startTracker],
  )

  const onUndo = useCallback(() => {
    const eventId = toast?.eventId
    if (!eventId) return
    hapticUndo()
    setToast(null)
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
      <header className="pad-safe-top pad-safe-x flex items-start justify-between pb-2">
        <div>
          <p className="text-[15px] leading-none font-semibold tracking-[-0.02em]">TickIt</p>
          <p className="stencil mt-1.5">
            {running.length > 0 ? `${running.length} running` : 'ready'}
          </p>
        </div>

        {/* Deliberately top-right: navigation must not compete for the thumb. */}
        <Link
          href="/trackers"
          aria-label="Manage trackers"
          className="tap -mr-2 -mt-1 flex size-11 items-center justify-center rounded-full text-bone-dim active:bg-white/5"
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
            <path
              d="M4 7h16M4 12h16M4 17h9"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </Link>
      </header>

      {/* Content is bottom-anchored: with three trackers, all three sit in the
          thumb arc rather than stranded under the status bar. */}
      <main className="pad-safe-x pad-safe-bottom flex flex-1 flex-col justify-end gap-3 pt-2">
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
                className="anim-fade min-h-[132px] rounded-tile border border-white/5 bg-ink-900"
                style={{ animationDelay: `${i * 60}ms` }}
              />
            ))}
          </div>
        ) : trackersQuery.isError ? (
          <div className="rounded-tile hairline bg-ink-900 p-5">
            <p className="stencil">offline</p>
            <p className="mt-2 text-[17px] leading-snug">
              Can’t reach the server. Nothing was logged.
            </p>
            <button
              type="button"
              onClick={() => void trackersQuery.refetch()}
              className="tap mt-4 h-12 w-full rounded-xl border border-white/10 bg-ink-800 text-[15px]"
            >
              Try again
            </button>
          </div>
        ) : trackers.length === 0 ? (
          <div className="rounded-tile hairline bg-ink-900 p-5">
            <p className="stencil">no trackers yet</p>
            <p className="mt-2.5 text-[19px] leading-snug tracking-[-0.02em] text-balance">
              TickIt ships with no opinions. Describe the first thing worth logging.
            </p>
            <Link
              href="/trackers"
              className="tap mt-5 flex h-[60px] w-full items-center justify-center rounded-2xl bg-amber text-[17px] font-semibold text-ink-950"
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
    </div>
  )
}
