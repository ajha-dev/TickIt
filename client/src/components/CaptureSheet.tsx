import { useState } from 'react'

import { Sheet, SheetButton } from './Sheet.tsx'
import { formatClock } from '../lib/time.ts'
import type { Event, FieldDef, Tracker } from '../types.ts'

type Draft = Record<string, string | number | boolean>

/**
 * The capture sheet.
 *
 * It opens *after* the event exists. The tap already logged; this is a chance
 * to add detail to something that is safely on the server, and closing it
 * without touching anything is a completely normal outcome — the log stands.
 * Nothing here is required, nothing here can fail the log, and there is no
 * validation gate on the way out.
 */
export function CaptureSheet({
  tracker,
  event,
  saving,
  onSave,
  onClose,
}: {
  tracker: Tracker
  event: Event
  saving: boolean
  onSave: (values: Draft) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Draft>(() => ({ ...event.values }))

  const set = (fieldId: string, value: string | number | boolean | undefined) => {
    setDraft((current) => {
      const next = { ...current }
      if (value === undefined || value === '') delete next[fieldId]
      else next[fieldId] = value
      return next
    })
  }

  const touched = Object.keys(draft).length > 0

  return (
    <Sheet
      open
      onClose={onClose}
      eyebrow={`logged ${formatClock(event.startAt)} · saved`}
      title={tracker.name}
      body="Already recorded. Add anything worth keeping, or close this — nothing here is required."
    >
      <div className="-mt-3 mb-1 flex flex-col gap-4">
        {tracker.fields.map((field) => (
          <FieldInput
            key={field.id}
            field={field}
            value={draft[field.id]}
            onChange={(value) => set(field.id, value)}
          />
        ))}
      </div>

      <SheetButton tone="primary" onClick={() => onSave(draft)} disabled={!touched || saving}>
        {saving ? 'Saving…' : 'Save these'}
      </SheetButton>
      <SheetButton tone="quiet" onClick={onClose}>
        {touched ? 'Discard these' : 'Nothing to add'}
      </SheetButton>
    </Sheet>
  )
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldDef
  value: string | number | boolean | undefined
  onChange: (next: string | number | boolean | undefined) => void
}) {
  return (
    <div>
      <p className="stencil mb-2.5">{field.label}</p>

      {field.kind === 'CHOICE' ? (
        <div role="radiogroup" aria-label={field.label} className="flex flex-wrap gap-2">
          {(field.options ?? []).map((option) => (
            <Chip
              key={option}
              label={option}
              selected={value === option}
              // Tapping the selected option clears it: a mistaken tap must be
              // undoable without leaving the sheet.
              onSelect={() => onChange(value === option ? undefined : option)}
            />
          ))}
        </div>
      ) : null}

      {field.kind === 'BOOL' ? (
        <div role="radiogroup" aria-label={field.label} className="flex gap-2">
          <Chip
            label="Yes"
            selected={value === true}
            onSelect={() => onChange(value === true ? undefined : true)}
          />
          <Chip
            label="No"
            selected={value === false}
            onSelect={() => onChange(value === false ? undefined : false)}
          />
        </div>
      ) : null}

      {field.kind === 'NUMBER' ? (
        <div className="flex items-center gap-3">
          <input
            aria-label={field.label}
            inputMode="decimal"
            enterKeyHint="done"
            value={value === undefined ? '' : String(value)}
            onChange={(e) => {
              const raw = e.target.value.trim()
              if (raw === '') return onChange(undefined)
              const parsed = Number(raw)
              // Keep the keystroke on screen even mid-typing ("1." or "-"),
              // but only ever hand a real number to the server.
              onChange(Number.isFinite(parsed) ? parsed : undefined)
            }}
            className="digits h-[56px] min-w-0 flex-1 rounded-2xl border border-ink-600 bg-ink-700 px-4 text-[22px] outline-none focus:border-periwinkle"
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
          enterKeyHint="done"
          autoCapitalize="sentences"
          maxLength={200}
          className="h-[56px] w-full rounded-2xl border border-ink-600 bg-ink-700 px-4 text-[17px] outline-none focus:border-periwinkle"
        />
      ) : null}
    </div>
  )
}

/** Full chroma on a small element only: a 40px chip, tinted at 12%. */
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
      className={`tap h-[46px] rounded-full border px-4 text-[16px] ${
        selected ? 'border-mauve bg-mauve/12 text-text' : 'border-ink-600 bg-ink-700 text-text-dim'
      }`}
    >
      {label}
    </button>
  )
}
