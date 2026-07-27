/**
 * The actogram: days across, time of day down.
 *
 * Each event is a vertical mark in its day's column, positioned by *when in the
 * day* it happened — so a month of feeding reads as a raster, and the fact that
 * feeds cluster at 02:00 is visible as a horizontal band rather than something
 * you have to reconstruct from a list. A Span draws as a rectangle from its
 * start to its end; a Moment draws as a tick.
 *
 * Three rules hold the chart honest, and all three are load-bearing:
 *
 * - **The y-axis is always the full 24 hours.** It never crops to the hours
 *   that happen to have data. The moment it does, two nights stop being
 *   comparable, which is the only question this chart exists to answer.
 * - **Every day in the range gets a column**, including the empty ones.
 *   Dropping them would make the x-axis lie about how much time passed.
 * - **A span crossing midnight is split at the boundary** and drawn in both
 *   columns, clipped — never dropped, never drawn outside its own column. A
 *   clipped end is squared off, so a flat edge always means "continues".
 *
 * Geometry uses `fractionOfDay`, which measures against the true length of each
 * local day: on the two days a year that run 23 or 25 hours, the marks and the
 * hour rules stay in step instead of drifting apart.
 */

import { fractionOfDay, type DayMark } from '../lib/stats.ts'
import type { SeriesScheme } from '../lib/series.ts'
import { formatClock, formatDuration } from '../lib/time.ts'
import type { Event, Tracker } from '../types.ts'

/**
 * Hour rules, by wall clock so a DST day's marks stay honest.
 *
 * The chart now fills the screen's height rather than a fixed 320px, so the
 * y-axis has room to be read at three-hour resolution instead of six. Majors
 * stay heavier — quarters of the day are the landmarks the eye navigates by —
 * and minors fill in between them so a 04:00 feed can be placed without
 * measuring against a distant rule.
 */
const MAJOR_HOURS = [0, 6, 12, 18] as const
const MINOR_HOURS = [3, 9, 15, 21] as const
/** Every label the axis carries, top to bottom. */
const LABEL_HOURS = [0, 3, 6, 9, 12, 15, 18, 21, 24] as const
/** Daylight band, lightly lifted out of the night so the raster reads. */
const DAY_BAND = [6, 18] as const

export function Actogram({
  tracker,
  days,
  columns,
  scheme,
  onSelect,
}: {
  tracker: Tracker
  /** Local midnights, oldest first — one column each. */
  days: number[]
  columns: Map<number, DayMark[]>
  scheme: SeriesScheme
  onSelect: (event: Event) => void
}) {
  const isSpan = tracker.type === 'INTERVAL'
  const width = days.length > 0 ? 100 / days.length : 100

  // Enough labels to place the eye, never so many that they collide: about one
  // per 7 columns, and always the last day so "today" is anchored.
  const labelEvery = Math.max(1, Math.ceil(days.length / 7))

  // The chart fills whatever height its parent gives it. The `min-h-0` on the
  // figure and on the plot column is what lets a flex child actually shrink to
  // the viewport, instead of being pushed past the bottom of the screen.
  return (
    <figure className="m-0 flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 gap-1.5">
        <YAxis />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-ink-850"
            style={{ boxShadow: 'inset 0 0 0 1px var(--ink-700)' }}
          >
            <Bands day={days[0] ?? Date.now()} />

            {days.map((day, i) => (
              <div
                key={day}
                className="absolute inset-y-0"
                style={{ left: `${i * width}%`, width: `${width}%` }}
              >
                {(columns.get(day) ?? []).map((mark) => (
                  <Mark
                    key={`${mark.event.id}:${mark.day}`}
                    mark={mark}
                    isSpan={isSpan}
                    colour={scheme.colourOf(scheme.keyFor(mark.event))}
                    name={tracker.name}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            ))}
          </div>

          <div className="relative h-4">
            {days.map((day, i) =>
              i % labelEvery === 0 || i === days.length - 1 ? (
                <span
                  key={day}
                  className="stencil absolute top-1 -translate-x-1/2 whitespace-nowrap"
                  style={{ left: `${i * width + width / 2}%` }}
                >
                  {new Date(day).getDate()}
                </span>
              ) : null,
            )}
          </div>
        </div>
      </div>

      <figcaption className="stencil mt-2.5">
        {monthSpan(days)} · one column per day
      </figcaption>
    </figure>
  )
}

/** "Jul", or "Jun – Jul" when the range crosses a month. */
function monthSpan(days: number[]): string {
  const first = days[0]
  const last = days[days.length - 1]
  if (first === undefined || last === undefined) return ''
  const fmt = new Intl.DateTimeFormat(undefined, { month: 'short' })
  const a = fmt.format(first)
  const b = fmt.format(last)
  return a === b ? a : `${a} – ${b}`
}

function YAxis() {
  return (
    <div className="relative h-full w-[26px] shrink-0">
      {LABEL_HOURS.map((hour) => (
        <span
          key={hour}
          className={`stencil absolute right-0 ${
            (MAJOR_HOURS as readonly number[]).includes(hour) || hour === 24
              ? ''
              : 'text-text-dim/55'
          }`}
          style={{
            top: `${(hour / 24) * 100}%`,
            // The first and last labels are pulled inside the plot's own edges;
            // everything between is centred on its rule.
            transform: hour === 0 ? 'none' : hour === 24 ? 'translateY(-100%)' : 'translateY(-50%)',
          }}
        >
          {String(hour).padStart(2, '0')}
        </span>
      ))}
    </div>
  )
}

/**
 * The hour rules and the daylight band. Positions come from the wall clock of a
 * representative day rather than from `hour / 24`, so a DST day does not push
 * the marks off their own gridlines.
 */
function Bands({ day }: { day: number }) {
  const at = (hour: number) => {
    const d = new Date(day)
    d.setHours(hour, 0, 0, 0)
    return fractionOfDay(d.getTime(), day)
  }

  const bandTop = at(DAY_BAND[0])
  const bandBottom = at(DAY_BAND[1])

  return (
    <>
      {/* Neutral, not a palette colour: the field stays near-black. */}
      <div
        aria-hidden
        className="absolute inset-x-0 bg-white/[0.022]"
        style={{ top: `${bandTop * 100}%`, height: `${(bandBottom - bandTop) * 100}%` }}
      />
      {MINOR_HOURS.map((hour) => (
        <div
          key={hour}
          aria-hidden
          className="absolute inset-x-0 h-px bg-ink-700/45"
          style={{ top: `${at(hour) * 100}%` }}
        />
      ))}
      {MAJOR_HOURS.map((hour) =>
        hour === 0 ? null : (
          <div
            key={hour}
            aria-hidden
            className="absolute inset-x-0 h-px bg-ink-700"
            style={{ top: `${at(hour) * 100}%` }}
          />
        ),
      )}
    </>
  )
}

function Mark({
  mark,
  isSpan,
  colour,
  name,
  onSelect,
}: {
  mark: DayMark
  isSpan: boolean
  colour: string
  name: string
  onSelect: (event: Event) => void
}) {
  const top = fractionOfDay(mark.from, mark.day)
  const bottom = fractionOfDay(mark.to, mark.day)
  const height = Math.max(bottom - top, 0)

  // A clipped edge is squared off; a finished edge is rounded. The flat edge is
  // the chart's way of saying "this carries on into the next column".
  const radius = (clipped: boolean) => (clipped ? '1px' : '3px')

  const label = isSpan
    ? `${name}, ${formatClock(mark.event.startAt)} to ${
        mark.running ? 'now, running' : formatClock(mark.to)
      }, ${formatDuration(mark.to - mark.from)}`
    : `${name} at ${formatClock(mark.from)}`

  return (
    <button
      type="button"
      onClick={() => onSelect(mark.event)}
      aria-label={label}
      title={label}
      className="tap absolute right-px left-px"
      style={
        isSpan
          ? { top: `${top * 100}%`, height: `max(${height * 100}%, 3px)` }
          : { top: `calc(${top * 100}% - 1.5px)`, height: '3px' }
      }
    >
      {/* Widens the hit target past a 3px mark without moving it. */}
      <span aria-hidden className="absolute -inset-x-1 -inset-y-1" />
      <span
        aria-hidden
        className="absolute inset-0"
        style={{
          background: colour,
          opacity: mark.running ? 0.85 : 1,
          borderTopLeftRadius: radius(mark.clippedStart),
          borderTopRightRadius: radius(mark.clippedStart),
          borderBottomLeftRadius: radius(mark.clippedEnd),
          borderBottomRightRadius: radius(mark.clippedEnd),
        }}
      />
    </button>
  )
}

/**
 * The legend. Present whenever a field is splitting the events into two or more
 * series — identity must never rest on colour-matching alone — and absent when
 * the whole chart is one tracker in one colour, where a one-swatch box would
 * only restate the heading.
 */
export function ActogramLegend({ scheme }: { scheme: SeriesScheme }) {
  if (scheme.series.length === 0 || scheme.field === null) return null

  return (
    <div className="mt-4 rounded-2xl border border-ink-700 bg-ink-850 p-4">
      <p className="stencil pb-3">colour · {scheme.field.label}</p>
      <ul className="flex flex-wrap gap-x-5 gap-y-2.5">
        {scheme.series.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ background: s.colour }}
            />
            <span className="text-[14px] leading-none">{s.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
