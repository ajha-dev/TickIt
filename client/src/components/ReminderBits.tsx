import type { ReactNode } from 'react'

/**
 * The small controls the two reminder editors share.
 *
 * They live here rather than inside `ReminderEditor` because the schedule
 * editor is a separate file and needs the same card, the same 52px field height
 * and the same stencil label — a second, near-identical `Section` is how two
 * halves of one sheet start to drift apart.
 */

export function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-ink-600 bg-ink-700/45 p-3.5">
      <p className="stencil mb-3">{label}</p>
      {children}
    </div>
  )
}

export function NumberBox({
  label,
  value,
  onChange,
  max,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  max: number
}) {
  return (
    <label className="flex h-[52px] shrink-0 items-center gap-1.5 rounded-xl border border-ink-600 bg-ink-800 px-2.5 focus-within:border-periwinkle">
      <input
        aria-label={label}
        value={value}
        inputMode="numeric"
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, max))}
        className="digits w-[3.2ch] bg-transparent text-center text-[17px] outline-none"
      />
      <span className="stencil">{label === 'hours' ? 'h' : 'm'}</span>
    </label>
  )
}

export function TimeBox({
  label,
  ariaLabel,
  value,
  onChange,
}: {
  label: string
  ariaLabel: string
  value: string
  onChange: (next: string) => void
}) {
  // The label sits above rather than inside: a native time control renders
  // "10:00 PM" plus a picker glyph in the user's locale, and sharing one row
  // with a label clips it at 390px.
  return (
    <label className="min-w-0 flex-1">
      <span className="stencil mb-1.5 block">{label}</span>
      <span className="flex h-[52px] items-center rounded-xl border border-ink-600 bg-ink-800 px-3 focus-within:border-periwinkle">
        <input
          type="time"
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full min-w-0 bg-transparent text-[16px] tracking-[-0.01em] outline-none"
        />
      </span>
    </label>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="tap flex min-h-[44px] w-full items-center gap-3 text-left"
    >
      <span
        aria-hidden
        className={`flex h-[28px] w-[48px] shrink-0 items-center rounded-full border p-[3px] transition-colors ${
          checked ? 'justify-end border-mauve/60 bg-mauve/25' : 'justify-start border-ink-600 bg-ink-800'
        }`}
      >
        <span
          className={`block size-[20px] rounded-full ${checked ? 'bg-mauve' : 'bg-text-dim'}`}
        />
      </span>
      <span className="min-w-0 flex-1 text-[15px] leading-snug text-text-dim">{label}</span>
    </button>
  )
}
