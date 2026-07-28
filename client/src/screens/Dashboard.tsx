/**
 * Dashboard — trackers charted over time.
 *
 * The question this screen answers is "when do feeds happen?", and the shape
 * that answers it is an actogram: days across, time of day down, every event a
 * mark in its day's column. A calendar of counts was tried here first and could
 * not answer it — a day cell can say *how many*, never *when*.
 *
 * **On overlaying every tracker at once.** This file used to argue that one
 * tracker at a time was a deliberate constraint, because two trackers on one
 * 24-hour field turn a legible raster into confetti. That objection was put to
 * the user, who asked for the overlay anyway — so **All** exists, and this note
 * replaces the argument rather than sitting above code that contradicts it. The
 * objection was not wrong, and three things answer it instead of denying it:
 *
 * - **The legend is the key, not the chart.** Under All it lists every
 *   non-archived tracker with its colour and its mark count, so a tracker can
 *   always be found by name. Nothing on this screen asks a reader to identify a
 *   mark by hue alone.
 * - **The palette runs out, and it says so.** `TRACKER_COLOURS` has eight
 *   colours that stay apart for every reader (THEME.md), so a profile past
 *   eight trackers has some sharing a hue. `allTrackersScheme` reports which
 *   pairs and the legend names them, in the same voice the Choice-field
 *   overflow already uses. Declining to imply a distinction the colours cannot
 *   carry is the rule; here it takes the form of a sentence rather than a
 *   refusal, because the colours belong to the trackers and are load-bearing on
 *   every other screen.
 * - **Marks are drawn below full opacity.** Two trackers on the same minute
 *   composite brighter rather than one hiding the other, so a crowded hour reads
 *   as density — which is the honest thing an overlay can say about it.
 *
 * All is a *selection*, not a second chart: the same `columnsFor` pipeline, the
 * same `Actogram`, a colour function keyed on `event.trackerId` instead of on a
 * field value.
 */

import { useMemo, useState } from 'react'
import { useLocation } from 'wouter'

import { Actogram, ActogramLegend } from '../components/Actogram.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { ALL, useChartTracker } from '../lib/chartTracker.ts'
import { safeColour } from '../lib/colours.ts'
import { addDays, endOfDay, startOfDay } from '../lib/days.ts'
import { useEventRange, EVENT_LIMIT } from '../lib/eventWindow.ts'
import { useTrackers } from '../lib/queries.ts'
import { allTrackersScheme, seriesScheme } from '../lib/series.ts'
import { columnsFor, dayRange, SPAN_LOOKBACK_MS } from '../lib/stats.ts'
import { useNow } from '../lib/time.ts'
import type { Event, Profile, Tracker } from '../types.ts'

/** A fortnight is what a pattern needs to be visible without being a wall. */
const RANGES = [14, 30, 60] as const
type Range = (typeof RANGES)[number]

export function DashboardScreen({ profile }: { profile: Profile }) {
  const profileId = profile.id
  // A minute is plenty: the only live thing here is the open end of a running
  // span, and it moves a pixel an hour on this scale.
  const now = useNow(60_000)

  const [range, setRange] = useState<Range>(14)
  const [picking, setPicking] = useState(false)

  const trackersQuery = useTrackers(profileId)
  const trackers = useMemo(() => trackersQuery.data ?? [], [trackersQuery.data])

  // The choice is remembered per profile and survives a reload — see
  // lib/chartTracker.ts. Switching profile picks up that profile's own
  // remembered tracker rather than carrying a dangling id across.
  const { all, tracker, active, selectable, select } = useChartTracker(profileId, trackers)
  const charting = all || tracker !== null

  const days = useMemo(() => {
    const last = startOfDay(now)
    return dayRange(addDays(last, -(range - 1)), last)
  }, [range, now])

  const first = days[0] ?? startOfDay(now)
  const window = useEventRange(
    profileId,
    first - SPAN_LOOKBACK_MS,
    endOfDay(days[days.length - 1] ?? first),
    charting,
  )

  // Archived trackers are excluded from All — a tracker deliberately put away
  // should not keep taking up the chart, the same rule the Timeline applies.
  // A *single* archived tracker can still be charted, because choosing it is an
  // explicit act rather than a default.
  const activeIds = useMemo(() => new Set(active.map((t) => t.id)), [active])
  const events = useMemo(() => {
    if (all) return window.events.filter((e) => activeIds.has(e.trackerId))
    if (tracker === null) return []
    return window.events.filter((e) => e.trackerId === tracker.id)
  }, [window.events, all, activeIds, tracker])

  const columns = useMemo(() => columnsFor(events, days, now), [events, days, now])

  // Counts are of **marks**, not events, so the legend's numbers add up to what
  // is on screen: a span across midnight is drawn twice and counted twice.
  const counts = useMemo(() => {
    const perTracker = new Map<string, number>()
    let total = 0
    for (const column of columns.values()) {
      for (const mark of column) {
        const id = mark.event.trackerId
        perTracker.set(id, (perTracker.get(id) ?? 0) + 1)
        total += 1
      }
    }
    return { perTracker, total }
  }, [columns])

  const marks = counts.total

  const scheme = useMemo(
    () =>
      all
        ? allTrackersScheme(active, counts.perTracker)
        : tracker === null
          ? null
          : seriesScheme(tracker),
    [all, active, counts.perTracker, tracker],
  )

  const nameFor = useMemo(() => {
    const byId = new Map(trackers.map((t) => [t.id, t.name]))
    return (event: Event) => byId.get(event.trackerId) ?? 'Event'
  }, [trackers])

  const [, setLocation] = useLocation()
  const openInTimeline = (event: Event) => {
    setLocation(`/timeline?event=${encodeURIComponent(event.id)}`)
  }

  return (
    // `h-dvh`, not `min-h-dvh`: this screen is sized TO the viewport rather than
    // by its content, which is what lets the chart claim the leftover height.
    // With min-height the flex child would happily grow past the bottom.
    <div className="relative z-10 flex h-dvh flex-col overflow-hidden">
      <header className="pad-safe-top pad-safe-x pb-3">
        <h1 className="lockup text-[15px] font-semibold tracking-[-0.02em]">Dashboard</h1>
        <p className="stencil mt-1.5">{profile.name}</p>
      </header>

      {/* A flex column that owns the viewport: the picker and range sit at their
          natural height, the chart takes everything left over, and the legend
          rests on the bottom above the tab bar. `min-h-0` is what stops the
          chart pushing the legend off-screen. */}
      <main className="pad-safe-x pad-tabs flex min-h-0 flex-1 flex-col">
        {trackersQuery.isPending ? (
          <p className="stencil">loading</p>
        ) : !charting ? (
          <NoTrackers />
        ) : (
          <>
            <SelectionButton
              all={all}
              tracker={tracker}
              active={active}
              marks={marks}
              onOpen={() => setPicking(true)}
            />

            <RangePicker value={range} onChange={setRange} />

            {window.isError ? (
              <ErrorCard onRetry={window.refetch} />
            ) : scheme === null ? null : (
              <>
                <div className="mt-4 flex min-h-0 flex-1 flex-col">
                  <Actogram
                    days={days}
                    columns={columns}
                    scheme={scheme}
                    nameFor={nameFor}
                    onSelect={openInTimeline}
                  />
                </div>

                {marks === 0 && !window.isPending ? (
                  <p className="mt-3 shrink-0 text-[15px] leading-snug text-balance text-text-dim">
                    Nothing logged for {all ? 'any tracker' : tracker?.name} in the last {range}{' '}
                    days. The grid above is the range it looked in.
                  </p>
                ) : null}

                {/* Pinned below the chart rather than floating after it. */}
                <div className="shrink-0">
                  <ActogramLegend scheme={scheme} />
                  {window.capped ? <CapNotice all={all} /> : null}
                </div>
              </>
            )}
          </>
        )}
      </main>

      <Sheet
        open={picking}
        onClose={() => setPicking(false)}
        eyebrow="chart"
        title="What to chart"
        body="All draws every tracker on one 24-hour field, each in its own colour, with the legend as the key. One tracker draws that tracker alone."
      >
        <button
          type="button"
          onClick={() => {
            select(ALL)
            setPicking(false)
          }}
          aria-current={all ? 'true' : undefined}
          className={`tap flex h-[60px] w-full items-center gap-3 rounded-2xl border px-4 text-left text-[17px] ${
            all ? 'border-mauve/55 bg-mauve/10' : 'border-ink-600 bg-ink-700'
          }`}
        >
          <ColourCluster trackers={active} />
          <span className="min-w-0 flex-1 truncate">All</span>
          <span className="stencil">
            {active.length} {active.length === 1 ? 'tracker' : 'trackers'}
          </span>
        </button>

        <div aria-hidden className="my-1 h-px bg-ink-600" />

        {selectable.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => {
              select(candidate.id)
              setPicking(false)
            }}
            aria-current={!all && candidate.id === tracker?.id ? 'true' : undefined}
            className={`tap flex h-[60px] w-full items-center gap-3 rounded-2xl border px-4 text-left text-[17px] ${
              !all && candidate.id === tracker?.id
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
            <span className="stencil">{candidate.type === 'INTERVAL' ? 'span' : 'moment'}</span>
          </button>
        ))}
      </Sheet>
    </div>
  )
}

/**
 * What is being charted, and the way to change it. Under All the single dot
 * becomes a short overlap of the first few tracker colours — the same gesture
 * the chart itself makes, at the size of a bullet.
 */
function SelectionButton({
  all,
  tracker,
  active,
  marks,
  onOpen,
}: {
  all: boolean
  tracker: Tracker | null
  active: Tracker[]
  marks: number
  onOpen: () => void
}) {
  const title = all ? 'All trackers' : (tracker?.name ?? '')
  const kind = all
    ? `${active.length} ${active.length === 1 ? 'tracker' : 'trackers'}`
    : tracker?.type === 'INTERVAL'
      ? 'span'
      : 'moment'

  return (
    <button
      type="button"
      onClick={onOpen}
      className="tap flex min-h-[60px] w-full items-center gap-3 rounded-2xl border border-ink-700 bg-ink-850 px-4 text-left active:bg-ink-800"
      aria-label={`Charting ${all ? 'all trackers' : title}. Choose what to chart`}
    >
      {all ? (
        <ColourCluster trackers={active} glow />
      ) : (
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full"
          style={{
            background: safeColour(tracker?.colour),
            boxShadow: `0 0 10px ${safeColour(tracker?.colour)}`,
          }}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[18px] leading-tight font-medium tracking-[-0.02em]">
          {title}
        </span>
        <span className="stencil mt-1.5 block">
          {kind} · {marks} {marks === 1 ? 'mark' : 'marks'}
        </span>
      </span>
      <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-text-dim" fill="none" aria-hidden>
        <path
          d="M7 10l5 5 5-5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

/** Three overlapping dots — "several trackers" at bullet size. */
function ColourCluster({ trackers, glow = false }: { trackers: Tracker[]; glow?: boolean }) {
  const colours = trackers.slice(0, 3).map((t) => safeColour(t.colour))
  if (colours.length === 0) colours.push('var(--color-ink-600)')

  return (
    <span aria-hidden className="flex shrink-0 items-center">
      {colours.map((colour, i) => (
        <span
          key={i}
          className="size-2.5 rounded-full"
          style={{
            background: colour,
            marginLeft: i === 0 ? 0 : '-3px',
            // A hairline of the surface between them, so overlapping dots stay
            // three dots rather than becoming one lozenge.
            boxShadow: glow
              ? `0 0 10px ${colour}, 0 0 0 1.5px var(--ink-850)`
              : '0 0 0 1.5px var(--ink-700)',
          }}
        />
      ))}
    </span>
  )
}

function RangePicker({ value, onChange }: { value: Range; onChange: (next: Range) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Range"
      className="mt-2.5 flex gap-1 rounded-2xl border border-ink-700 bg-ink-850 p-1"
    >
      {RANGES.map((days) => {
        const selected = days === value
        return (
          <button
            key={days}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(days)}
            className={`tap h-11 flex-1 rounded-xl text-[15px] ${
              selected ? 'bg-ink-700 font-medium text-text' : 'text-text-dim'
            }`}
          >
            {days} days
          </button>
        )
      })}
    </div>
  )
}

/**
 * The events endpoint caps at 1000 and drops the *oldest* first, so a range
 * that hit the cap is missing its left-hand side. Saying so is the only honest
 * option — a chart quietly plotting 1000 of 1400 events is worse than none.
 *
 * All pulls every tracker through the same window, so it reaches the cap far
 * sooner than any single tracker does — often on a range that was complete a
 * moment earlier. The notice says which lever to pull.
 */
function CapNotice({ all }: { all: boolean }) {
  return (
    <p className="mt-4 rounded-xl border border-ink-700 bg-ink-850 px-3.5 py-3 text-[13px] leading-snug text-text-dim">
      This profile logged more than {EVENT_LIMIT} events in this range, so the earliest columns are
      incomplete. Narrow the range{all ? ', or chart one tracker,' : ''} for an exact picture.
    </p>
  )
}

function NoTrackers() {
  return (
    <div className="rounded-tile hairline bg-ink-850 p-5">
      <p className="stencil">nothing to chart</p>
      <p className="mt-2.5 text-[19px] leading-snug tracking-[-0.02em] text-balance">
        This profile has no trackers yet, so there is no pattern to look for.
      </p>
    </div>
  )
}

function ErrorCard({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-tile hairline mt-5 bg-ink-850 p-5">
      <p className="stencil">offline</p>
      <p className="mt-2 text-[17px] leading-snug">Can’t reach the server.</p>
      <button
        type="button"
        onClick={onRetry}
        className="tap mt-4 h-12 w-full rounded-xl border border-ink-600 bg-ink-800 text-[15px]"
      >
        Try again
      </button>
    </div>
  )
}
