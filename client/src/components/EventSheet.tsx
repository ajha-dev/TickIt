import { useMemo, useState } from 'react'

import { Sheet, SheetButton } from './Sheet.tsx'
import { safeColour } from '../lib/colours.ts'
import { formatDayHeading } from '../lib/days.ts'
import { formatClock, formatDuration } from '../lib/time.ts'
import type { Event, FieldDef, Tracker } from '../types.ts'

/* -------------------------------------------------- local ⇄ epoch bridge -- */

/**
 * The one place in the app where a *typed* time becomes a stored one.
 *
 * Everything in the database is UTC epoch milliseconds; everything a person
 * enters is their own wall clock. The bridge is deliberately the `Date`
 * constructor in both directions — `new Date(y, m, d, h, min)` means "this
 * wall-clock instant in the device's current zone" by definition, and the
 * `getFullYear`/`getHours` family means the same thing coming back. There is no
 * offset arithmetic here and there must never be: a hand-rolled `+ tzOffset`
 * is wrong twice a year, and one of those days is an overnight.
 *
 * This is not day arithmetic — every day boundary in TickIt lives in
 * `lib/days.ts` and nowhere else. This is parsing and formatting only.
 */
export interface LocalParts {
  /** `YYYY-MM-DD`, as `<input type="date">` speaks it. */
  date: string
  /** `HH:mm`, as `<input type="time">` speaks it. */
  time: string
}

const EMPTY_PARTS: LocalParts = { date: '', time: '' }

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

export function toLocalParts(ms: number | null): LocalParts {
  if (ms === null) return EMPTY_PARTS
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return EMPTY_PARTS
  return {
    date: `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

export function partsAreEmpty(parts: LocalParts): boolean {
  return parts.date === '' && parts.time === ''
}

/** `null` when the pair is incomplete or does not describe a real instant. */
export function fromLocalParts(parts: LocalParts): number | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts.date)
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(parts.time)
  if (!dateMatch || !timeMatch) return null

  const [year, month, day] = dateMatch.slice(1).map(Number) as [number, number, number]
  const [hour, minute] = timeMatch.slice(1).map(Number) as [number, number]
  if (hour > 23 || minute > 59) return null

  const d = new Date(year, month - 1, day, hour, minute, 0, 0)
  // The constructor happily rolls 31 February over into March. Round-tripping
  // the fields is how a rolled-over date is caught.
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null
  return d.getTime()
}

/**
 * The edited value for a timestamp, preserving the original to the millisecond
 * when nothing about the wall clock actually changed. Minutes are all a native
 * time input carries, so re-saving an untouched event would otherwise quietly
 * shave the seconds off every timestamp it ever touched.
 */
function resolve(parts: LocalParts, original: number | null): number | null {
  if (partsAreEmpty(parts)) return null
  const baseline = toLocalParts(original)
  if (original !== null && parts.date === baseline.date && parts.time === baseline.time) {
    return original
  }
  return fromLocalParts(parts)
}

/* ------------------------------------------------------------- the sheet -- */

export interface EventPatch {
  startAt?: number
  endAt?: number | null
  values?: Record<string, string | number | boolean>
  note?: string | null
}

interface EventSheetProps {
  event: Event
  /** Undefined when the tracker has since been deleted — the event outlives it
   *  on screen for exactly as long as it takes to read or remove it. */
  tracker: Tracker | undefined
  onSave: (patch: EventPatch) => void
  onDelete: () => void
  onClose: () => void
  saving: boolean
  /** An API error code, shown verbatim-ish rather than swallowed. */
  error: string | null
}

export function EventSheet({
  event,
  tracker,
  onSave,
  onDelete,
  onClose,
  saving,
  error,
}: EventSheetProps) {
  const name = tracker?.name ?? 'Deleted tracker'
  const colour = safeColour(tracker?.colour)
  const isSpan = event.type === 'INTERVAL'
  const running = isSpan && event.endAt === null
  const field: FieldDef | undefined = tracker?.fields?.[0]

  const [start, setStart] = useState<LocalParts>(() => toLocalParts(event.startAt))
  const [end, setEnd] = useState<LocalParts>(() => toLocalParts(event.endAt))
  const [note, setNote] = useState(event.note ?? '')
  // Seeded from the stored values so a value whose field has since been deleted
  // is echoed back untouched — the server accepts an unchanged orphan and
  // rejects a changed one, so rewriting history here would make the event
  // permanently uneditable (CONTRACT.md).
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => ({
    ...event.values,
  }))
  const [confirming, setConfirming] = useState(false)

  const nextStart = resolve(start, event.startAt)
  const nextEnd = isSpan ? resolve(end, event.endAt) : null

  const problem = useMemo(() => {
    if (partsAreEmpty(start)) return 'An event needs a start time.'
    if (nextStart === null) return 'That start date is not a real day.'
    if (isSpan && !partsAreEmpty(end)) {
      if (nextEnd === null) return 'That end date is not a real day.'
      // Caught here rather than at the server: a 400 arriving after a tap is a
      // worse way to learn this than a line of text that was already on screen.
      if (nextEnd < nextStart) return 'It cannot end before it starts.'
    }
    return null
  }, [start, end, nextStart, nextEnd, isSpan])

  const patch = useMemo((): EventPatch => {
    const out: EventPatch = {}
    if (nextStart !== null && nextStart !== event.startAt) out.startAt = nextStart
    // endAt is NEVER sent for an INSTANT: the server answers 400 NOT_AN_INTERVAL
    // rather than let a Moment turn into a Span behind its tracker's back.
    if (isSpan && nextEnd !== event.endAt) out.endAt = nextEnd
    const trimmed = note.trim()
    if (trimmed !== (event.note ?? '')) out.note = trimmed === '' ? null : trimmed
    if (!sameValues(values, event.values)) out.values = values
    return out
  }, [nextStart, nextEnd, note, values, event, isSpan])

  const dirty = Object.keys(patch).length > 0
  const duration =
    nextStart !== null && nextEnd !== null && nextEnd >= nextStart ? nextEnd - nextStart : null

  const wasEdited = event.updatedAt !== event.createdAt
  const when = `${formatDayHeading(event.startAt).toLowerCase()} at ${formatClock(event.startAt)}`

  if (confirming) {
    // Deliberately the *stored* times, not the ones half-typed into the form
    // above: the confirm has to describe the row that is about to disappear.
    const stored = isSpan && event.endAt !== null ? event.endAt - event.startAt : null

    return (
      <Sheet
        open
        onClose={() => setConfirming(false)}
        eyebrow="permanent"
        title={`Delete this ${name}?`}
        body={
          <>
            The {isSpan ? 'span' : 'moment'} logged{' '}
            <strong className="font-medium text-text">
              {formatDayHeading(event.startAt).toLowerCase()} at{' '}
              <span className="digits">{formatClock(event.startAt)}</span>
            </strong>
            {stored !== null ? `, ${formatDuration(stored)} long` : running ? ', still running' : ''}
            . It leaves the database outright — there is no undo and no export.
          </>
        }
      >
        <SheetButton tone="danger" onClick={onDelete}>
          Delete the {formatClock(event.startAt)} {name}
        </SheetButton>
        <SheetButton tone="quiet" onClick={() => setConfirming(false)}>
          Keep it
        </SheetButton>
      </Sheet>
    )
  }

  return (
    <Sheet
      open
      onClose={onClose}
      eyebrow={`${running ? 'running span' : isSpan ? 'span' : 'moment'} · logged ${when}${
        wasEdited ? ' · edited' : ''
      }`}
      title={name}
      body={
        tracker
          ? 'Times are your local clock. Correcting one marks the event as edited.'
          : 'This tracker has been deleted. The event can still be corrected or removed.'
      }
    >
      <div className="-mt-3 flex flex-col gap-4">
        <LocalTimeField
          label="Started"
          value={start}
          onChange={setStart}
          accent={colour}
        />

        {isSpan ? (
          <LocalTimeField
            label="Ended"
            value={end}
            onChange={setEnd}
            accent={colour}
            hint={
              partsAreEmpty(end)
                ? 'Empty — this span is still running.'
                : duration !== null
                  ? `Lasted ${formatDuration(duration)}.`
                  : undefined
            }
            onClear={partsAreEmpty(end) ? undefined : () => setEnd(EMPTY_PARTS)}
          />
        ) : null}

        {field ? (
          <ValueField
            field={field}
            value={values[field.id]}
            onChange={(next) =>
              setValues((current) => {
                const copy = { ...current }
                if (next === undefined) delete copy[field.id]
                else copy[field.id] = next
                return copy
              })
            }
          />
        ) : null}

        <div>
          <p className="stencil mb-2.5">Note</p>
          <input
            aria-label="Note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Anything worth remembering"
            enterKeyHint="done"
            maxLength={200}
            className="h-[60px] w-full rounded-2xl border border-ink-600 bg-ink-700 px-4 text-[17px] outline-none placeholder:text-text-dim/60 focus:border-periwinkle"
          />
        </div>

        {problem !== null || error !== null ? (
          <p role="alert" className="text-[15px] leading-snug text-ember">
            {problem ?? messageFor(error ?? '')}
          </p>
        ) : null}
      </div>

      <SheetButton
        tone="primary"
        onClick={() => onSave(patch)}
        disabled={saving || !dirty || problem !== null}
      >
        {saving ? 'Saving…' : dirty ? 'Save correction' : 'Nothing changed'}
      </SheetButton>
      <SheetButton tone="quiet" onClick={() => setConfirming(true)}>
        <span className="text-ember">Delete…</span>
      </SheetButton>
    </Sheet>
  )
}

function messageFor(code: string): string {
  switch (code) {
    case 'NOT_AN_INTERVAL':
      return 'A Moment cannot be given an end time.'
    case 'UNKNOWN_FIELD':
      return 'That field no longer exists on this tracker.'
    case 'BAD_FIELD_VALUE':
      return 'That value does not fit the field.'
    case 'NETWORK':
      return 'Could not reach the server. Nothing was changed.'
    default:
      return 'The server refused the change. Nothing was saved.'
  }
}

function sameValues(
  a: Record<string, string | number | boolean>,
  b: Record<string, string | number | boolean>,
): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((k) => Object.is(a[k], b[k]))
}

/* ------------------------------------------------------------- controls -- */

/**
 * A date and a clock, side by side, both native so the phone's own pickers do
 * the work. The pair is the unit — a date without a time means nothing here.
 */
function LocalTimeField({
  label,
  value,
  onChange,
  accent,
  hint,
  onClear,
}: {
  label: string
  value: LocalParts
  onChange: (next: LocalParts) => void
  accent: string
  hint?: string
  onClear?: () => void
}) {
  return (
    <div>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <p className="stencil" style={{ color: accent }}>
          {label}
        </p>
        {onClear ? (
          <button
            type="button"
            onClick={onClear}
            className="stencil tap text-text-dim underline-offset-4 active:text-text"
          >
            reopen span
          </button>
        ) : null}
      </div>

      <div className="flex gap-2.5">
        <input
          type="date"
          aria-label={`${label} date`}
          value={value.date}
          onChange={(e) => onChange({ ...value, date: e.target.value })}
          className="digits h-[60px] min-w-0 flex-[1.15] rounded-2xl border border-ink-600 bg-ink-700 px-3 text-[14px] outline-none focus:border-periwinkle"
        />
        <input
          type="time"
          aria-label={`${label} time`}
          value={value.time}
          onChange={(e) => onChange({ ...value, time: e.target.value })}
          // Wide enough for a 12-hour locale's "09:30 AM" plus its picker glyph:
          // a clipped time is exactly the field you cannot afford to misread.
          className="digits h-[60px] min-w-0 flex-1 rounded-2xl border border-ink-600 bg-ink-700 px-3 text-[14px] outline-none focus:border-periwinkle"
        />
      </div>

      {hint ? <p className="mt-2 text-[13px] leading-snug text-text-dim">{hint}</p> : null}
    </div>
  )
}

/**
 * The captured value, editable. Unlike the capture sheet nothing here commits
 * on selection — this is a correction being composed, so a second tap on the
 * chosen chip clears it again and Save is what lands it.
 */
function ValueField({
  field,
  value,
  onChange,
}: {
  field: FieldDef
  value: string | number | boolean | undefined
  onChange: (next: string | number | boolean | undefined) => void
}) {
  const toggle = (next: string | number | boolean) => onChange(value === next ? undefined : next)

  return (
    <div>
      <p className="stencil mb-2.5">{field.label}</p>

      {field.kind === 'CHOICE' ? (
        <div role="radiogroup" aria-label={field.label} className="flex flex-wrap gap-2.5">
          {(field.options ?? []).map((option) => (
            <Chip
              key={option}
              label={option}
              selected={value === option}
              onSelect={() => toggle(option)}
            />
          ))}
        </div>
      ) : null}

      {field.kind === 'BOOL' ? (
        <div role="radiogroup" aria-label={field.label} className="flex gap-2.5">
          <Chip label="Yes" selected={value === true} onSelect={() => toggle(true)} />
          <Chip label="No" selected={value === false} onSelect={() => toggle(false)} />
        </div>
      ) : null}

      {field.kind === 'NUMBER' ? (
        <div className="flex items-center gap-3">
          <input
            aria-label={field.label}
            inputMode="decimal"
            value={value === undefined ? '' : String(value)}
            onChange={(e) => {
              const raw = e.target.value.trim()
              if (raw === '') return onChange(undefined)
              const parsed = Number(raw)
              onChange(Number.isFinite(parsed) ? parsed : undefined)
            }}
            className="digits h-[60px] min-w-0 flex-1 rounded-2xl border border-ink-600 bg-ink-700 px-4 text-[20px] outline-none focus:border-periwinkle"
          />
          {field.unit ? (
            <span className="shrink-0 text-[15px] text-text-dim">{field.unit}</span>
          ) : null}
        </div>
      ) : null}

      {field.kind === 'TEXT' ? (
        <input
          aria-label={field.label}
          value={value === undefined ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          maxLength={200}
          className="h-[60px] w-full rounded-2xl border border-ink-600 bg-ink-700 px-4 text-[17px] outline-none focus:border-periwinkle"
        />
      ) : null}
    </div>
  )
}

function Chip({
  label,
  selected,
  onSelect,
}: {
  label: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`tap h-[54px] rounded-full border px-5 text-[17px] ${
        selected ? 'border-mauve bg-mauve/12 text-text' : 'border-ink-600 bg-ink-700 text-text'
      }`}
    >
      {label}
    </button>
  )
}
