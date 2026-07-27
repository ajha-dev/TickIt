/**
 * The 24-hour ribbon — the point of the whole Dashboard.
 *
 * One lane per tracker. Spans draw as bars, Moments as ticks, and the lane is
 * always the *full* local day: the ribbon never crops to the hours that happen
 * to be interesting, because the moment it does, two nights stop being
 * comparable and the shape of a night is the only thing this view is for.
 *
 * Geometry comes from `fractionOfDay`, which measures against the real length
 * of the local day. On the two days a year that run 23 or 25 hours, the bars
 * and the hour rules stay in step instead of drifting apart.
 *
 * Colour is the tracker's, always — which is why the lane labels double as the
 * legend and there is no second colour scale anywhere on this screen.
 */

import { safeColour } from '../lib/colours.ts'
import { fractionOfDay, type DaySegment } from '../lib/stats.ts'
import { formatClock, formatDuration } from '../lib/time.ts'
import type { Event, Tracker } from '../types.ts'

/** Hour rules, placed by wall clock so a DST day's marks stay honest. */
const RULE_HOURS = [0, 6, 12, 18] as const

export interface RibbonLane {
  tracker: Tracker
  segments: DaySegment[]
}

function ruleFractions(day: number): { hour: number; fraction: number }[] {
  return RULE_HOURS.map((hour) => {
    const at = new Date(day)
    at.setHours(hour, 0, 0, 0)
    return { hour, fraction: fractionOfDay(at.getTime(), day) }
  })
}

export function DayRibbon({
  day,
  lanes,
  now,
  showNow,
  onSelect,
}: {
  /** Local midnight of the day being shown. */
  day: number
  lanes: RibbonLane[]
  now: number
  /** True when `day` is today — draws the live "now" rule. */
  showNow: boolean
  onSelect: (event: Event) => void
}) {
  const rules = ruleFractions(day)

  return (
    <section aria-label="Day ribbon">
      <div className="relative flex h-4 items-start">
        {rules.map(({ hour, fraction }) => (
          <span
            key={hour}
            className={`stencil absolute top-0 ${hour === 0 ? '' : '-translate-x-1/2'}`}
            style={{ left: `${fraction * 100}%` }}
          >
            {String(hour).padStart(2, '0')}
          </span>
        ))}
        <span className="stencil absolute top-0 right-0">24</span>
      </div>

      <div className="flex flex-col gap-3.5">
        {lanes.map((lane) => (
          <Lane
            key={lane.tracker.id}
            lane={lane}
            day={day}
            now={now}
            rules={rules}
            showNow={showNow}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  )
}

function Lane({
  lane,
  day,
  now,
  rules,
  showNow,
  onSelect,
}: {
  lane: RibbonLane
  day: number
  now: number
  rules: { hour: number; fraction: number }[]
  showNow: boolean
  onSelect: (event: Event) => void
}) {
  const colour = safeColour(lane.tracker.colour)
  const isSpan = lane.tracker.type === 'INTERVAL'
  const count = lane.segments.length

  return (
    <div>
      <div className="flex items-baseline gap-2 pb-1.5">
        <span
          aria-hidden
          className="size-2 shrink-0 translate-y-[-1px] rounded-full"
          style={{ background: colour, boxShadow: count > 0 ? `0 0 8px ${colour}` : 'none' }}
        />
        <span
          className={`min-w-0 flex-1 truncate text-[14px] leading-none tracking-[-0.01em] ${
            count > 0 ? 'text-text' : 'text-text-dim'
          }`}
        >
          {lane.tracker.name}
        </span>
        <span className="stencil">{count === 0 ? 'none' : `${count}×`}</span>
      </div>

      <div
        className="relative h-7 rounded-md bg-ink-850"
        style={{ boxShadow: 'inset 0 0 0 1px var(--ink-700)' }}
      >
        {rules.map(({ hour, fraction }) =>
          hour === 0 ? null : (
            <span
              key={hour}
              aria-hidden
              className="absolute inset-y-0 w-px bg-ink-700"
              style={{ left: `${fraction * 100}%` }}
            />
          ),
        )}

        {showNow ? (
          <span
            aria-hidden
            className="absolute inset-y-[-3px] z-10 w-px bg-lavender/70"
            style={{ left: `${fractionOfDay(now, day) * 100}%` }}
          />
        ) : null}

        {lane.segments.map((segment) =>
          isSpan ? (
            <SpanBar
              key={segment.event.id}
              segment={segment}
              day={day}
              colour={colour}
              name={lane.tracker.name}
              onSelect={onSelect}
            />
          ) : (
            <MomentTick
              key={segment.event.id}
              segment={segment}
              day={day}
              colour={colour}
              name={lane.tracker.name}
              onSelect={onSelect}
            />
          ),
        )}
      </div>
    </div>
  )
}

function SpanBar({
  segment,
  day,
  colour,
  name,
  onSelect,
}: {
  segment: DaySegment
  day: number
  colour: string
  name: string
  onSelect: (event: Event) => void
}) {
  const left = fractionOfDay(segment.from, day)
  const right = fractionOfDay(segment.to, day)
  const width = Math.max(right - left, 0)

  // A clipped end is squared off: the flat edge says the span carries on into
  // the neighbouring day rather than finishing at midnight.
  const radius = (clipped: boolean) => (clipped ? '2px' : '5px')

  return (
    <button
      type="button"
      onClick={() => onSelect(segment.event)}
      aria-label={`${name}, ${formatClock(segment.event.startAt)} to ${
        segment.running ? 'now, running' : formatClock(segment.to)
      }, ${formatDuration(segment.to - segment.from)}`}
      className="tap absolute top-1/2 -translate-y-1/2"
      style={{
        left: `${left * 100}%`,
        width: `max(${width * 100}%, 3px)`,
        height: '16px',
      }}
    >
      {/* Extends the hit target past a 3px bar without moving the mark. */}
      <span aria-hidden className="absolute -inset-x-2 -inset-y-1.5" />
      <span
        aria-hidden
        className="absolute inset-0"
        style={{
          background: colour,
          opacity: segment.running ? 0.82 : 1,
          borderTopLeftRadius: radius(segment.clippedStart),
          borderBottomLeftRadius: radius(segment.clippedStart),
          borderTopRightRadius: radius(segment.clippedEnd),
          borderBottomRightRadius: radius(segment.clippedEnd),
        }}
      />
      {segment.running ? (
        <span
          aria-hidden
          className="anim-pulse absolute top-1/2 -right-[3px] size-[7px] -translate-y-1/2 rounded-full"
          style={{ background: colour, boxShadow: `0 0 8px ${colour}` }}
        />
      ) : null}
    </button>
  )
}

function MomentTick({
  segment,
  day,
  colour,
  name,
  onSelect,
}: {
  segment: DaySegment
  day: number
  colour: string
  name: string
  onSelect: (event: Event) => void
}) {
  const left = fractionOfDay(segment.from, day)

  return (
    <button
      type="button"
      onClick={() => onSelect(segment.event)}
      aria-label={`${name} at ${formatClock(segment.from)}`}
      className="tap absolute top-1/2 h-[18px] w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-[1px]"
      style={{ left: `${left * 100}%`, background: colour }}
    >
      <span aria-hidden className="absolute -inset-x-2.5 -inset-y-1.5" />
    </button>
  )
}
