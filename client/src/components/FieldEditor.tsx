import {
  blankDraft,
  draftError,
  FIELD_KINDS,
  KIND_COPY,
  MAX_FIELDS,
  MAX_LABEL,
  MAX_OPTIONS,
  MAX_OPTION_LENGTH,
  MAX_UNIT,
  moveDraft,
  withKind,
  type FieldDraft,
} from '../lib/fields.ts'
import type { FieldKind } from '../types.ts'

/**
 * The field editor inside the tracker sheet.
 *
 * Fields are the *optional* half of a tracker, so the editor stays collapsed to
 * a single "Add a field" button until asked for. Everything the server would
 * reject is caught here and said in words under the field it belongs to —
 * a 400 arriving after Save is a worse way to learn that a Choice needs two
 * options.
 *
 * Reordering is buttons rather than drag: this gets used one-handed, and a drag
 * handle in a scrolling sheet fights the scroll.
 */
export function FieldEditor({
  drafts,
  onChange,
}: {
  drafts: FieldDraft[]
  onChange: (next: FieldDraft[]) => void
}) {
  const atLimit = drafts.length >= MAX_FIELDS

  const update = (index: number, next: FieldDraft) => {
    onChange(drafts.map((d, i) => (i === index ? next : d)))
  }

  return (
    <section aria-label="Fields">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="stencil">fields · optional</p>
        <p className="text-[12px] text-text-dim">
          {drafts.length}/{MAX_FIELDS}
        </p>
      </div>

      {drafts.length === 0 ? (
        <p className="mb-3 text-[13px] leading-snug text-text-dim">
          Captured after the tap, never before it. A tracker with no fields logs just as well.
        </p>
      ) : (
        <ul className="mb-3 flex flex-col gap-2.5">
          {drafts.map((draft, index) => (
            <li key={draft.key}>
              <FieldCard
                draft={draft}
                index={index}
                total={drafts.length}
                error={draftError(draft, drafts)}
                onChange={(next) => update(index, next)}
                onMove={(to) => onChange(moveDraft(drafts, index, to))}
                onRemove={() => onChange(drafts.filter((_, i) => i !== index))}
              />
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        disabled={atLimit}
        onClick={() => onChange([...drafts, blankDraft()])}
        className="tap flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-ink-600 bg-ink-700 text-[15px] text-text disabled:opacity-40"
      >
        <span aria-hidden className="text-[17px] leading-none text-periwinkle">
          +
        </span>
        {atLimit ? `${MAX_FIELDS} fields is the limit` : 'Add a field'}
      </button>
    </section>
  )
}

function FieldCard({
  draft,
  index,
  total,
  error,
  onChange,
  onMove,
  onRemove,
}: {
  draft: FieldDraft
  index: number
  total: number
  error: string | null
  onChange: (next: FieldDraft) => void
  onMove: (to: number) => void
  onRemove: () => void
}) {
  return (
    <div className="rounded-2xl border border-ink-600 bg-ink-850 p-3">
      <div className="flex items-center gap-2">
        <input
          aria-label={`Field ${index + 1} label`}
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
          label={`Move ${draft.label || 'field'} up`}
          disabled={index === 0}
          onClick={() => onMove(index - 1)}
          path="M12 18V6M6.5 11.5L12 6l5.5 5.5"
        />
        <IconButton
          label={`Move ${draft.label || 'field'} down`}
          disabled={index === total - 1}
          onClick={() => onMove(index + 1)}
          path="M12 6v12M6.5 12.5L12 18l5.5-5.5"
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
