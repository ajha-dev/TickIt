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

import { TRACKER_COLOURS } from '../lib/colours.ts'
import { fractionOfDay, type DayMark } from '../lib/stats.ts'
import type { SeriesScheme } from '../lib/series.ts'
import { formatClock, formatDuration } from '../lib/time.ts'
import type { Event } from '../types.ts'

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
  days,
  columns,
  scheme,
  nameFor,
  onSelect,
}: {
  /** Local midnights, oldest first — one column each. */
  days: number[]
  columns: Map<number, DayMark[]>
  scheme: SeriesScheme
  /**
   * What to call an event out loud. One tracker's chart answers with its name
   * for everything; the overlay looks the event's tracker up, which is the only
   * thing keeping a screen reader from hearing fourteen trackers as one.
   */
  nameFor: (event: Event) => string
  onSelect: (event: Event) => void
}) {
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
                    colour={scheme.colourOf(scheme.keyFor(mark.event))}
                    opacity={scheme.opacity}
                    name={nameFor(mark.event)}
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
  colour,
  opacity,
  name,
  onSelect,
}: {
  mark: DayMark
  colour: string
  /** The scheme's base opacity — below 1 only for the overlay. */
  opacity: number
  name: string
  onSelect: (event: Event) => void
}) {
  // Read off the event, not off a tracker: the overlay draws Spans and Moments
  // side by side, and `type` is denormalised onto every row for exactly this.
  const isSpan = mark.event.type === 'INTERVAL'
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
          opacity: opacity * (mark.running ? 0.85 : 1),
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
 * The legend. Present whenever the colours are splitting the events into two or
 * more series — identity must never rest on colour-matching alone — and absent
 * when the whole chart is one tracker in one colour, where a one-swatch box
 * would only restate the heading.
 *
 * Two things can take the legend's place or sit under it, and both exist for
 * the same reason: a colour that cannot carry a distinction has to say so.
 *
 * - A field with more options than the palette has slots is not coloured by at
 *   all. Adding a ninth option and watching the chart go monochrome with
 *   nothing said would read as a fault in the chart.
 * - Under **All**, the colours belong to the trackers and there are more
 *   trackers than colours, so the shared hues are named. The reader is told
 *   which pairs the legend, not the chart, is what separates.
 *
 * The all-trackers legend carries counts and can run to a dozen rows, so it is
 * two columns and scrolls inside a capped height — the chart above it is the
 * thing the screen is for, and the legend must never push it off the viewport.
 */
export function ActogramLegend({ scheme }: { scheme: SeriesScheme }) {
  if (scheme.declined) {
    const { field, categories } = scheme.declined
    return (
      <p className="mt-4 text-[13px] leading-snug text-balance text-text-dim">
        Not colouring by {field.label}: {categories} options is more than the{' '}
        {TRACKER_COLOURS.length} colours that stay apart for every reader, so every mark is in
        this tracker’s own colour.
      </p>
    )
  }

  if (scheme.series.length === 0 || scheme.title === null) return null

  const counted = scheme.series.some((s) => s.count !== undefined)

  return (
    <div className="mt-4 rounded-2xl border border-ink-700 bg-ink-850 p-4">
      <p className="stencil pb-3">colour · {scheme.title}</p>
      <ul
        className={
          counted
            ? 'grid max-h-[18dvh] grid-cols-2 gap-x-4 gap-y-2 overflow-y-auto overscroll-contain'
            : 'flex flex-wrap gap-x-5 gap-y-2.5'
        }
      >
        {scheme.series.map((s) => (
          <li
            key={s.key}
            // A tracker with nothing in this range keeps its row — "logged
            // nothing" and "not included" are different answers — but recedes,
            // so the eye reads the rows that are actually on the chart first.
            className={`flex min-w-0 items-center gap-2 ${s.count === 0 ? 'opacity-45' : ''}`}
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ background: s.colour }}
            />
            <span className="truncate text-[14px] leading-none">{s.label}</span>
            {s.count === undefined ? null : (
              <span className="digits ml-auto shrink-0 text-[12px] leading-none text-text-dim">
                {s.count}
              </span>
            )}
          </li>
        ))}
      </ul>

      {scheme.collisions.length > 0 ? <SharedColours groups={scheme.collisions} /> : null}
    </div>
  )
}

/**
 * The one quiet line naming trackers that were handed the same colour.
 *
 * Same principle as the declined-field note above, and deliberately the same
 * voice: state the arithmetic, name what is affected, say what to read instead.
 * The alternative — drawing two trackers in one hue and saying nothing — is the
 * chart implying a distinction the palette cannot carry.
 */
function SharedColours({ groups }: { groups: string[][] }) {
  const listed = groups.slice(0, 3).map(sentenceList)
  const rest = groups.length - listed.length

  // Deliberately no arithmetic about how many trackers there are. Colours run
  // out once a profile passes eight, but two trackers can also have been given
  // the same colour by hand at any count — so the sentence states the ceiling
  // and the consequence, and claims nothing it cannot know.
  return (
    <p className="mt-3.5 border-t border-ink-700 pt-3 text-[13px] leading-snug text-balance text-text-dim">
      Sharing a colour: {listed.join(', ')}
      {rest > 0 ? `, and ${rest} more ${rest === 1 ? 'pair' : 'pairs'}` : ''}. Only{' '}
      {TRACKER_COLOURS.length} colours stay apart for every reader, so the list above is what tells
      those trackers apart, not the chart.
    </p>
  )
}

/** "Nap and Walk", "Nap, Walk and Run". */
function sentenceList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
