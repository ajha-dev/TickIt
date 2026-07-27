import {
  blankDraft,
  draftError,
  FIELD_KINDS,
  KIND_COPY,
  MAX_LABEL,
  MAX_OPTIONS,
  MAX_OPTION_LENGTH,
  MAX_UNIT,
  withKind,
  type FieldDraft,
} from '../lib/fields.ts'
import type { FieldKind } from '../types.ts'

/**
 * The field editor inside the tracker sheet.
 *
 * A tracker gets at most ONE optional field. That cap is the design, not a
 * limitation: the field is answered in the half-second after a tap, and one
 * question is answerable in that window while three are a form. Everything the
 * server would reject is caught here and said in words — a 400 arriving after
 * Save is a worse way to learn that a Choice needs two options.
 */
export function FieldEditor({
  drafts,
  onChange,
}: {
  drafts: FieldDraft[]
  onChange: (next: FieldDraft[]) => void
}) {
  const draft = drafts[0]

  return (
    <section aria-label="Field">
      <p className="stencil mb-3">field · optional</p>

      {draft ? (
        <FieldCard
          draft={draft}
          error={draftError(draft, drafts)}
          onChange={(next) => onChange([next])}
          onRemove={() => onChange([])}
        />
      ) : (
        <>
          <p className="mb-3 text-[13px] leading-snug text-text-dim">
            One thing to note down, asked after the tap and never before it. A tracker with no
            field logs just as well.
          </p>
          <button
            type="button"
            onClick={() => onChange([blankDraft()])}
            className="tap flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-ink-600 bg-ink-700 text-[15px] text-text"
          >
            <span aria-hidden className="text-[17px] leading-none text-periwinkle">
              +
            </span>
            Add a field
          </button>
        </>
      )}
    </section>
  )
}

function FieldCard({
  draft,
  error,
  onChange,
  onRemove,
}: {
  draft: FieldDraft
  error: string | null
  onChange: (next: FieldDraft) => void
  onRemove: () => void
}) {
  return (
    <div className="rounded-2xl border border-ink-600 bg-ink-850 p-3">
      <div className="flex items-center gap-2">
        <input
          aria-label="Field label"
          value={draft.label}
          onChange={(e) => onChange({ ...draft, label: e.target.value })}
          placeholder="Side, Distance, Assisted…"
          maxLength={MAX_LABEL + 8}
          autoCapitalize="sentences"
          autoCorrect="off"
          spellCheck={false}
          className="h-11 min-w-0 flex-1 rounded-xl border border-ink-600 bg-ink-800 px-3 text-[16px] outline-none placeholder:text-text-dim/60 focus:border-periwinkle"
        />
        <IconButton
          label={`Remove ${draft.label || 'field'}`}
          onClick={onRemove}
          path="M7 7l10 10M17 7L7 17"
        />
      </div>

      <div role="radiogroup" aria-label="Field kind" className="mt-2.5 flex flex-wrap gap-1.5">
        {FIELD_KINDS.map((kind) => (
          <KindChip
            key={kind}
            kind={kind}
            selected={draft.kind === kind}
            onSelect={() => onChange(withKind(draft, kind))}
          />
        ))}
      </div>

      {draft.kind === 'CHOICE' ? (
        <OptionsEditor
          options={draft.options}
          onChange={(options) => onChange({ ...draft, options })}
        />
      ) : null}

      {draft.kind === 'NUMBER' ? (
        <input
          aria-label="Unit"
          value={draft.unit}
          onChange={(e) => onChange({ ...draft, unit: e.target.value })}
          placeholder="Unit — km, ml, °C"
          maxLength={MAX_UNIT + 4}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="mt-2.5 h-11 w-full rounded-xl border border-ink-600 bg-ink-800 px-3 text-[15px] outline-none placeholder:text-text-dim/60 focus:border-periwinkle"
        />
      ) : null}

      {draft.kind === 'BOOL' || draft.kind === 'TEXT' ? (
        <p className="mt-2.5 text-[12px] text-text-dim">{KIND_COPY[draft.kind].hint}</p>
      ) : null}

      {error ? <p className="mt-2.5 text-[12px] text-orchid">{error}</p> : null}
    </div>
  )
}

function OptionsEditor({
  options,
  onChange,
}: {
  options: string[]
  onChange: (next: string[]) => void
}) {
  return (
    <div className="mt-2.5 flex flex-col gap-1.5">
      {options.map((option, i) => (
        <div key={i} className="flex items-center gap-2">
          <span aria-hidden className="w-4 shrink-0 text-center text-[12px] text-text-dim">
            {i + 1}
          </span>
          <input
            aria-label={`Option ${i + 1}`}
            value={option}
            onChange={(e) => onChange(options.map((o, j) => (j === i ? e.target.value : o)))}
            placeholder={i === 0 ? 'Left' : i === 1 ? 'Right' : 'Option'}
            maxLength={MAX_OPTION_LENGTH + 4}
            autoCapitalize="sentences"
            autoCorrect="off"
            spellCheck={false}
            className="h-11 min-w-0 flex-1 rounded-xl border border-ink-600 bg-ink-800 px-3 text-[15px] outline-none placeholder:text-text-dim/60 focus:border-periwinkle"
          />
          <IconButton
            label={`Remove option ${i + 1}`}
            disabled={options.length <= 2}
            onClick={() => onChange(options.filter((_, j) => j !== i))}
            path="M7 7l10 10M17 7L7 17"
          />
        </div>
      ))}

      {options.length < MAX_OPTIONS ? (
        <button
          type="button"
          onClick={() => onChange([...options, ''])}
          className="tap mt-0.5 self-start rounded-lg px-1 py-1.5 text-[13px] text-periwinkle"
        >
          + Add option
        </button>
      ) : null}
    </div>
  )
}

function KindChip({
  kind,
  selected,
  onSelect,
}: {
  kind: FieldKind
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`tap h-9 rounded-full border px-3 text-[13px] ${
        selected
          ? 'border-mauve/60 bg-mauve/12 text-text'
          : 'border-ink-600 bg-ink-800 text-text-dim'
      }`}
    >
      {KIND_COPY[kind].label}
    </button>
  )
}

function IconButton({
  label,
  path,
  onClick,
  disabled,
}: {
  label: string
  path: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="tap flex size-11 shrink-0 items-center justify-center rounded-xl text-text-dim disabled:opacity-30"
    >
      <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden>
        <path d={path} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    </button>
  )
}
