import { TRACKER_COLOURS } from '../lib/colours.ts'

/**
 * The two controls every editing sheet needs. Both are sized for a thumb, not
 * a cursor: 60px fields, 44px colour targets.
 */

export function TextField({
  value,
  onChange,
  onSubmit,
  placeholder,
  autoFocus,
  maxLength = 64,
  ariaLabel,
}: {
  value: string
  onChange: (next: string) => void
  onSubmit?: () => void
  placeholder?: string
  autoFocus?: boolean
  maxLength?: number
  ariaLabel: string
}) {
  return (
    <input
      // The sheet exists to be typed into; the keyboard should already be up.
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onSubmit) onSubmit()
      }}
      placeholder={placeholder}
      enterKeyHint="done"
      autoCapitalize="sentences"
      autoCorrect="off"
      spellCheck={false}
      maxLength={maxLength}
      className="h-[60px] w-full rounded-2xl border border-ink-600 bg-ink-700 px-4 text-[18px] tracking-[-0.01em] outline-none placeholder:text-text-dim/60 focus:border-periwinkle"
    />
  )
}

/**
 * Colour is identity, so the swatches are the palette itself — full chroma, but
 * only 26px of it each. The selected one is ringed rather than filled larger,
 * which keeps the row from turning into a band of pastel.
 */
export function ColourPicker({
  value,
  onChange,
  label = 'Colour',
}: {
  value: string
  onChange: (next: string) => void
  label?: string
}) {
  return (
    <div>
      <p className="stencil mb-3">{label}</p>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
        {TRACKER_COLOURS.map((colour) => {
          const selected = colour.toLowerCase() === value.toLowerCase()
          return (
            <button
              key={colour}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={colour}
              onClick={() => onChange(colour)}
              className="tap flex size-11 items-center justify-center rounded-full border"
              style={{
                borderColor: selected ? colour : 'var(--ink-600)',
                background: selected
                  ? `color-mix(in oklab, ${colour} 12%, var(--ink-850))`
                  : 'transparent',
              }}
            >
              <span
                aria-hidden
                className="block rounded-full"
                style={{
                  background: colour,
                  width: selected ? 14 : 18,
                  height: selected ? 14 : 18,
                }}
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}
