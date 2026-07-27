import { useRef, useState } from 'react'

import { Sheet } from './Sheet.tsx'
import { hapticLog } from '../lib/haptics.ts'
import { formatClock } from '../lib/time.ts'
import type { Event, FieldDef, Tracker } from '../types.ts'

type Draft = Record<string, string | number | boolean>

/**
 * The capture sheet — one optional field, no buttons.
 *
 * It opens *after* the event exists. The tap already logged; this only adds
 * detail to something safely on the server, so there is nothing to confirm and
 * nothing to cancel.
 *
 * Committing is the selection itself. CHOICE and BOOL have a natural moment —
 * you tap a value, it saves, the sheet closes. NUMBER and TEXT do not, so the
 * keyboard's return key commits, and dismissing the sheet commits whatever was
 * typed rather than throwing it away. Nothing entered is ever silently lost,
 * and an empty dismissal simply leaves the event as logged.
 */
export function CaptureSheet({
  tracker,
  event,
  onSave,
  onClose,
}: {
  tracker: Tracker
  event: Event
  onSave: (values: Draft) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Draft>(() => ({ ...event.values }))
  // Guards against double-committing when a return key and the resulting
  // dismissal both fire.
  const done = useRef(false)

  const commit = (values: Draft) => {
    if (done.current) return
    done.current = true
    if (Object.keys(values).length > 0) {
      hapticLog()
      onSave(values)
    }
    onClose()
  }

  const field = tracker.fields[0]

  return (
    <Sheet
      open
      onClose={() => commit(draft)}
      eyebrow={`logged ${formatClock(event.startAt)} · saved`}
      title={tracker.name}
      body="Already logged. Add this if it's useful, or swipe away."
    >
      <div className="-mt-3 mb-2">
        {field ? (
          <FieldInput
            field={field}
            value={draft[field.id]}
            // A pick commits and closes immediately — the pick IS the button.
            onPick={(value) => commit(value === undefined ? {} : { [field.id]: value })}
            onType={(value) =>
              setDraft(value === undefined ? {} : { [field.id]: value })
            }
            onDone={() => commit(draft)}
          />
        ) : null}
      </div>
    </Sheet>
  )
}

function FieldInput({
  field,
  value,
  onPick,
  onType,
  onDone,
}: {
  field: FieldDef
  value: string | number | boolean | undefined
  onPick: (next: string | number | boolean | undefined) => void
  onType: (next: string | number | boolean | undefined) => void
  onDone: () => void
}) {
  return (
    <div>
      <p className="stencil mb-3">{field.label}</p>

      {field.kind === 'CHOICE' ? (
        <div role="radiogroup" aria-label={field.label} className="flex flex-wrap gap-2.5">
          {(field.options ?? []).map((option) => (
            <Chip
              key={option}
              label={option}
              selected={value === option}
              onSelect={() => onPick(option)}
            />
          ))}
        </div>
      ) : null}

      {field.kind === 'BOOL' ? (
        <div role="radiogroup" aria-label={field.label} className="flex gap-2.5">
          <Chip label="Yes" selected={value === true} onSelect={() => onPick(true)} />
          <Chip label="No" selected={value === false} onSelect={() => onPick(false)} />
        </div>
      ) : null}

      {field.kind === 'NUMBER' ? (
        <div className="flex items-center gap-3">
          <input
            autoFocus
            aria-label={field.label}
            inputMode="decimal"
            enterKeyHint="done"
            defaultValue={value === undefined ? '' : String(value)}
            onChange={(e) => {
              const raw = e.target.value.trim()
              if (raw === '') return onType(undefined)
              const parsed = Number(raw)
              // Keep the keystroke on screen even mid-typing ("1." or "-"),
              // but only ever hand a real number to the server.
              onType(Number.isFinite(parsed) ? parsed : undefined)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onDone()
            }}
            className="digits h-[60px] min-w-0 flex-1 rounded-2xl border border-ink-600 bg-ink-700 px-4 text-[24px] outline-none focus:border-periwinkle"
          />
          {field.unit ? (
            <span className="shrink-0 text-[15px] text-text-dim">{field.unit}</span>
          ) : null}
        </div>
      ) : null}

      {field.kind === 'TEXT' ? (
        <input
          autoFocus
          aria-label={field.label}
          defaultValue={value === undefined ? '' : String(value)}
          onChange={(e) => onType(e.target.value === '' ? undefined : e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onDone()
          }}
          enterKeyHint="done"
          autoCapitalize="sentences"
          maxLength={200}
          className="h-[60px] w-full rounded-2xl border border-ink-600 bg-ink-700 px-4 text-[17px] outline-none focus:border-periwinkle"
        />
      ) : null}
    </div>
  )
}

/** Full chroma on a small element only: a chip, tinted at 12%. */
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
