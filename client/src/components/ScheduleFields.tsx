import {
  dayName,
  draftTimesMin,
  formatDays,
  formatTimesPhrase,
  minutesToTime,
  timeToMinutes,
  DAY_COUNT,
  EVERY_DAY,
  MAX_TIMES,
  MINUTES_PER_DAY,
  WEEKDAYS,
  WEEKENDS,
} from '../lib/remindersApi.ts'
import { Section } from './ReminderBits.tsx'

/**
 * The `SCHEDULE` half of the reminder editor: which days, and what times on
 * them.
 *
 * Two things are load-bearing here. **Multiple times is the point** — a dose at
 * 09:00 and another at 21:00 is one schedule, not two reminders — so the time
 * list is a list from the first row onward rather than a single field that
 * grows. And **there are no quiet hours**: this component never renders them,
 * because a scheduled reminder fires at a time the user chose deliberately and
 * the contract rejects the fields outright (`QUIET_HOURS_NOT_ALLOWED`).
 *
 * Days are 0..6 with 0 = Sunday, matching JS `getDay()` and the stored column,
 * and the chips are laid out in that same order so the picker and the payload
 * can never disagree about which chip is which.
 */

interface Props {
  days: number[]
  onDays: (next: number[]) => void
  /** `HH:MM` strings as typed — a half-entered field has to be representable. */
  times: string[]
  onTimes: (next: string[]) => void
}

const QUICK: { label: string; days: number[] }[] = [
  { label: 'Every day', days: EVERY_DAY },
  { label: 'Weekdays', days: WEEKDAYS },
  { label: 'Weekends', days: WEEKENDS },
]

export function ScheduleFields({ days, onDays, times, onTimes }: Props) {
  const chosen = new Set(days)

  const toggleDay = (day: number) => {
    onDays(chosen.has(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b))
  }

  // A time that duplicates an earlier one is marked where it was typed, not
  // just named in the error line — the list can be eight rows long.
  const minutes = times.map(timeToMinutes)
  const duplicate = minutes.map((m, i) => m !== null && minutes.indexOf(m) < i)

  const addTime = () => {
    if (times.length >= MAX_TIMES) return
    onTimes([...times, nextTime(minutes)])
  }

  const validMinutes = draftTimesMin(times)
  const complete = days.length > 0 && times.length > 0 && validMinutes.length === times.length
  const occurrences = validMinutes.length * days.length

  return (
    <>
      {/* ----------------------------------------------------------- days -- */}
      <Section label="days">
        <div role="group" aria-label="Days of the week" className="grid grid-cols-7 gap-1.5">
          {Array.from({ length: DAY_COUNT }, (_, day) => {
            const selected = chosen.has(day)
            return (
              <button
                key={day}
                type="button"
                aria-pressed={selected}
                aria-label={dayName(day, 'long')}
                onClick={() => toggleDay(day)}
                className={`tap flex h-[46px] items-center justify-center rounded-xl border text-[12px] tracking-[-0.01em] ${
                  selected
                    ? 'border-mauve/55 bg-mauve/12 text-text'
                    : 'border-ink-600 bg-ink-700 text-text-dim'
                }`}
              >
                <span aria-hidden>{dayName(day)}</span>
              </button>
            )
          })}
        </div>

        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {QUICK.map((quick) => {
            const active = quick.days.length === days.length && quick.days.every((d) => chosen.has(d))
            return (
              <button
                key={quick.label}
                type="button"
                aria-pressed={active}
                onClick={() => onDays([...quick.days])}
                className={`tap h-9 rounded-lg border px-3 text-[13px] ${
                  active
                    ? 'border-mauve/45 bg-mauve/10 text-text'
                    : 'border-ink-600 bg-ink-800 text-text-dim'
                }`}
              >
                {quick.label}
              </button>
            )
          })}
        </div>
      </Section>

      {/* ---------------------------------------------------------- times -- */}
      <Section label="times">
        <ul className="flex flex-col gap-2">
          {times.map((time, index) => (
            // Index-keyed on purpose: the rows are positional, and two rows can
            // legitimately hold the same string mid-edit.
            <li key={index} className="flex items-center gap-2">
              <span
                className={`flex h-[52px] min-w-0 flex-1 items-center rounded-xl border bg-ink-800 px-3 focus-within:border-periwinkle ${
                  duplicate[index] ? 'border-ember/70' : 'border-ink-600'
                }`}
              >
                <input
                  type="time"
                  aria-label={`Time ${index + 1}`}
                  value={time}
                  onChange={(e) => {
                    const next = [...times]
                    next[index] = e.target.value
                    onTimes(next)
                  }}
                  className="w-full min-w-0 bg-transparent text-[16px] tracking-[-0.01em] outline-none"
                />
              </span>
              <button
                type="button"
                aria-label={`Remove time ${index + 1}`}
                disabled={times.length <= 1}
                onClick={() => onTimes(times.filter((_, i) => i !== index))}
                className="tap flex size-[52px] shrink-0 items-center justify-center rounded-xl border border-ink-600 bg-ink-700 text-[20px] leading-none text-text-dim disabled:opacity-30"
              >
                <span aria-hidden>−</span>
              </button>
            </li>
          ))}
        </ul>

        {times.length < MAX_TIMES ? (
          <button
            type="button"
            onClick={addTime}
            className="tap mt-2 flex h-[52px] w-full items-center justify-center rounded-xl border border-dashed border-ink-600 text-[15px] text-text-dim"
          >
            Add a time
          </button>
        ) : (
          <p className="mt-2.5 text-[13px] leading-snug text-text-dim">
            Eight times is the most one schedule holds — the cap the server enforces.
          </p>
        )}
      </Section>

      {/* -------------------------------------------------------- in words -- */}
      <div className="rounded-2xl border border-mauve/30 bg-mauve/[0.07] p-3.5">
        <p className="stencil mb-2">what this means</p>
        {complete ? (
          <>
            <p className="text-[17px] leading-snug tracking-[-0.01em] text-text">
              {formatTimesPhrase(validMinutes)}, {formatDays(days)}.
            </p>
            <p className="mt-1.5 text-[13px] leading-snug text-text-dim">
              <span className="digits">{occurrences}</span>{' '}
              {occurrences === 1 ? 'notification' : 'notifications'} a week. It arrives whether or
              not anything was logged.
            </p>
          </>
        ) : (
          <p className="text-[15px] leading-snug text-text-dim">
            {days.length === 0
              ? 'Pick the days it should arrive on.'
              : 'Every row needs a time before this can be saved.'}
          </p>
        )}
      </div>
    </>
  )
}

/**
 * A sensible time for a new row: four hours after the last one, stepped past
 * anything already taken. The alternative — always seeding 09:00 — makes the
 * common second dose a duplicate the moment it is added.
 */
function nextTime(existing: (number | null)[]): string {
  const taken = new Set(existing.filter((m): m is number => m !== null))
  const last = [...taken].sort((a, b) => a - b).pop()
  let candidate = last === undefined ? 9 * 60 : (last + 4 * 60) % MINUTES_PER_DAY
  for (let step = 0; step < MINUTES_PER_DAY && taken.has(candidate); step += 1) {
    candidate = (candidate + 60) % MINUTES_PER_DAY
  }
  return minutesToTime(candidate)
}
