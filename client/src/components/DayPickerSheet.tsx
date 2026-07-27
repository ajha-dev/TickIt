import { useMemo, useRef, useState, type TouchEvent } from 'react'
import { useQuery } from '@tanstack/react-query'

import { listEvents } from '../api.ts'
import { Sheet } from './Sheet.tsx'
import {
  addMonths,
  endOfMonth,
  formatMonthHeading,
  isSameDay,
  isToday,
  monthGrid,
  startOfDay,
  startOfMonth,
  weekdayLabels,
} from '../lib/days.ts'

/**
 * The date picker behind the Timeline's heading.
 *
 * Replaces `<input type="date">`. The native picker knows the calendar but
 * knows nothing about this log, so every day looks equally worth visiting —
 * and most of them are empty. Here a day that has entries is legible and a day
 * that has none is dimmed, which turns picking a date into reading where the
 * data actually is.
 *
 * A span is counted on the day it *started*. Marking every day an overnight
 * feed touches would light up days whose only content began the night before,
 * which reads as busier than the log is.
 */

/** The endpoint's ceiling. A month of one person's logging never nears it. */
const LIMIT = 1000

export function DayPickerSheet({
  open,
  day,
  profileId,
  onPick,
  onClose,
}: {
  open: boolean
  /** The day currently on screen; the calendar opens on its month. */
  day: number
  profileId: string
  onPick: (next: number) => void
  onClose: () => void
}) {
  const [month, setMonth] = useState(() => startOfMonth(day))
  // Reopening on a different day should land on that day's month, not on
  // whichever month was last browsed.
  const openedFor = useRef(day)
  if (open && openedFor.current !== day) {
    openedFor.current = day
    setMonth(startOfMonth(day))
  }

  const grid = useMemo(() => monthGrid(month), [month])
  const labels = useMemo(() => weekdayLabels(), [])

  const from = grid[0] ?? month
  const to = endOfMonth(grid[grid.length - 1] ?? month)

  // Only what the visible grid needs, and only while the sheet is open.
  const eventsQuery = useQuery({
    queryKey: ['events', profileId, 'range', from, to],
    queryFn: () => listEvents({ profileId, from, to, limit: LIMIT }),
    enabled: open && Boolean(profileId),
    staleTime: 30_000,
  })

  const daysWithData = useMemo(() => {
    const set = new Set<number>()
    for (const event of eventsQuery.data ?? []) set.add(startOfDay(event.startAt))
    return set
  }, [eventsQuery.data])

  // Swipe between months. Tracked on the grid only, so a swipe that starts on
  // the sheet's handle still drags the sheet.
  const touchX = useRef<number | null>(null)
  const onTouchStart = (e: TouchEvent) => {
    touchX.current = e.touches[0]?.clientX ?? null
  }
  const onTouchEnd = (e: TouchEvent) => {
    const start = touchX.current
    touchX.current = null
    if (start === null) return
    const dx = (e.changedTouches[0]?.clientX ?? start) - start
    // Generous threshold: a hesitant swipe should not flip two months, and a
    // tap that drifts a few pixels must never count as one.
    if (Math.abs(dx) < 48) return
    setMonth((m) => addMonths(m, dx < 0 ? 1 : -1))
  }

  const thisMonth = startOfMonth(Date.now())

  return (
    <Sheet open={open} onClose={onClose} eyebrow="jump to" title={formatMonthHeading(month)}>
      <div className="-mt-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <MonthArrow direction="back" onClick={() => setMonth((m) => addMonths(m, -1))} />
          <p className="stencil">{eventsQuery.isPending ? 'loading' : 'swipe to change month'}</p>
          <MonthArrow
            direction="forward"
            onClick={() => setMonth((m) => addMonths(m, 1))}
            // Nothing has been logged in the future, so there is nothing to
            // browse there. A future date is still reachable by arrowing from
            // the Timeline itself, which is the rare case.
            disabled={month >= thisMonth}
          />
        </div>

        <div className="mb-1.5 grid grid-cols-7 gap-1">
          {labels.map((label, i) => (
            <span key={i} className="stencil text-center">
              {label}
            </span>
          ))}
        </div>

        <div
          className="grid grid-cols-7 gap-1 touch-pan-y"
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          {grid.map((cell) => (
            <DayCell
              key={cell}
              day={cell}
              inMonth={startOfMonth(cell) === month}
              hasData={daysWithData.has(cell)}
              selected={isSameDay(cell, day)}
              today={isToday(cell)}
              onPick={() => {
                onPick(cell)
                onClose()
              }}
            />
          ))}
        </div>
      </div>
    </Sheet>
  )
}

function DayCell({
  day,
  inMonth,
  hasData,
  selected,
  today,
  onPick,
}: {
  day: number
  inMonth: boolean
  hasData: boolean
  selected: boolean
  today: boolean
  onPick: () => void
}) {
  const date = new Date(day).getDate()

  // Three states, in descending prominence: selected, has entries, empty. A day
  // outside the month is dimmed further again so the month's own shape reads.
  const tone = selected
    ? 'bg-periwinkle text-ink-900 font-semibold'
    : hasData
      ? 'text-text bg-ink-700'
      : 'text-text-dim/45'

  return (
    <button
      type="button"
      onClick={onPick}
      aria-label={`${new Date(day).toDateString()}${hasData ? ', has entries' : ', nothing logged'}`}
      aria-current={selected ? 'date' : undefined}
      className={`tap relative flex h-11 items-center justify-center rounded-xl text-[15px] ${tone} ${
        inMonth ? '' : 'opacity-40'
      }`}
    >
      {date}
      {today && !selected ? (
        <span
          aria-hidden
          className="absolute bottom-1 size-1 rounded-full bg-periwinkle"
        />
      ) : null}
    </button>
  )
}

function MonthArrow({
  direction,
  onClick,
  disabled,
}: {
  direction: 'back' | 'forward'
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === 'back' ? 'Previous month' : 'Next month'}
      className="tap flex size-11 items-center justify-center rounded-xl border border-ink-700 bg-ink-850 text-text disabled:opacity-30"
    >
      <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden>
        <path
          d={direction === 'back' ? 'M14.5 5.5L8 12l6.5 6.5' : 'M9.5 5.5L16 12l-6.5 6.5'}
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}
