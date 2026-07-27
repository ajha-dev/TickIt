/**
 * The month level of the Dashboard: a calendar grid where every cell carries a
 * density indicator, so a month of feeding or training reads at a glance.
 *
 * The indicator is a stacked bar with two channels, and they are deliberately
 * different questions: the bar's *length* is the day's total against the
 * busiest day in the grid — how much — and its *segments* are the mix by
 * tracker — of what. Colour comes from the tracker and nowhere else; the legend
 * is the tracker list on the day below.
 *
 * Segments are separated by a 2px gap in the surface colour rather than a
 * stroke, because at this size a border would be most of the mark.
 */

import { isToday, startOfMonth, weekdayLabels } from '../lib/days.ts'
import { safeColour } from '../lib/colours.ts'
import type { DayDensity } from '../lib/stats.ts'
import type { Tracker } from '../types.ts'

const WEEKDAYS = weekdayLabels()

export function MonthGrid({
  month,
  days,
  densities,
  peak,
  selected,
  onSelect,
}: {
  /** Any instant inside the month being shown. */
  month: number
  days: number[]
  densities: Map<number, DayDensity>
  /** The busiest day in the grid — the scale every bar is drawn against. */
  peak: number
  selected: number | null
  onSelect: (day: number) => void
}) {
  const monthStart = startOfMonth(month)

  return (
    <div>
      <div className="grid grid-cols-7 gap-1 pb-2">
        {WEEKDAYS.map((label, i) => (
          <div key={i} className="stencil text-center">
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {days.map((day) => (
          <DayCell
            key={day}
            day={day}
            density={densities.get(day)}
            peak={peak}
            outside={startOfMonth(day) !== monthStart}
            selected={selected === day}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  )
}

function DayCell({
  day,
  density,
  peak,
  outside,
  selected,
  onSelect,
}: {
  day: number
  density: DayDensity | undefined
  peak: number
  outside: boolean
  selected: boolean
  onSelect: (day: number) => void
}) {
  const total = density?.total ?? 0
  const today = isToday(day)
  const date = new Date(day).getDate()

  return (
    <button
      type="button"
      onClick={() => onSelect(day)}
      aria-label={`${new Date(day).toDateString()} — ${total} ${total === 1 ? 'event' : 'events'}`}
      aria-current={today ? 'date' : undefined}
      className={`tap flex h-[52px] flex-col items-center justify-between rounded-xl border px-1 pt-1.5 pb-2 ${
        selected
          ? 'border-mauve/60 bg-mauve/10'
          : today
            ? 'border-periwinkle/40 bg-ink-850'
            : 'border-ink-700/70 bg-ink-850 active:bg-ink-800'
      } ${outside ? 'opacity-40' : ''}`}
    >
      <span
        className={`digits text-[12px] leading-none ${
          today ? 'text-periwinkle' : total > 0 ? 'text-text' : 'text-text-dim'
        }`}
      >
        {date}
      </span>

      <Density density={density} peak={peak} />
    </button>
  )
}

/**
 * The legend — which is simply the tracker list, because tracker colour is the
 * only colour scale on this screen. It doubles as the month's totals, so the
 * cells' segments can be read without opening a day.
 */
export function MonthLegend({
  entries,
}: {
  entries: { tracker: Tracker; count: number }[]
}) {
  if (entries.length === 0) return null

  return (
    <ul className="flex flex-col gap-2.5">
      {entries.map(({ tracker, count }) => {
        const colour = safeColour(tracker.colour)
        return (
          <li key={tracker.id} className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ background: colour, boxShadow: count > 0 ? `0 0 8px ${colour}` : 'none' }}
            />
            <span
              className={`min-w-0 flex-1 truncate text-[14px] leading-none tracking-[-0.01em] ${
                count > 0 ? 'text-text' : 'text-text-dim'
              }`}
            >
              {tracker.name}
            </span>
            <span className="digits text-[13px] leading-none text-text-dim">{count}</span>
          </li>
        )
      })}
    </ul>
  )
}

/** The stacked bar. Nothing at all on an empty day — absence should read as absence. */
function Density({ density, peak }: { density: DayDensity | undefined; peak: number }) {
  if (!density || density.total === 0 || peak === 0) {
    return <span aria-hidden className="h-[5px] w-1 rounded-full bg-ink-700" />
  }

  // Length is the day against the busiest day in the grid, floored at 22% so a
  // single event on a busy month is still visible rather than a sliver.
  const length = Math.max(0.22, density.total / peak)

  return (
    <span
      aria-hidden
      className="flex h-[5px] gap-[2px] overflow-hidden rounded-full"
      style={{ width: `${length * 100}%` }}
    >
      {density.byTracker.map(({ tracker, count }) => (
        <span
          key={tracker.id}
          className="h-full rounded-full"
          style={{
            flexGrow: count,
            flexBasis: 0,
            minWidth: '2px',
            background: safeColour(tracker.colour),
          }}
        />
      ))}
    </span>
  )
}
